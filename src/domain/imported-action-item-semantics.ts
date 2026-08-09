import type {
  ActionItemOwnershipAttribution,
  ImportedActionItemCandidate,
  ImportedImplementationReference,
  ImportedActionItemModality,
  UtteranceLanguage
} from "./model.js";

const NON_PERSON_OWNER_LEADS = new Set([
  "der",
  "die",
  "das",
  "dem",
  "den",
  "ein",
  "eine",
  "einem",
  "einen",
  "the",
  "this",
  "that",
  "these",
  "those",
  "review",
  "team"
]);

/**
 * These subjects identify a speaker or a group, but not a resolvable person.
 * Keep their exact wording for Human Judgment without sending them through
 * person reconciliation as though they were names.
 */
const AMBIGUOUS_OWNER_LEADS = new Set([
  "i",
  "we",
  "you",
  "he",
  "she",
  "it",
  "they",
  "ich",
  "wir",
  "du",
  "ihr",
  "er",
  "sie",
  "es"
]);

const NON_WORK_ITEM_IDENTIFIER_PREFIXES = new Set([
  "UTF",
  "SHA",
  "ISO",
  "HTTP",
  "GPT",
  "S3"
]);

/**
 * A first-person work verb is not necessarily an accepted commitment. Keep
 * refusals and contingent wording distinct so source import and transcript
 * interpretation apply the same German-first safety boundary.
 */
export function commitmentDispositionFor(
  text: string
): "affirmative" | "conditional" | "refused" {
  const normalized = text.trim();

  if (
    /\b(?:nicht|nie|niemals|keinesfalls|keinerlei|kein(?:e|en|em|er|es)?|not|never|no\s+ownership|cannot|can't|won't|wouldn't|don't|do\s+not|will\s+not)\b/iu.test(
      normalized
    )
  ) {
    return "refused";
  }

  return /\b(?:vielleicht|eventuell|möglicherweise|falls|wenn|sofern|bei\s+bedarf|im\s+notfall|nur\s+im|könnte|könnten|würde|würden|maybe|possibly|perhaps|if|unless|could|would|should|can|may|might)\b/iu.test(
    normalized
  )
    ? "conditional"
    : "affirmative";
}

/**
 * The acknowledgement branch has one unambiguous separator alternative: a
 * comma (with optional surrounding whitespace), whitespace, or neither.
 * Separating those cases prevents whitespace from being partitioned across
 * adjacent `\\s*` terms during a rejected match.
 */
const SELF_COMMITMENT =
  /\b(?:ich\s+(?:mache|übernehme|kümmere\s+mich|bearbeite)|(?:das\s+)?(?:mache|übernehme)\s+ich|ja(?:\s*,\s*|\s+)?(?:mache|übernehme)\s+ich)\b/iu;

/**
 * Provider-neutral, deterministic semantics derived from canonical source
 * wording. Both ingestion and Meeting Intelligence use these functions so a
 * public Observation cannot assert a more certain meaning than its Evidence.
 */
export function importedActionItemModalityFor(text: string): ImportedActionItemModality {
  const normalizedText = text.trim().toLocaleLowerCase("de-DE");

  if (text.trim().endsWith("?")) {
    return { kind: "question", sourceForm: null };
  }

  const commitmentDisposition = commitmentDispositionFor(text);

  if (commitmentDisposition === "refused") {
    return { kind: "unknown", sourceForm: null };
  }

  if (
    /\b(?:habe|haben|hat|hatte|erledigt|abgeschlossen|fertiggestellt|done|complete|completed)\b/iu.test(
      normalizedText
    )
  ) {
    return { kind: "completed-work", sourceForm: null };
  }

  const selfCommitment = text.match(SELF_COMMITMENT);

  if (selfCommitment) {
    return {
      kind: commitmentDisposition === "conditional" ? "proposal" : "commitment",
      sourceForm: selfCommitment[0]
    };
  }

  const namedCommitment = text.match(
    /^\s*[\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)?\s+(?:macht|übernimmt|bearbeitet|kümmert\s+sich)\b/iu
  );

  if (namedCommitment) {
    return {
      kind: commitmentDisposition === "conditional" ? "proposal" : "commitment",
      sourceForm: namedCommitment[0].trim()
    };
  }

  const match = text.match(
    /\b(could|should|might|will|would|könnte|könnten|sollte|sollten|wird|werden|werde|vielleicht|eventuell)\b/i
  );
  const sourceForm = match?.[0] ?? null;
  const normalized = sourceForm?.toLocaleLowerCase("de-DE");

  if (
    normalized === "could" ||
    normalized === "should" ||
    normalized === "sollte" ||
    normalized === "sollten"
  ) {
    return { kind: "request", sourceForm };
  }

  if (
    normalized === "might" ||
    normalized === "would" ||
    normalized === "könnte" ||
    normalized === "könnten" ||
    normalized === "vielleicht" ||
    normalized === "eventuell"
  ) {
    return { kind: "proposal", sourceForm };
  }

  if (
    normalized === "will" ||
    normalized === "wird" ||
    normalized === "werden" ||
    normalized === "werde"
  ) {
    return {
      kind: commitmentDisposition === "conditional" ? "proposal" : "commitment",
      sourceForm
    };
  }

  return { kind: "unknown", sourceForm: null };
}

