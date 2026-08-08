import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ContextAnswerer,
  ContextAnswerRequest,
  ContextAnswerResult
} from "../../src/context-intelligence/context-answerer.js";
import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import type { ContextIntelligenceError } from "../../src/context-intelligence/context-intelligence.js";
import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "../../src/context-intelligence/conversation-evidence-source.js";
import type { ContextInquiry } from "../../src/context-intelligence/interface.js";
import {
  createObservedSourceLedger,
  type ObservedSourceKind,
  type ObservedSourceLedger,
  type RecordObservedSourceInput,
  type RawConversationSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";
const subject = {
  type: "conversation-thread" as const,
  providerId: "discord",
  conversationObjectId: "thread_product",
  anchorMessageId: "message_3"
};

class ProgrammableConversationEvidenceSource implements ConversationEvidenceSource {
  readonly captures: ContextInquiry["subject"][] = [];

  constructor(private snapshot: RawConversationSnapshot) {}

  setSnapshot(snapshot: RawConversationSnapshot): void {
    this.snapshot = snapshot;
  }

  capture(input: {
    workspaceId: string;
    subject: ContextInquiry["subject"];
  }): Promise<CapturedConversationEvidence> {
    this.captures.push(input.subject);

    return Promise.resolve({
      source: {
        providerId: input.subject.providerId,
        sourceKind: "conversation",
        sourceObjectId: input.subject.anchorMessageId,
        parentObjectId: input.subject.conversationObjectId,
        url: "https://discord.com/channels/guild_dayova/thread_product/message_3"
      },
      providerVersion: null,
      snapshot: this.snapshot,
      observedAt: "2026-08-08T09:00:00.000Z"
    });
  }
}

class ProgrammableContextAnswerer implements ContextAnswerer {
  readonly requests: ContextAnswerRequest[] = [];

  constructor(
    private readonly result: (request: ContextAnswerRequest) => ContextAnswerResult
  ) {}

  answer(input: ContextAnswerRequest): Promise<ContextAnswerResult> {
    this.requests.push(input);
    return Promise.resolve(this.result(input));
  }
}

describe("Context Intelligence Ask", () => {
  it("reports invalid inquiries through its Promise contract", async () => {
    const database = await createPgliteDatabase();

    try {
      const contextIntelligence = createContextIntelligence({
        database,
        ledger: createObservedSourceLedger({ database }),
        conversationEvidenceSource: new ProgrammableConversationEvidenceSource(
          conversationSnapshot()
        ),
        answerer: answererForFirstCapturedMessage()
      });

      const pending = contextIntelligence.inquire({
        ...contextInquiry(),
        question: " "
      });

      await expect(pending).rejects.toMatchObject({
        code: "context-inquiry-invalid",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
    } finally {
      await database.close();
    }
  });

  it("captures one immutable Discord thread revision, answers only from ordered evidence, and replays its first result", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = new ProgrammableContextAnswerer((request) => {
        const first = request.evidence[0];
        const second = request.evidence[1];

        if (!first || !second) {
          throw new Error("expected captured thread evidence");
        }

        return {
          answer: {
            text: "Fabius said the release might move after the checklist is ready.",
            evidenceIds: [first.evidenceId, second.evidenceId]
          },
          facts: [
            {
              text: "The release checklist is still open.",
              evidenceIds: [first.evidenceId]
            }
          ],
          inferences: [
            {
              text: "A release delay is possible, not confirmed.",
              evidenceIds: [first.evidenceId, second.evidenceId],
              confidence: "medium"
            }
          ],
          unresolved: ["No final release date was recorded."],
          metadata: {
            provider: "test",
            model: "programmable",
            promptVersion: request.promptVersion
          }
        };
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer,
        now: () => new Date("2026-08-08T09:01:00.000Z")
      });
      const inquiry = contextInquiry();

      const first = await contextIntelligence.inquire(inquiry);
      const replay = await contextIntelligence.inquire(inquiry);

      expect(replay).toEqual(first);
      expect(source.captures).toEqual([subject]);
      expect(answerer.requests).toHaveLength(1);
      expect(answerer.requests[0]).toMatchObject({
        workspaceId,
        inquiryId: inquiry.inquiryId,
        question: inquiry.question,
        source: {
          providerId: "discord",
          conversationObjectId: "thread_product",
          anchorMessageId: "message_3",
          snapshotRevision: 1,
          boundary: {
            mode: "thread",
            messageIds: ["message_1", "message_2", "message_3"]
          }
        },
        evidence: [
          {
            messageId: "message_1",
            ordinal: 0,
            text: "Die Release-Checkliste ist noch offen.",
            author: { providerUserId: "779381502311137301", displayName: "Jakob" }
          },
          {
            messageId: "message_2",
            ordinal: 1,
            text: "The release might move after that is ready.",
            replyToMessageId: "message_1"
          },
          {
            messageId: "message_3",
            ordinal: 2,
            text: "@Luma what is the release status?"
          }
        ]
      });
      expect(first).toMatchObject({
        type: "answer",
        boundary: {
          mode: "thread",
          sourceRevision: 1,
          completeness: "complete"
        },
        uncertainty: "partial",
        facts: [
          {
            text: "The release checklist is still open.",
            evidence: [{ messageId: "message_1" }]
          }
        ],
        inferences: [
          {
            text: "A release delay is possible, not confirmed.",
            confidence: "medium",
            evidence: [{ messageId: "message_1" }, { messageId: "message_2" }]
          }
        ]
      });
      const stored = await ledger.get({
        workspaceId,
        source: {
          providerId: "discord",
          sourceKind: "conversation",
          sourceObjectId: "message_3"
        }
      });
      expect(stored?.revision).toBe(1);
      expect(
        stored?.snapshot.messages.map((message) => ({
          id: message.id,
          text: message.text
        }))
      ).toEqual([
        { id: "message_1", text: "Die Release-Checkliste ist noch offen." },
        { id: "message_2", text: "The release might move after that is ready." },
        { id: "message_3", text: "@Luma what is the release status?" }
      ]);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM meetings
            WHERE workspace_id = $1`,
          [workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM follow_up_executions
            WHERE workspace_id = $1`,
          [workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.close();
    }
  });

  it("isolates the caller and Answerer from the canonical inquiry evidence", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source: ConversationEvidenceSource = {
        capture(input): Promise<CapturedConversationEvidence> {
          input.subject.conversationObjectId = "thread_untrusted";
          input.subject.anchorMessageId = "message_untrusted";

          return Promise.resolve({
            source: {
              providerId: "discord",
              sourceKind: "conversation",
              sourceObjectId: "message_3",
              parentObjectId: "thread_product",
              url: "https://discord.com/channels/guild_dayova/thread_product/message_3"
            },
            providerVersion: null,
            snapshot: conversationSnapshot(),
            observedAt: "2026-08-08T09:00:00.000Z"
          });
        }
      };
      const answerer = new ProgrammableContextAnswerer((request) => {
        const firstEvidence = request.evidence[0];

        if (!firstEvidence) {
          throw new Error("expected detached captured evidence");
        }

        firstEvidence.text = "fabricated provider text";
        firstEvidence.author.displayName = "Fabricated person";
        request.source.boundary.messageIds[0] = "fabricated-message";

        return {
          answer: {
            text: "The checklist remains open.",
            evidenceIds: [firstEvidence.evidenceId]
          },
          facts: [],
          inferences: [],
          unresolved: [],
          metadata: {
            provider: "test",
            model: "programmable",
            promptVersion: request.promptVersion
          }
        };
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();

      const first = await contextIntelligence.inquire(inquiry);
      const replay = await contextIntelligence.inquire(inquiry);

      expect(inquiry.subject).toEqual(subject);
      expect(first.boundary.messageIds).toEqual(["message_1", "message_2", "message_3"]);
      expect(first.evidence[0]).toMatchObject({
        messageId: "message_1",
        text: "Die Release-Checkliste ist noch offen.",
        author: { displayName: "Jakob" }
      });
      expect(replay).toEqual(first);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("snapshots an inquiry before waiting for its idempotency lock", async () => {
    const database = await createPgliteDatabase();

    try {
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = answererForFirstCapturedMessage();
      const contextIntelligence = createContextIntelligence({
        database,
        ledger: createObservedSourceLedger({ database }),
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = {
        ...contextInquiry(),
        subject: { ...subject }
      };
      const pending = contextIntelligence.inquire(inquiry);

      inquiry.question = "What is the forged status?";
      inquiry.subject.conversationObjectId = "thread_untrusted";
      inquiry.subject.anchorMessageId = "message_untrusted";

      const result = await pending;

      expect(result.question).toBe("What is the release status?");
      expect(result.subject).toEqual(subject);
      expect(source.captures).toEqual([subject]);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("re-reads the immutable ledger revision before sending evidence to the Answerer", async () => {
    const database = await createPgliteDatabase();

    try {
      const durableLedger = createObservedSourceLedger({ database });
      const ledger = {
        ...durableLedger,
        async record<Input extends RecordObservedSourceInput<ObservedSourceKind>>(
          input: Input
        ) {
          const recorded = await durableLedger.record(input);

          if ("messages" in input.snapshot) {
            const firstMessage = input.snapshot.messages[0];

            if (firstMessage?.state === "available") {
              firstMessage.text = "fabricated source mutation after durable record";
            }
          }

          return recorded;
        }
      } satisfies ObservedSourceLedger;
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = answererForFirstCapturedMessage();
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      const result = await contextIntelligence.inquire(contextInquiry());

      expect(answerer.requests[0]?.evidence[0]).toMatchObject({
        text: "Die Release-Checkliste ist noch offen."
      });
      expect(result.evidence[0]).toMatchObject({
        text: "Die Release-Checkliste ist noch offen."
      });
    } finally {
      await database.close();
    }
  });

  it("does not ask the model or imply deleted history when the captured thread boundary is partial", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource({
        ...conversationSnapshot(),
        completeness: {
          state: "partial",
          reasons: [
            {
              code: "history-truncated",
              message: "The configured history cap was reached before the thread start."
            }
          ]
        }
      });
      const answerer = new ProgrammableContextAnswerer(() => {
        throw new Error("a partial boundary must never reach the answerer");
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      const result = await contextIntelligence.inquire(contextInquiry());

      expect(answerer.requests).toHaveLength(0);
      expect(result.uncertainty).toBe("insufficient-evidence");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        code: "conversation-boundary-incomplete"
      });
      expect(result.warnings[0]?.message).toContain("history cap");
      expect(result.unresolved).toEqual([
        "Capture a complete thread boundary before asking again."
      ]);
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          messageId: "message_2",
          state: "available",
          text: "The release might move after that is ready."
        })
      );
    } finally {
      await database.close();
    }
  });

  it("fails closed when a stored partial-boundary result is changed into a cited answer", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource({
        ...conversationSnapshot(),
        completeness: {
          state: "partial",
          reasons: [
            {
              code: "history-truncated",
              message: "The configured history cap was reached before the thread start."
            }
          ]
        }
      });
      const answerer = new ProgrammableContextAnswerer(() => {
        throw new Error("a partial boundary must never reach the answerer");
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();
      const first = await contextIntelligence.inquire(inquiry);
      const firstEvidence = first.evidence[0];

      if (!firstEvidence) {
        throw new Error("expected captured partial-boundary evidence");
      }

      await overwriteStoredContextInquiryResult(database, inquiry.inquiryId, {
        ...first,
        answer: {
          text: "Forged answer from incomplete context.",
          evidence: [firstEvidence]
        },
        uncertainty: "none",
        warnings: [],
        modelMetadata: {
          provider: "forged",
          model: "forged",
          promptVersion: "context-ask-v1"
        }
      });

      await expect(contextIntelligence.inquire(inquiry)).rejects.toMatchObject({
        code: "context-inquiry-corrupt",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      expect(source.captures).toHaveLength(1);
      expect(answerer.requests).toHaveLength(0);
    } finally {
      await database.close();
    }
  });

  it("retains explicit deletion evidence without letting it support an answer claim", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(
        conversationSnapshotWithDeletedMessage()
      );
      const answerer = new ProgrammableContextAnswerer((request) => {
        expect(request.evidence.map((evidence) => evidence.messageId)).toEqual([
          "message_1",
          "message_3"
        ]);
        const available = request.evidence[0];

        if (!available) {
          throw new Error("expected available evidence");
        }

        return {
          answer: {
            text: "The checklist is still open.",
            evidenceIds: [available.evidenceId]
          },
          facts: [],
          inferences: [],
          unresolved: ["The deleted reply cannot be used to determine the release date."],
          metadata: {
            provider: "test",
            model: "programmable",
            promptVersion: request.promptVersion
          }
        };
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      const result = await contextIntelligence.inquire(contextInquiry());

      expect(result.uncertainty).toBe("partial");
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          messageId: "message_2",
          state: "deleted",
          text: null
        })
      );
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "conversation-evidence-deleted" })
      );
      expect(result.answer.evidence).toEqual([
        expect.objectContaining({ messageId: "message_1", state: "available" })
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects a malicious Answerer attempt to cite an explicitly deleted message", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(
        conversationSnapshotWithDeletedMessage()
      );
      const answerer = new ProgrammableContextAnswerer((request) => ({
        answer: {
          text: "Invented deleted content",
          evidenceIds: ["conversation:discord:message_3:revision-1:message-message_2"]
        },
        facts: [],
        inferences: [],
        unresolved: [],
        metadata: {
          provider: "test",
          model: "programmable",
          promptVersion: request.promptVersion
        }
      }));
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      await expect(contextIntelligence.inquire(contextInquiry())).rejects.toMatchObject({
        code: "context-answer-invalid",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
    } finally {
      await database.close();
    }
  });

  it("rejects an Answerer citation that was not captured in the immutable thread", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = new ProgrammableContextAnswerer((request) => ({
        answer: { text: "Unsupported answer", evidenceIds: ["unknown-evidence"] },
        facts: [],
        inferences: [],
        unresolved: [],
        metadata: {
          provider: "test",
          model: "programmable",
          promptVersion: request.promptVersion
        }
      }));
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      await expect(contextIntelligence.inquire(contextInquiry())).rejects.toMatchObject({
        code: "context-answer-invalid",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM context_inquiries WHERE workspace_id = $1`,
          [workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.close();
    }
  });

  it("rejects malformed Answerer metadata before persisting a non-replayable result", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = new ProgrammableContextAnswerer((request) => ({
        answer: {
          text: "The checklist is open.",
          evidenceIds: [request.evidence[0]?.evidenceId ?? ""]
        },
        facts: [],
        inferences: [],
        unresolved: [],
        metadata: {
          provider: "",
          model: "programmable",
          promptVersion: request.promptVersion
        }
      }));
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });

      await expect(contextIntelligence.inquire(contextInquiry())).rejects.toMatchObject({
        code: "context-answer-invalid",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM context_inquiries WHERE workspace_id = $1`,
          [workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.close();
    }
  });

  it("rejects reuse of an inquiry ID for a different question instead of silently replaying it", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = new ProgrammableContextAnswerer((request) => ({
        answer: {
          text: "The checklist is open.",
          evidenceIds: [request.evidence[0]?.evidenceId ?? ""]
        },
        facts: [],
        inferences: [],
        unresolved: [],
        metadata: {
          provider: "test",
          model: "programmable",
          promptVersion: request.promptVersion
        }
      }));
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();

      await contextIntelligence.inquire(inquiry);
      await expect(
        contextIntelligence.inquire({ ...inquiry, question: "What is the decision?" })
      ).rejects.toMatchObject({
        code: "context-inquiry-id-conflict",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("replays the durable result after reopening without recapturing or re-answering", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "luma-context-intelligence-"));
    const dataDir = join(temporaryRoot, "pglite");
    let database: LumaDatabase | null = await createPgliteDatabase(dataDir);

    try {
      const initialLedger = createObservedSourceLedger({ database });
      const initialSource = new ProgrammableConversationEvidenceSource(
        conversationSnapshot()
      );
      const initialAnswerer = answererForFirstCapturedMessage();
      const inquiry = contextInquiry();
      const first = await createContextIntelligence({
        database,
        ledger: initialLedger,
        conversationEvidenceSource: initialSource,
        answerer: initialAnswerer
      }).inquire(inquiry);

      await database.close();
      database = null;
      database = await createPgliteDatabase(dataDir);
      const replaySource = new ProgrammableConversationEvidenceSource(
        conversationSnapshot()
      );
      const replayAnswerer = answererForFirstCapturedMessage();
      const replay = await createContextIntelligence({
        database,
        ledger: createObservedSourceLedger({ database }),
        conversationEvidenceSource: replaySource,
        answerer: replayAnswerer
      }).inquire(inquiry);

      expect(replay).toEqual(first);
      expect(replaySource.captures).toEqual([]);
      expect(replayAnswerer.requests).toEqual([]);
    } finally {
      if (database) {
        await database.close();
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails closed when a valid stored result names a different conversation", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = answererForFirstCapturedMessage();
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();

      const first = await contextIntelligence.inquire(inquiry);
      await overwriteStoredContextInquiryResultJson(
        database,
        inquiry.inquiryId,
        JSON.stringify(first).replaceAll("thread_product", "thread_tampered")
      );

      await expect(contextIntelligence.inquire(inquiry)).rejects.toMatchObject({
        code: "context-inquiry-corrupt",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      expect(source.captures).toHaveLength(1);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("fails closed when a stored inquiry no longer binds its immutable content hash", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = answererForFirstCapturedMessage();
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();

      await contextIntelligence.inquire(inquiry);
      await database.query(
        `UPDATE context_inquiries
            SET source_content_hash = $3
          WHERE workspace_id = $1 AND inquiry_id = $2`,
        [workspaceId, inquiry.inquiryId, "sha256:stored-hash-does-not-match"]
      );

      await expect(contextIntelligence.inquire(inquiry)).rejects.toMatchObject({
        code: "context-inquiry-corrupt",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      expect(source.captures).toHaveLength(1);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("fails closed when stored answer wording changes without its result digest", async () => {
    const database = await createPgliteDatabase();

    try {
      const ledger = createObservedSourceLedger({ database });
      const source = new ProgrammableConversationEvidenceSource(conversationSnapshot());
      const answerer = new ProgrammableContextAnswerer((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected captured evidence");
        }

        return {
          answer: {
            text: "The release might move after the checklist is ready.",
            evidenceIds: [evidence.evidenceId]
          },
          facts: [],
          inferences: [],
          unresolved: [],
          metadata: {
            provider: "test",
            model: "programmable",
            promptVersion: request.promptVersion
          }
        };
      });
      const contextIntelligence = createContextIntelligence({
        database,
        ledger,
        conversationEvidenceSource: source,
        answerer
      });
      const inquiry = contextInquiry();

      await contextIntelligence.inquire(inquiry);
      await database.query(
        `UPDATE context_inquiries
            SET result_json = REPLACE(result_json, $3, $4)
          WHERE workspace_id = $1 AND inquiry_id = $2`,
        [workspaceId, inquiry.inquiryId, "might", "will"]
      );

      await expect(contextIntelligence.inquire(inquiry)).rejects.toMatchObject({
        code: "context-inquiry-corrupt",
        retryable: false
      } satisfies Partial<ContextIntelligenceError>);
      expect(source.captures).toHaveLength(1);
      expect(answerer.requests).toHaveLength(1);
    } finally {
      await database.close();
    }
  });
});

async function overwriteStoredContextInquiryResult(
  database: LumaDatabase,
  inquiryId: string,
  result: unknown
): Promise<void> {
  await overwriteStoredContextInquiryResultJson(
    database,
    inquiryId,
    JSON.stringify(result)
  );
}

async function overwriteStoredContextInquiryResultJson(
  database: LumaDatabase,
  inquiryId: string,
  resultJson: string
): Promise<void> {
  await database.query(
    `UPDATE context_inquiries
        SET result_json = $3,
            result_content_hash = $4
      WHERE workspace_id = $1 AND inquiry_id = $2`,
    [workspaceId, inquiryId, resultJson, contextInquiryResultHash(resultJson)]
  );
}

function contextInquiryResultHash(resultJson: string): string {
  return `sha256:${createHash("sha256").update(resultJson).digest("hex")}`;
}

function answererForFirstCapturedMessage(): ProgrammableContextAnswerer {
  return new ProgrammableContextAnswerer((request) => ({
    answer: {
      text: "The checklist is open.",
      evidenceIds: [request.evidence[0]?.evidenceId ?? ""]
    },
    facts: [],
    inferences: [],
    unresolved: [],
    metadata: {
      provider: "test",
      model: "programmable",
      promptVersion: request.promptVersion
    }
  }));
}

function contextInquiry(): ContextInquiry {
  return {
    type: "ask",
    workspaceId,
    inquiryId: "discord-message_3-context-ask",
    question: "What is the release status?",
    subject
  };
}

function conversationSnapshot(): RawConversationSnapshot {
  return {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "thread_product",
      parentConversationObjectId: "channel_product",
      title: "Product delivery",
      url: "https://discord.com/channels/guild_dayova/thread_product"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "message_3",
      firstMessageId: "message_1",
      lastMessageId: "message_3",
      messageIds: ["message_1", "message_2", "message_3"]
    },
    messages: [
      {
        id: "message_1",
        ordinal: 0,
        author: {
          providerUserId: "779381502311137301",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: "2026-08-08T08:30:00.000Z",
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/guild_dayova/thread_product/message_1",
        state: "available",
        text: "Die Release-Checkliste ist noch offen."
      },
      {
        id: "message_2",
        ordinal: 1,
        author: {
          providerUserId: "803752301922418728",
          displayName: "Fabius",
          personId: "person_fabius"
        },
        createdAt: "2026-08-08T08:31:00.000Z",
        editedAt: "2026-08-08T08:31:30.000Z",
        replyToMessageId: "message_1",
        url: "https://discord.com/channels/guild_dayova/thread_product/message_2",
        state: "available",
        text: "The release might move after that is ready."
      },
      {
        id: "message_3",
        ordinal: 2,
        author: {
          providerUserId: "779381502311137301",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: "2026-08-08T08:32:00.000Z",
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/guild_dayova/thread_product/message_3",
        state: "available",
        text: "@Luma what is the release status?"
      }
    ],
    completeness: { state: "complete" }
  };
}

function conversationSnapshotWithDeletedMessage(): RawConversationSnapshot {
  const snapshot = conversationSnapshot();
  const first = snapshot.messages[0];
  const anchor = snapshot.messages[2];

  if (!first || !anchor) {
    throw new Error("expected deterministic conversation fixture");
  }

  return {
    ...snapshot,
    messages: [
      first,
      {
        id: "message_2",
        ordinal: 1,
        author: {
          providerUserId: "803752301922418728",
          displayName: "Fabius",
          personId: "person_fabius"
        },
        createdAt: "2026-08-08T08:31:00.000Z",
        editedAt: "2026-08-08T08:31:30.000Z",
        replyToMessageId: "message_1",
        url: "https://discord.com/channels/guild_dayova/thread_product/message_2",
        state: "deleted",
        text: null
      },
      anchor
    ]
  };
}
