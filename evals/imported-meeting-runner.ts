import { createContextIntelligence } from "../src/context-intelligence/context-intelligence.js";
import type { ContextAnswerRequest } from "../src/context-intelligence/context-answerer.js";
import type { ContextInquiry } from "../src/context-intelligence/interface.js";
import type { RawConversationSnapshot } from "../src/knowledge/observed-source-ledger.js";
import type { LumaDatabase } from "../src/persistence/db.js";
import { importedMeetingFixture } from "./imported-meeting-fixture.js";
import { digest, type ImportedMeetingFixture, type MeetingCorpus } from "./corpus.js";
import { score } from "./scorer.js";

export async function runImportedMeetingFixture(
  database: LumaDatabase,
  fixture: ImportedMeetingFixture,
  corpus: MeetingCorpus
) {
  const f = importedMeetingFixture(database, `eval-meeting-recall:${fixture.id}`);
  f.compose([
    {
      id: "synthetic-external-guide",
      search: () =>
        Promise.resolve({ sourceIds: ["guide"], complete: true, warnings: [] }),
      read: () =>
        Promise.resolve({
          id: "guide",
          kind: "knowledge-document",
          title: "Luma guide",
          content:
            "Luma responsibilities stay provisional until explicit owner decisions.",
          version: "1",
          updatedAt: "2026-08-01T09:00:00.000Z",
          externalReference: {
            providerId: "synthetic-notion",
            objectType: "document",
            externalId: "guide",
            url: "https://example.invalid/guide"
          },
          standing: "current",
          authority: "source"
        })
    }
  ]);
  const firstMeeting = await f.ingest(
    "ownership",
    fixture.statement,
    "2026-08-01T10:00:00.000Z"
  );
  if (fixture.confirm)
    await f.judge(firstMeeting.observation, {
      kind: "confirm",
      meetingItemId: "decision:choice"
    });
  await f.ingest("unrelated", "Die Website-Farbpalette könnte grün werden.");
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Next discussion",
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
        author: { providerUserId: "1", displayName: "Jakob", personId: "jakob" },
        createdAt: corpus.referenceAt,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: fixture.question
      }
    ],
    completeness: { state: "complete" }
  };
  const requests: ContextAnswerRequest[] = [];
  const context = () =>
    createContextIntelligence({
      database,
      ledger: f.ledger,
      organizationalContext: f.organizationalContext(),
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
          requests.push(structuredClone(request));
          const sources = request.organizationalEvidence ?? [];
          return Promise.resolve({
            answer: {
              text: sources.length
                ? sources
                    .map(
                      (source) =>
                        `[${source.standing}; ${source.authority}] ${source.content}`
                    )
                    .join("\n")
                : "No organizational evidence.",
              evidenceIds: sources.length
                ? sources.map((source) => source.evidenceId)
                : request.evidence.map((source) => source.evidenceId)
            },
            facts: [],
            inferences: [],
            unresolved: [],
            metadata: {
              provider: "synthetic",
              model: "selected-evidence-echo-v1",
              promptVersion: request.promptVersion
            }
          });
        }
      },
      now: () => new Date(corpus.referenceAt)
    });
  const inquiry: ContextInquiry = {
    type: "ask",
    workspaceId: f.workspace.workspaceId,
    inquiryId: "recall",
    question: fixture.question,
    audience: f.audience,
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "2",
      anchorMessageId: "3"
    }
  };
  const first = await context().inquire(inquiry);
  const replay = await context().inquire(inquiry);
  const beforeReplayCalls = requests.length;
  const retained = async () =>
    digest(
      JSON.stringify(
        (
          await database.query(
            "SELECT source_json FROM organizational_context_snapshots WHERE workspace_id=$1 ORDER BY snapshot_id",
            [f.workspace.workspaceId]
          )
        ).rows
      )
    );
  const retainedBefore = await retained();
  if (fixture.revokeBeforeReplay) f.records.get("ownership")!.readers = [];
  let revokedReplay = "delivered";
  try {
    await context().inquire(inquiry);
  } catch (error) {
    revokedReplay =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unavailable";
  }
  let finalDelivery = "delivered";
  try {
    await context().requireCurrent!(inquiry);
  } catch {
    finalDelivery = "blocked";
  }
  const afterReplayCalls = requests.length;
  const fresh = await context().inquire({ ...inquiry, inquiryId: "fresh" });
  const outputs: Record<string, unknown> = {
    first: {
      text: first.answer.text,
      sources: (first.answer.organizationalEvidence ?? []).map((source) => ({
        kind: source.kind,
        content: source.content,
        authority: source.authority,
        standing: source.standing,
        url: source.externalReference.url
      }))
    },
    acceptedAnalysis: firstMeeting.result.analysisStatus,
    externalEvidenceUsed: f.requests[0]?.evidence.some((entry) =>
      entry.evidenceId.startsWith("organizational-context:")
    ),
    replayEqual: JSON.stringify(first) === JSON.stringify(replay),
    beforeReplayCalls,
    afterReplayCalls,
    revokedReplay,
    finalDelivery,
    freshSources: fresh.answer.organizationalEvidence?.length ?? 0,
    retainedBefore,
    retainedAfter: await retained(),
    requests: requests.map((request) => ({
      promptVersion: request.promptVersion,
      input: request
    })),
    analysisRequests: f.requests.map((request) => ({
      promptVersion: request.promptVersion,
      input: request
    }))
  };
  return {
    id: fixture.id,
    surface:
      "MI accepted import → original source grant → prior Meeting catalog → Context Ask",
    coveredBy: [],
    checks: fixture.assertions.map((check) => score(check, outputs)),
    outputs,
    contextUse: {
      requests: requests.length,
      inputCharacters: requests.reduce(
        (sum, request) => sum + JSON.stringify(request).length,
        0
      ),
      contextCharacters: requests.reduce(
        (sum, request) =>
          sum +
          (request.organizationalEvidence ?? []).reduce(
            (total, source) => total + source.content.length,
            0
          ),
        0
      ),
      contextEntries: requests.reduce(
        (sum, request) => sum + (request.organizationalEvidence?.length ?? 0),
        0
      )
    }
  };
}
