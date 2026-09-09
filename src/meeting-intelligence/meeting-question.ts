import type { EvidenceReference, MeetingState, Provenance } from "../domain/model.js";
import { actionItemOwnership } from "../domain/action-item-ownership.js";
import type { GroundedAnswer, MeetingQuery } from "./interface.js";

type QuestionScope = {
  kind: "decisions" | "history" | "questions" | "actions" | "personal-actions";
  topic: string;
};
type AnswerItem = {
  id: string;
  text: string;
  searchableText: string;
  provenance: Provenance;
  uncertain: boolean;
};

const MAX_ITEMS = 8;
const MAX_TEXT = 1600;
const MAX_EVIDENCE = 24;
const EMPTY_ANSWER = "I do not have enough evidence to answer that factually.";
const UNSUPPORTED =
  "I can answer scoped Meeting questions about current decisions, decision history, open questions, or Action Items. Try ‘What did we decide?’, ‘Show decision history’, ‘What questions are still open?’, ‘What are our action items?’ or ‘What are my action items?’. Ask one question at a time; broader interpretation is not supported here.";

/** Internal query policy. Retention and canonical state are never changed by selection. */
export function answerScopedMeetingQuestion(
  state: MeetingState,
  query: Extract<MeetingQuery, { type: "freeform" | "decision-history" }>,
  activeEvidence: readonly EvidenceReference[]
): GroundedAnswer {
  const scope =
    query.type === "decision-history"
      ? query.topic.length <= 200
        ? { kind: "history" as const, topic: normalize(query.topic) }
        : null
      : questionScope(query.text);
  if (!scope) return emptyAnswer(UNSUPPORTED);
  if (
    scope.kind === "personal-actions" &&
    (query.type !== "freeform" || !query.participantId)
  ) {
    return emptyAnswer(
      "I need a verified participant identity to answer a personal Action Item question."
    );
  }
  const items = meetingItems(
    state,
    scope,
    query.type === "freeform" ? query.participantId : undefined
  );
  const currentById = new Map(
    activeEvidence.map((evidence) => [evidence.evidenceId, evidence])
  );
  const protectedIds = new Set(state.humanJudgmentItemIds);
  const matching = items.filter(
    (item) => !scope.topic || normalize(item.searchableText).includes(scope.topic)
  );
  matching.sort(
    (left, right) =>
      Number(protectedIds.has(right.id)) - Number(protectedIds.has(left.id)) ||
      right.provenance.producedAtRevision - left.provenance.producedAtRevision ||
      left.id.localeCompare(right.id)
  );
  const selected: AnswerItem[] = [];
  const evidence = new Map<string, EvidenceReference>();
  const lines: string[] = [];
  // Leave room for an explicit omission notice; never cut a statement mid-sentence.
  const textBudget = MAX_TEXT - 200;
  for (const item of matching) {
    const references = item.provenance.evidence.flatMap((reference) => {
      const current = currentById.get(reference.evidenceId);
      return current ? [current] : [];
    });
    if (references.length === 0 || references.length !== item.provenance.evidence.length)
      continue;
    const addedIds = new Set(
      references
        .map((reference) => reference.evidenceId)
        .filter((id) => !evidence.has(id))
    );
    const qualification =
      item.provenance.confidence === "high"
        ? ""
        : ` [Recorded confidence: ${item.provenance.confidence}]`;
    const line = `- ${item.text}${qualification}`;
    if (
      selected.length >= MAX_ITEMS ||
      lines.join("\n").length + line.length + 1 > textBudget ||
      evidence.size + addedIds.size > MAX_EVIDENCE
    )
      continue;
    selected.push(item);
    lines.push(line);
    for (const reference of references) {
      // Return addressable Evidence, not another copy of retained source speech.
      const { excerpt: _excerpt, ...address } = reference;
      void _excerpt;
      evidence.set(reference.evidenceId, address);
    }
  }
  const omitted = matching.length - selected.length;
  if (omitted > 0)
    lines.push(
      `${omitted} matching item(s) omitted because of answer bounds or unavailable supporting Evidence. Narrow the topic or inspect the Meeting history.`
    );
  if (selected.length === 0) {
    return emptyAnswer(omitted > 0 ? lines.join("\n") : EMPTY_ANSWER);
  }
  return {
    text: lines.join("\n"),
    evidence: [...evidence.values()],
    uncertainty:
      omitted > 0 ||
      selected.some((item) => item.uncertain || item.provenance.confidence !== "high")
        ? "partial"
        : "none"
  };
}

