import { Client } from "@notionhq/client";
import type {
  OperationalOutcome,
  OperationalOutcomeMarkerVerifier,
  OperationalOutcomeReceipt,
  OperationalOutcomeTarget,
  OperationalOutcomeWriter
} from "./operational-outcome-writer.js";
import { OperationalOutcomeWriteNotAppliedError } from "./operational-outcome-writer.js";
import {
  parseOperationalOutcomeSection,
  renderOperationalOutcomeMarkdown,
  type ParsedOperationalOutcomeSection,
  type RenderedOperationalOutcome
} from "./operational-outcome-markdown.js";

export const NOTION_OPERATIONAL_OUTCOME_API_VERSION = "2026-03-11";

export interface NotionOperationalOutcomeApi {
  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }): Promise<{
    content: string;
    truncated: boolean;
    unknownBlockIds: string[];
  }>;
  insertPageMarkdown(input: { pageId: string; content: string }): Promise<void>;
  updatePageMarkdown(input: {
    pageId: string;
    oldContent: string;
    newContent: string;
  }): Promise<void>;
}

export type NotionOperationalOutcomeWriterConfig = {
  token?: string;
  providerId?: string;
  api?: NotionOperationalOutcomeApi;
  markerVerifier?: OperationalOutcomeMarkerVerifier;
};

export class NotionOperationalOutcomeWriterError extends OperationalOutcomeWriteNotAppliedError {
  constructor(
    readonly code:
      | "notion-operational-outcome-target-invalid"
      | "notion-operational-outcome-provider-mismatch"
      | "notion-operational-outcome-markdown-incomplete"
      | "notion-operational-outcome-marker-untrusted"
      | "notion-operational-outcome-token-missing",
    message: string
  ) {
    super(message, false);
    this.name = "NotionOperationalOutcomeWriterError";
  }
}

/**
 * Writes exactly one Luma-owned Operational Outcome section to an existing
 * Notion page. It never exposes whole-page replacement: absent sections are
 * appended, and valid present sections are changed through an exact match.
 */
export function createNotionOperationalOutcomeWriter(
  config: NotionOperationalOutcomeWriterConfig
): OperationalOutcomeWriter {
  const providerId = config.providerId ?? "notion";
  const api = config.api ?? createNotionSdkOperationalOutcomeApi(config);

  const render = (input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): RenderedOperationalOutcome => {
    assertOwnedTarget(providerId, input.target);
    return renderOperationalOutcomeMarkdown({
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey
    });
  };

  const findExact = async (input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> => {
    const expected = render(input);
    const markdown = await readCompleteMarkdown(api, input.target.page.externalId);
    const parsed = await requireTrustedSection(
      markdown,
      input.target,
      config.markerVerifier,
      expected,
      // This reader is only called by Follow-up Execution after an attempted
      // provider write or from a durable prepared-output recovery. The random
      // operation token in that prepared aggregate prevents a user from
      // pre-seeding a future exact section.
      true
    );

    if (parsed.status === "none") {
      return null;
    }

    return ownedSectionContent(parsed.section) === expected.section
      ? receipt(input.target, "already-current", expected)
      : null;
  };

  return {
    providerId,
    async findWrittenOutcome(input) {
      return findExact(input);
    },
    async upsert(input) {
      const expected = render(input);
      const pageId = input.target.page.externalId;
      const markdown = await readCompleteMarkdown(api, pageId);
      const parsed = await requireTrustedSection(
        markdown,
        input.target,
        config.markerVerifier,
        expected,
        false
      );

      if (parsed.status === "none") {
        return writeWithPositiveRecovery({
          status: "inserted",
          ...input,
          expected,
          write: () =>
            api.insertPageMarkdown({
              pageId,
              // This exact delimiter is owned by Luma. Preserve every byte in
              // the original page, even when it already ends with newlines.
              content: `\n\n${expected.section}`
            }),
          findExact
        });
      }

      if (ownedSectionContent(parsed.section) === expected.section) {
        return receipt(input.target, "already-current", expected);
      }

      const replacement = replacementContent(parsed.section, expected.section);

      return writeWithPositiveRecovery({
        status: "replaced",
        ...input,
        expected,
        write: () =>
          api.updatePageMarkdown({
            pageId,
            oldContent: parsed.section,
            newContent: replacement
          }),
        findExact
      });
    }
  };
}

type AppliedWriteStatus = "inserted" | "replaced";

async function writeWithPositiveRecovery(input: {
  status: AppliedWriteStatus;
  target: OperationalOutcomeTarget;
  outcome: OperationalOutcome;
  idempotencyKey: string;
  expected: RenderedOperationalOutcome;
  write: () => Promise<void>;
  findExact: (input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }) => Promise<OperationalOutcomeReceipt | null>;
}): Promise<OperationalOutcomeReceipt> {
  try {
    await input.write();
    return receipt(input.target, input.status, input.expected);
  } catch (error) {
    // A rejected write response may still have applied. The only positive
    // recovery signal is an exact, complete reread of the expected section.
    const recovered = await input
      .findExact({
        target: input.target,
        outcome: input.outcome,
        idempotencyKey: input.idempotencyKey
      })
      .catch(() => null);

    if (recovered) {
      return { ...recovered, status: input.status };
    }

    throw error;
  }
}