export function importedActionItemSourceOwnerFor(
  text: string
): ImportedActionItemCandidate["sourceOwner"] {
  const name = "[\\p{Lu}][\\p{L}'-]*(?:\\s+[\\p{Lu}][\\p{L}'-]*)?";
  const modal =
    "will|would|could|should|might|wird|werden|werde|könnte|könnten|sollte|sollten|macht|übernimmt|bearbeitet";
  const subjectFirst = new RegExp(`^(?<owner>${name})\\s+(?:${modal})\\b`, "u");
  const modalFirst = new RegExp(
    `^(?:[Cc]ould|[Ss]hould|[Mm]ight|[Ww]ill|[Ww]ould|[Ww]ird|[Ww]erden|[Ww]erde|[Kk]önnte|[Kk]önnten|[Ss]ollte|[Ss]ollten)\\s+(?<owner>${name})(?=\\s|[.,;:!?]|$)`,
    "u"
  );
  const owner =
    subjectFirst.exec(text)?.groups?.["owner"] ??
    modalFirst.exec(text)?.groups?.["owner"];
  const pronoun = text.match(
    /\b(?:ich|wir|du|ihr|er|sie|es|i|we|you|he|she|they)\b/iu
  )?.[0];
  const leadWord = owner?.split(/\s+/u)[0]?.toLocaleLowerCase("de-DE");

  if (owner && leadWord && AMBIGUOUS_OWNER_LEADS.has(leadWord)) {
    return { state: "ambiguous", sourceText: owner };
  }

  if (!owner && pronoun) {
    return { state: "ambiguous", sourceText: pronoun };
  }

  return owner && leadWord && !NON_PERSON_OWNER_LEADS.has(leadWord)
    ? { state: "unmapped", sourceText: owner }
    : { state: "unspecified", sourceText: null };
}

/**
 * A source name or pronoun is merely a candidate attribution. No imported
 * Meeting Note can produce confirmed or intentionally-unassigned ownership;
 * those states require explicit Human Judgment or a future provider-bound
 * identity proof.
 */
export function importedActionItemOwnershipFor(
  text: string
): ActionItemOwnershipAttribution {
  const sourceOwner = importedActionItemSourceOwnerFor(text);

  switch (sourceOwner.state) {
    case "unmapped":
      return {
        status: "proposed",
        proposedOwnerPersonId: null,
        confidence: "low",
        basis: "inferred-assignment"
      };
    case "ambiguous":
      return {
        status: "unresolved",
        reason: "missing-speaker",
        likelyOwnerPersonId: null
      };
    case "unspecified":
      return {
        status: "unresolved",
        reason: "no-owner-stated",
        likelyOwnerPersonId: null
      };
  }
}

export function importedActionItemCompletionFor(
  text: string,
  sourceCompletion: "open" | "completed"
): "open" | "completed" {
  return sourceCompletion === "completed" ||
    importedActionItemModalityFor(text).kind === "completed-work"
    ? "completed"
    : "open";
}

export function importedActionItemLanguageFor(text: string): UtteranceLanguage {
  const lower = text.toLocaleLowerCase("de-DE");
  const hasGerman =
    /\b(der|die|das|und|wird|werden|werde|könnte|könnten|sollte|sollten|vielleicht|eventuell|bis|ich|wir|du|ihr|er|sie|es)\b/.test(
      lower
    );
  const hasEnglish = /\b(the|will|could|should|might|by|review|finish|complete)\b/.test(
    lower
  );

  if (hasGerman && hasEnglish) {
    return "mixed";
  }

  if (hasGerman) {
    return "de";
  }

  if (hasEnglish) {
    return "en";
  }

  return "unknown";
}

