import { createContextIntelligence } from "../src/context-intelligence/context-intelligence.js";
import type {
  ContextInquiry,
  ContextInquiryResult
} from "../src/context-intelligence/interface.js";
import type {
  ContextAnswerRequest,
  ContextAnswerResult
} from "../src/context-intelligence/context-answerer.js";
import { createOrganizationalContext } from "../src/organizational-context/organizational-context.js";
import type {
  ContextCatalog,
  ContextSource
} from "../src/organizational-context/interface.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../src/knowledge/observed-source-ledger.js";
import type { LumaDatabase } from "../src/persistence/db.js";
import { renderDiscordContextAskResult } from "../src/discord/discord-context-ask-runtime.js";
import {
  digest,
  type CatalogChange,
  type MeetingCorpus,
  type RetrievalFixture
} from "./corpus.js";
import { score, type CheckResult } from "./scorer.js";

function catalogSource(
  source: RetrievalFixture["sources"][number]["source"]
): ContextSource {
  const { effectiveAt, decisionKey, supersedes, ...required } = structuredClone(source);
  return {
    ...required,
    ...(effectiveAt ? { effectiveAt } : {}),
    ...(decisionKey ? { decisionKey } : {}),
    ...(supersedes ? { supersedes } : {})
  };
}

/** This adapter echoes only supplied evidence. It has no access to annotations. */
function echoSelectedEvidence(request: ContextAnswerRequest): ContextAnswerResult {
  const sources = request.organizationalEvidence ?? [];
  return {
    answer: {
      text: sources.length
        ? sources
            .map(
              (source) => `[${source.standing}; ${source.authority}] ${source.content}`
            )
            .join("\n")
        : "No organizational source was retrieved for this question.",
      evidenceIds: sources.length
        ? sources.map((source) => source.evidenceId)
        : request.evidence.map((source) => source.evidenceId)
    },
    facts: [],
    inferences: [],
    unresolved: sources.length ? [] : ["Organizational evidence is unavailable."],
    metadata: {
      provider: "synthetic",
      model: "selected-evidence-echo-v1",
      promptVersion: request.promptVersion
    }
  };
}

function project(result: ContextInquiryResult) {
  const evidence = result.organizationalContext?.evidence ?? [];
  return {
    status: "answered",
    answerText: result.answer.text,
    rendered: renderDiscordContextAskResult(result),
    selectedIds: evidence.map((source) => source.id),
    selectedContents: evidence.map((source) => source.content),
    standing: evidence.map((source) => source.standing),
    authority: evidence.map((source) => source.authority),
    duplicates: evidence
      .flatMap((source) =>
        source.duplicates.map((copy) => `${copy.catalogId}:${copy.sourceId}`)
      )
      .sort(),
    truncated: evidence.map((source) => source.excerptTruncated),
    receiptId: result.organizationalContext?.receiptId,
    coverage: result.organizationalContext?.coverage,
    uncertainty: result.uncertainty,
    warnings: result.warnings.map((warning) => warning.code),
    citedSourceIds: (result.answer.organizationalEvidence ?? []).map(
      (source) => source.id
    ),
    result
  };
}