function assertOwnedTarget(providerId: string, target: OperationalOutcomeTarget): void {
  if (target.providerId !== providerId || target.page.providerId !== providerId) {
    throw new NotionOperationalOutcomeWriterError(
      "notion-operational-outcome-provider-mismatch",
      `Notion Operational Outcome Writer ${providerId} does not own page ${target.page.externalId}`
    );
  }

  if (target.page.objectType !== "document") {
    throw new NotionOperationalOutcomeWriterError(
      "notion-operational-outcome-target-invalid",
      "Notion Operational Outcome Writer requires an existing document target"
    );
  }
}

async function readCompleteMarkdown(
  api: NotionOperationalOutcomeApi,
  pageId: string
): Promise<string> {
  const markdown = await api.retrievePageMarkdown({
    pageId,
    includeTranscript: false
  });

  if (!markdown.truncated && markdown.unknownBlockIds.length === 0) {
    return markdown.content;
  }

  throw new NotionOperationalOutcomeWriterError(
    "notion-operational-outcome-markdown-incomplete",
    `Notion page ${pageId} returned incomplete Markdown; Luma cannot safely prove its Operational Outcome section`
  );
}

async function requireTrustedSection(
  markdown: string,
  target: OperationalOutcomeTarget,
  markerVerifier: OperationalOutcomeMarkerVerifier | undefined,
  expected: RenderedOperationalOutcome,
  allowPreparedExactMatch: boolean
): Promise<Exclude<ParsedOperationalOutcomeSection, { status: "invalid" }>> {
  const parsed = parseOperationalOutcomeSection(markdown);

  if (parsed.status === "none") {
    return parsed;
  }

  if (parsed.status === "invalid") {
    throw new NotionOperationalOutcomeWriterError(
      "notion-operational-outcome-marker-untrusted",
      `Notion page ${target.page.externalId} has an untrusted Luma Operational Outcome section: ${parsed.message}`
    );
  }

  if (
    allowPreparedExactMatch &&
    ownedSectionContent(parsed.section) === expected.section
  ) {
    return parsed;
  }

  const owned = await markerVerifier
    ?.isOwned({
      workspaceId: target.workspaceId,
      providerId: target.providerId,
      pageExternalId: target.page.externalId,
      payloadDigest: parsed.payloadDigest,
      contentDigest: parsed.contentDigest,
      operationDigest: parsed.operationDigest
    })
    .catch(() => false);

  if (owned) {
    return parsed;
  }

  throw new NotionOperationalOutcomeWriterError(
    "notion-operational-outcome-marker-untrusted",
    `Notion page ${target.page.externalId} has an Operational Outcome section that is not durably owned by Luma`
  );
}

function ownedSectionContent(section: string): string {
  return section.startsWith("\n\n") ? section.slice(2) : section;
}

function replacementContent(previousSection: string, nextSection: string): string {
  return previousSection.startsWith("\n\n") ? `\n\n${nextSection}` : nextSection;
}

function receipt(
  target: OperationalOutcomeTarget,
  status: OperationalOutcomeReceipt["status"],
  rendered: RenderedOperationalOutcome
): OperationalOutcomeReceipt {
  return {
    externalReference: target.page,
    status,
    payloadDigest: rendered.payloadDigest,
    contentDigest: rendered.contentDigest,
    operationDigest: rendered.operationDigest
  };
}

function createNotionSdkOperationalOutcomeApi(
  config: NotionOperationalOutcomeWriterConfig
): NotionOperationalOutcomeApi {
  if (!config.token) {
    throw new NotionOperationalOutcomeWriterError(
      "notion-operational-outcome-token-missing",
      "NOTION_API_TOKEN is required for the Notion Operational Outcome Writer"
    );
  }

  return new NotionSdkOperationalOutcomeApi(
    new Client({
      auth: config.token,
      notionVersion: NOTION_OPERATIONAL_OUTCOME_API_VERSION
    })
  );
}

class NotionSdkOperationalOutcomeApi implements NotionOperationalOutcomeApi {
  constructor(private readonly client: Client) {}

  async retrievePageMarkdown(input: {
    pageId: string;
    includeTranscript: boolean;
  }): Promise<{ content: string; truncated: boolean; unknownBlockIds: string[] }> {
    const result = await this.client.pages.retrieveMarkdown({
      page_id: input.pageId,
      include_transcript: input.includeTranscript
    });

    return {
      content: result.markdown,
      truncated: result.truncated,
      unknownBlockIds: result.unknown_block_ids
    };
  }

  async insertPageMarkdown(input: { pageId: string; content: string }): Promise<void> {
    await this.client.pages.updateMarkdown({
      page_id: input.pageId,
      type: "insert_content",
      insert_content: {
        content: input.content,
        position: { type: "end" }
      }
    });
  }

  async updatePageMarkdown(input: {
    pageId: string;
    oldContent: string;
    newContent: string;
  }): Promise<void> {
    await this.client.pages.updateMarkdown({
      page_id: input.pageId,
      type: "update_content",
      update_content: {
        content_updates: [
          {
            old_str: input.oldContent,
            new_str: input.newContent
          }
        ],
        allow_deleting_content: false
      }
    });
  }
}