function emptyAnswer(text: string): GroundedAnswer {
  return { text, evidence: [], uncertainty: "insufficient-evidence" };
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function questionScope(text: string): QuestionScope | null {
  if (text.length > 512) return null;
  const question = normalize(text).replace(/[?!.]+$/u, "");
  // Closed grammar: unknown qualifiers or multiple requests are never discarded.
  const forms: Array<[QuestionScope["kind"], RegExp]> = [
    [
      "decisions",
      /^(?:what did we decide|what are (?:our|the) (?:current |confirmed )?decisions|(?:show|list) (?:our |the )?(?:current |confirmed )?decisions)(?: about (.+))?$/u
    ],
    [
      "decisions",
      /^(?:was haben wir entschieden|welche entscheidungen gelten(?: aktuell)?|(?:zeige|zeig) (?:die |unsere )?(?:aktuellen |bestätigten )?entscheidungen)(?: (?:zu|über) (.+))?$/u
    ],
    ["history", /^(?:show |list )?(?:the )?decision history(?: (?:about|for) (.+))?$/u],
    [
      "history",
      /^(?:zeige |zeig )?(?:die )?entscheidungshistorie(?: (?:zu|über) (.+))?$/u
    ],
    [
      "questions",
      /^(?:what questions (?:are|remain) (?:still )?open|(?:show|list) (?:the )?open questions)(?: about (.+))?$/u
    ],
    [
      "questions",
      /^(?:welche fragen sind (?:noch )?offen|(?:zeige|zeig) (?:die )?offenen fragen)(?: (?:zu|über) (.+))?$/u
    ],
    [
      "actions",
      /^(?:what are (?:our|the) (?:current |open )?(?:action items|tasks)|(?:show|list) (?:our|the) (?:current |open )?(?:action items|tasks))(?: about (.+))?$/u
    ],
    [
      "actions",
      /^(?:was sind unsere (?:offenen )?(?:aufgaben|action items)|(?:zeige|zeig) (?:unsere|die) (?:offenen )?(?:aufgaben|action items))(?: (?:zu|über) (.+))?$/u
    ],
    [
      "personal-actions",
      /^(?:what are my (?:current |open )?(?:action items|tasks)|what do i own|(?:show|list) my (?:current |open )?(?:action items|tasks))(?: about (.+))?$/u
    ],
    [
      "personal-actions",
      /^(?:was sind meine (?:offenen )?(?:aufgaben|action items)|(?:zeige|zeig) meine (?:offenen )?(?:aufgaben|action items))(?: (?:zu|über) (.+))?$/u
    ]
  ];
  for (const [kind, expression] of forms) {
    const match = expression.exec(question);
    if (!match) continue;
    const topic = match[1] ?? "";
    if (topic.length > 200 || /[?;\n]|\b(?:and|und|then|danach)\b/u.test(topic))
      return null;
    return { kind, topic };
  }
  return null;
}

function meetingItems(
  state: MeetingState,
  scope: QuestionScope,
  participantId: string | undefined
): AnswerItem[] {
  if (scope.kind === "decisions" || scope.kind === "history") {
    return state.decisions
      .filter(
        (decision) =>
          scope.kind === "history" ||
          (decision.status === "confirmed" && decision.supersededByDecisionId === null)
      )
      .map((decision) => ({
        id: decision.id,
        text: `Decision (${decision.status}): ${decision.statement}${scope.kind === "history" ? ` [${decision.id}${decision.supersedesDecisionId ? `; supersedes ${decision.supersedesDecisionId}` : ""}${decision.supersededByDecisionId ? `; superseded by ${decision.supersededByDecisionId}` : ""}]` : ""}`,
        searchableText: decision.statement,
        provenance: decision.provenance,
        uncertain: decision.status === "candidate"
      }));
  }
  if (scope.kind === "questions") {
    return state.openQuestions
      .filter((question) => question.status === "open")
      .map((question) => ({
        id: question.id,
        text: `Open question: ${question.question}`,
        searchableText: question.question,
        provenance: question.provenance,
        uncertain: true
      }));
  }
  return state.actionItems
    .filter((item) => {
      if (item.status === "completed" || item.status === "cancelled") return false;
      const ownership = actionItemOwnership(item);
      return (
        scope.kind !== "personal-actions" ||
        (ownership.status === "confirmed" && ownership.ownerPersonId === participantId)
      );
    })
    .map((item) => {
      const ownership = actionItemOwnership(item);
      const owner =
        ownership.status === "confirmed"
          ? `confirmed owner ${ownership.ownerPersonId}`
          : ownership.status === "proposed"
            ? `proposed owner ${ownership.proposedOwnerPersonId ?? "requires confirmation"}`
            : ownership.status === "intentionally-unassigned"
              ? "explicitly unassigned by Human Judgment"
              : "no confirmed owner";
      const due = item.dueDate
        ? `due ${item.dueDate} (${item.dueDateConfidence})`
        : "no confirmed deadline";
      return {
        id: item.id,
        text: `Action Item (${item.status}): ${item.description}; ${owner}; ${due}.`,
        searchableText: item.description,
        provenance: item.provenance,
        uncertain:
          item.status === "candidate" ||
          (item.dueDate !== null &&
            (item.dueDateConfidence === "ambiguous" ||
              item.dueDateConfidence === "unknown")) ||
          ownership.status === "proposed" ||
          ownership.status === "unresolved"
      };
    });
}