export function mentionedWorkItemExternalIdsFor(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z]{2}[A-Z0-9]{0,14}-\d+\b/g) ?? [])]
    .filter((externalId) => {
      const prefix = externalId.slice(0, externalId.indexOf("-"));
      return !NON_WORK_ITEM_IDENTIFIER_PREFIXES.has(prefix);
    })
    .sort();
}

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>"'`[\]{}]+/giu;
const GITHUB_URL_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", ")", "}", "]"]);
const GITHUB_OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const GITHUB_REPOSITORY = "[A-Za-z0-9_.-]+";
const GITHUB_PULL_REQUEST_URL = new RegExp(
  `^https://github\\.com/(${GITHUB_OWNER})/(${GITHUB_REPOSITORY})/pull/([1-9]\\d*)$`,
  "u"
);
const GITHUB_COMMIT_URL = new RegExp(
  `^https://github\\.com/(${GITHUB_OWNER})/(${GITHUB_REPOSITORY})/commit/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$`,
  "u"
);

/**
 * Extracts only exact, canonical GitHub pull-request and full commit URLs
 * from source text. This intentionally performs no GitHub lookup, title/ID
 * search, branch inference, or implementation-status claim.
 */
export function mentionedGitHubImplementationReferencesFor(
  text: string,
  providerId = "github-code"
): ImportedImplementationReference[] {
  const normalizedProviderId = providerId.trim();

  if (normalizedProviderId.length === 0) {
    throw new Error("GitHub implementation reference provider ID must be non-empty");
  }

  const references = new Map<string, ImportedImplementationReference>();

  for (const match of text.matchAll(GITHUB_URL_CANDIDATE)) {
    const reference = githubImplementationReferenceFromUrl(
      trimSourceUrlPunctuation(match[0] ?? ""),
      normalizedProviderId
    );

    if (reference) {
      references.set(`${reference.objectType}:${reference.externalId}`, reference);
    }
  }

  return [...references.values()].sort(
    (left, right) =>
      compareBytewise(left.externalId, right.externalId) ||
      compareBytewise(left.objectType, right.objectType)
  );
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trimSourceUrlPunctuation(value: string): string {
  // A trailing question mark can encode an empty query and must therefore
  // remain part of the candidate. Failing closed is preferable to treating a
  // non-exact source URL as the canonical implementation locator.
  let end = value.length;

  while (end > 0 && GITHUB_URL_TRAILING_PUNCTUATION.has(value.charAt(end - 1))) {
    end -= 1;
  }

  return end === value.length ? value : value.slice(0, end);
}

function githubImplementationReferenceFromUrl(
  value: string,
  providerId: string
): ImportedImplementationReference | null {
  const pullRequest = value.match(GITHUB_PULL_REQUEST_URL);

  if (pullRequest) {
    const [, owner, repository, number] = pullRequest;

    if (!owner || !repository || !number) {
      return null;
    }

    return {
      providerId,
      objectType: "pull-request",
      externalId: `${owner}/${repository}#${number}`,
      url: `https://github.com/${owner}/${repository}/pull/${number}`
    };
  }

  const commit = value.match(GITHUB_COMMIT_URL);

  if (commit) {
    const [, owner, repository, sha] = commit;

    if (!owner || !repository || !sha) {
      return null;
    }

    const normalizedSha = sha.toLowerCase();

    return {
      providerId,
      objectType: "commit",
      externalId: `${owner}/${repository}@${normalizedSha}`,
      url: `https://github.com/${owner}/${repository}/commit/${normalizedSha}`
    };
  }

  return null;
}

/**
 * Derives deadline metadata from canonical source wording. Relative dates are
 * interpreted only from an offset-bearing source instant in the workspace
 * timezone; a host machine's timezone must never affect the result.
 */
export function importedActionItemDeadlineFor(
  text: string,
  timezone: string,
  referenceAt: string | null
): ImportedActionItemCandidate["deadline"] {
  const exactMatch = text.match(/\b(?:by|on|bis|am)\s+(\d{4}-\d{2}-\d{2})\b/iu);

  if (exactMatch?.[1]) {
    return {
      originalPhrase: exactMatch[0],
      normalizedDate: exactMatch[1],
      confidence: "exact",
      timezone
    };
  }

  const relativeMatch = text.match(
    /\b(by\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by\s+(?:tomorrow|next\s+week|end\s+of\s+day)|bis\s+(?:nächsten\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|bis\s+(?:morgen|nächste(?:n)?\s+woche)|am\s+(?:nächsten\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\b/iu
  );

  if (!relativeMatch) {
    return {
      originalPhrase: null,
      normalizedDate: null,
      confidence: "unknown",
      timezone
    };
  }

  const normalizedDate = referenceAt
    ? normalizeImportedActionItemRelativeDeadline(relativeMatch[0], referenceAt, timezone)
    : null;

  return {
    originalPhrase: relativeMatch[0],
    normalizedDate,
    confidence: normalizedDate ? "normalized" : "ambiguous",
    timezone
  };
}

/** Selects the canonical source instant used for relative-deadline parsing. */
export function importedActionItemDeadlineReferenceAt(
  calendarStartAt: string | null | undefined,
  capturedAt: string | null | undefined
): string | null {
  if (isOffsetBearingInstant(calendarStartAt)) {
    return calendarStartAt;
  }

  return isOffsetBearingInstant(capturedAt) ? capturedAt : null;
}

export function isOffsetBearingInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function normalizeImportedActionItemRelativeDeadline(
  phrase: string,
  referenceAt: string,
  timezone: string
): string | null {
  const normalizedPhrase = phrase.toLocaleLowerCase("de-DE");
  const referenceDate = localCalendarDate(referenceAt, timezone);

  if (/\b(tomorrow|morgen)\b/u.test(normalizedPhrase)) {
    return addCalendarDays(referenceDate, 1);
  }

  if (/next\s+week|nächste(?:n)?\s+woche/u.test(normalizedPhrase)) {
    // A week without a named weekday does not identify one calendar date.
    return null;
  }

  if (/end\s+of\s+day/u.test(normalizedPhrase)) {
    return formatCalendarDate(referenceDate);
  }

  const weekday = weekdayForDeadlinePhrase(normalizedPhrase);

  if (weekday === null) {
    return null;
  }

  const daysUntilWeekday = (weekday - referenceDate.weekday + 7) % 7;
  const explicitlyNextWeekday = /\b(?:by\s+next|bis\s+nächsten|am\s+nächsten)\b/u.test(
    normalizedPhrase
  );

  return addCalendarDays(
    referenceDate,
    daysUntilWeekday + (explicitlyNextWeekday ? 7 : 0)
  );
}

type LocalCalendarDate = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

function localCalendarDate(referenceAt: string, timezone: string): LocalCalendarDate {
  const instant = new Date(referenceAt);

  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      "Imported Action Item deadline reference time is not a valid ISO timestamp"
    );
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long"
  }).formatToParts(instant);
  const valueFor = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;

    if (!part) {
      throw new Error(`Could not determine ${type} in workspace timezone ${timezone}`);
    }

    return part;
  };
  const weekday = weekdayNumber(valueFor("weekday").toLocaleLowerCase("en-US"));

  if (weekday === null) {
    throw new Error(`Could not determine weekday in workspace timezone ${timezone}`);
  }

  return {
    year: Number(valueFor("year")),
    month: Number(valueFor("month")),
    day: Number(valueFor("day")),
    weekday
  };
}

function weekdayForDeadlinePhrase(phrase: string): number | null {
  const match = phrase.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/u
  );
  const weekday = match?.[1];

  return weekday ? weekdayNumber(weekday.toLocaleLowerCase("de-DE")) : null;
}

function weekdayNumber(weekday: string): number | null {
  const weekdays: Record<string, number> = {
    monday: 1,
    montag: 1,
    tuesday: 2,
    dienstag: 2,
    wednesday: 3,
    mittwoch: 3,
    thursday: 4,
    donnerstag: 4,
    friday: 5,
    freitag: 5,
    saturday: 6,
    samstag: 6,
    sunday: 7,
    sonntag: 7
  };

  return weekdays[weekday] ?? null;
}

function addCalendarDays(date: LocalCalendarDate, days: number): string {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return result.toISOString().slice(0, 10);
}

function formatCalendarDate(date: LocalCalendarDate): string {
  return [
    date.year,
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0")
  ].join("-");
}