export async function runRetrievalFixture(
  database: LumaDatabase,
  fixture: RetrievalFixture,
  corpus: MeetingCorpus
) {
  const workspaceId = `eval-retrieval:${fixture.id}`;
  const entries = new Map(
    fixture.sources.map((entry) => [
      `${entry.catalogId}:${entry.source.id}`,
      {
        source: catalogSource(entry.source),
        readableBy: [...entry.readableBy]
      }
    ])
  );
  const reads: Array<{ catalogId: string; operation: string; recipients: string[] }> = [];
  function change(input: CatalogChange) {
    if (!fixture.catalogs.some((catalog) => catalog.id === input.catalogId))
      throw new Error(`Unknown mutation catalog ${input.catalogId}`);
    if (input.type === "replace") {
      const key = `${input.catalogId}:${input.source.id}`;
      const existing = entries.get(key);
      entries.set(key, {
        source: catalogSource(input.source),
        readableBy: existing?.readableBy ?? [...fixture.recipients]
      });
      return;
    }
    const key = `${input.catalogId}:${input.sourceId}`;
    const entry = entries.get(key);
    if (!entry) throw new Error(`Unknown mutation source ${key}`);
    if (input.type === "delete") entries.delete(key);
    else
      entry.readableBy = entry.readableBy.filter(
        (personId) => personId !== input.personId
      );
  }
  const catalogs: ContextCatalog[] = fixture.catalogs.map((catalog) => ({
    id: catalog.id,
    search: ({ audience }) => {
      reads.push({
        catalogId: catalog.id,
        operation: "search",
        recipients: [...audience.personIds]
      });
      return Promise.resolve({
        sourceIds: [...entries.entries()]
          .filter(([key]) => key.startsWith(`${catalog.id}:`))
          .map(([, entry]) => entry.source.id),
        complete: catalog.complete,
        warnings: catalog.complete
          ? []
          : ["Synthetic external catalog reports incomplete search coverage."]
      });
    },
    read: ({ audience, sourceId }) => {
      reads.push({
        catalogId: catalog.id,
        operation: "read",
        recipients: [...audience.personIds]
      });
      const entry = entries.get(`${catalog.id}:${sourceId}`);
      return Promise.resolve(
        entry && audience.personIds.every((person) => entry.readableBy.includes(person))
          ? structuredClone(entry.source)
          : null
      );
    }
  }));
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Luma evaluation",
      url: "https://discord.com/channels/1/2"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "3",
      firstMessageId: "3",
      lastMessageId: "3",
      messageIds: ["3"]
    },
    messages: [
      {
        id: "3",
        ordinal: 0,
        author: {
          providerUserId: "779381502311137301",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: corpus.referenceAt,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: `@Luma ${fixture.question}`
      }
    ],
    completeness: { state: "complete" }
  };
  const requests: Array<{
    promptVersion: string;
    input: ContextAnswerRequest;
    inputCharacters: number;
    contextText: string;
    contextEntries: number;
  }> = [];
  let duringAnswer: CatalogChange | undefined;
  // Reconstruct both services for every operation. Only PGlite and true external
  // adapters survive, so replay proves durable receipts rather than an object cache.
  function context() {
    return createContextIntelligence({
      database,
      ledger: createObservedSourceLedger({ database }),
      organizationalContext: createOrganizationalContext({
        database,
        catalogs,
        now: () => new Date(corpus.referenceAt)
      }),
      organizationalContextLimits: fixture.limits,
      conversationEvidenceSource: {
        capture: () =>
          Promise.resolve({
            source: {
              providerId: "discord",
              sourceKind: "conversation",
              sourceObjectId: "3",
              parentObjectId: "2",
              url: "https://discord.com/channels/1/2/3"
            },
            providerVersion: null,
            snapshot: structuredClone(snapshot),
            observedAt: corpus.referenceAt
          })
      },
      answerer: {
        answer: (request) => {
          requests.push({
            promptVersion: request.promptVersion,
            input: structuredClone(request),
            inputCharacters: JSON.stringify(request).length,
            contextText: (request.organizationalEvidence ?? [])
              .map((source) => source.content)
              .join(""),
            contextEntries: request.organizationalEvidence?.length ?? 0
          });
          const answer = echoSelectedEvidence(request);
          if (duringAnswer) change(duringAnswer);
          return Promise.resolve(answer);
        }
      },
      now: () => new Date(corpus.referenceAt)
    });
  }
  const inquiries = new Map<string, ContextInquiry>();
  const outputs: Record<string, unknown> = {};
  for (const step of fixture.steps) {
    if (step.type === "change") {
      change(step.change);
      continue;
    }
    if (step.type === "retained-snapshots") {
      const retained = await database.query<{
        source_id: string;
        snapshot_id: string;
        source_json: string;
      }>(
        "SELECT source_id, snapshot_id, source_json FROM organizational_context_snapshots WHERE workspace_id = $1 ORDER BY catalog_id, source_id, snapshot_id",
        [workspaceId]
      );
      outputs[step.id] = retained.rows.map((row) => ({
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        contentHash: digest(row.source_json)
      }));
      continue;
    }
    let inquiry = inquiries.get(step.inquiryId);
    if (!inquiry) {
      if (step.type !== "inquire")
        throw new Error(`No inquiry exists for ${step.inquiryId}`);
      inquiry = {
        type: "ask",
        workspaceId,
        inquiryId: step.inquiryId,
        question: fixture.question,
        subject: {
          type: "conversation-thread",
          providerId: "discord",
          conversationObjectId: "2",
          anchorMessageId: "3"
        },
        audience: { workspaceId, personIds: [...fixture.recipients] },
        ...(step.time
          ? {
              contextTime:
                step.time.mode === "current"
                  ? { mode: "current" as const }
                  : {
                      mode: "history" as const,
                      ...(step.time.asOf ? { asOf: step.time.asOf } : {})
                    }
            }
          : {})
      };
      inquiries.set(step.inquiryId, inquiry);
    }
    duringAnswer = step.type === "inquire" ? step.duringAnswer : undefined;
    try {
      const intelligence = context();
      if (step.type === "inquire")
        outputs[step.id] = project(await intelligence.inquire(structuredClone(inquiry)));
      else {
        if (!intelligence.requireCurrent)
          throw new Error("Missing real delivery revalidation capability");
        await intelligence.requireCurrent(structuredClone(inquiry));
        outputs[step.id] = { status: "current" };
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        typeof error.code !== "string"
      )
        throw error;
      outputs[step.id] = { status: "blocked", code: error.code };
    }
    const saved = await database.query<{
      result_is_deliverable: boolean;
      context_receipt_id: string | null;
    }>(
      "SELECT result_is_deliverable, context_receipt_id FROM context_inquiries WHERE workspace_id = $1 AND inquiry_id = $2",
      [workspaceId, step.inquiryId]
    );
    outputs[`${step.id}Accounting`] = { modelCalls: requests.length, saved: saved.rows };
  }
  outputs["requests"] = requests;
  outputs["readAudiences"] = [
    ...new Set(reads.map((read) => [...read.recipients].sort().join(",")))
  ];
  const checks: CheckResult[] = [
    ...fixture.assertions.map((check) => score(check, outputs)),
    ...fixture.missing.map((entry) => ({
      id: entry.id,
      metric: entry.metric,
      status: "missing" as const,
      expected: entry.acceptance,
      actual: null,
      note: entry.reason
    }))
  ];
  return {
    id: fixture.id,
    surface: "ContextIntelligence.inquire + OrganizationalContext" as const,
    checks,
    outputs,
    coveredBy: [],
    configuration: {
      limits: fixture.limits,
      catalogIds: fixture.catalogs.map((catalog) => catalog.id),
      recipients: fixture.recipients
    },
    contextUse: {
      requests: requests.length,
      inputCharacters: requests.reduce(
        (sum, request) => sum + request.inputCharacters,
        0
      ),
      contextCharacters: requests.reduce(
        (sum, request) => sum + request.contextText.length,
        0
      ),
      contextEntries: requests.reduce((sum, request) => sum + request.contextEntries, 0)
    }
  };
}
