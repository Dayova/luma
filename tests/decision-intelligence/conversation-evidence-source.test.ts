import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import { createProcessedConversationSources } from "../../src/context-intelligence/processed-conversation-source.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import type { ContextInquiry } from "../../src/context-intelligence/interface.js";
import type { AutomaticDecisionDetector } from "../../src/decision-intelligence/ports.js";
import { decisionSourceSchema } from "../../src/domain/decision-record-schemas.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationDecisionEvidenceSource } from "../../src/decision-intelligence/conversation-evidence-source.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { captureFixture, subject, workspace } from "../consultation/harness.js";
import type { CapturedConversationEvidence } from "../../src/context-intelligence/conversation-evidence-source.js";
import type { DecisionEvidenceSource } from "../../src/decision-intelligence/ports.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});

function fixture() {
  const current = captureFixture();
  const anchor = current.snapshot.messages[0]!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text = "<@luma> record this decision";
  const statement = {
    ...structuredClone(anchor),
    id: "original-statement",
    ordinal: 0,
    text: "Wir könnten RevenueCat verwenden; das ist noch nicht final.",
    author: { ...anchor.author, personId: "person_fabius" }
  };
  anchor.ordinal = 1;
  current.snapshot.messages.unshift(statement);
  current.snapshot.boundary.firstMessageId = statement.id;
  current.snapshot.boundary.messageIds.unshift(statement.id);
  const directory = createLumaTeamIdentityDirectory();
  let ambiguous = false;
  let switched = false;
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    authorizedPersonIds: dayovaFounderPersonIds,
    identityDirectory: {
      ...directory,
      async findPeopleByProviderUserId(request) {
        const people = await directory.findPeopleByProviderUserId(request);
        if (!people.length) return people;
        if (ambiguous) return [...people, { ...people[0]!, personId: "person_fabius" }];
        return switched ? [{ ...people[0]!, personId: "person_fabius" }] : people;
      }
    }
  });
  const capture = vi.fn((): Promise<CapturedConversationEvidence> =>
    Promise.resolve(structuredClone(current))
  );
  const ledger = createObservedSourceLedger({ database });
  const processedSources = createProcessedConversationSources({ database, ledger });
  const source = createConversationDecisionEvidenceSource({
    processedSources,
    workspaceId: workspace.workspaceId,
    conversationEvidenceSource: { capture },
    ledger,
    accessPolicy,
    recipientPersonIds: dayovaFounderPersonIds
  });
  const request: Parameters<DecisionEvidenceSource["capture"]>[0] = {
    workspace,
    subject,
    instruction: "record this decision",
    actor: { providerId: "discord", providerUserId: "779381502311137301" },
    audience: {
      workspaceId: workspace.workspaceId,
      personIds: [...dayovaFounderPersonIds]
    }
  };
  return {
    source,
    ledger,
    accessPolicy,
    processedSources,
    current,
    capture,
    request,
    makeAmbiguous: () => {
      ambiguous = true;
    },
    switchIdentity: () => {
      switched = true;
    }
  };
}

describe("Bounded Conversation Decision Evidence", () => {
  it("retains exact source wording and immutable refs while resolving authors independently of raw person metadata", async () => {
    const f = fixture();
    const source = await f.source.capture(f.request);
    expect(source.evidence[0]).toMatchObject({
      text: "Wir könnten RevenueCat verwenden; das ist noch nicht final.",
      authorPersonId: "person_jakob",
      origin: "human",
      reference: {
        sourceObjectId: "original-statement",
        sourceVersion: "1",
        externalReference: { providerId: "discord" }
      }
    });
    expect(source.audience.personIds).toEqual([...dayovaFounderPersonIds].sort());
    const before = (await database.query("SELECT * FROM observed_source_snapshots")).rows;
    const heads = (await database.query("SELECT * FROM observed_sources")).rows;
    await f.source.requireCurrent(source);
    await f.source.requireCurrent(source);
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual(before);
    expect((await database.query("SELECT * FROM observed_sources")).rows).toEqual(heads);
    expect(await f.source.capture(f.request)).toEqual(source);
  });
  it("retains source proof through the owned wire schema without depending on object key insertion order", async () => {
    const f = fixture();
    const captured = await f.source.capture(f.request);
    const wire = decisionSourceSchema.parse(JSON.parse(JSON.stringify(captured)));
    await expect(f.source.requireCurrent(wire)).resolves.toBeUndefined();
  });
  it("rejects wrong actors, guests, an expanded audience and actual Meetings without retaining a substitute source", async () => {
    const f = fixture();
    for (const request of [
      {
        ...f.request,
        actor: { providerId: "discord", providerUserId: "726409024894926869" }
      },
      { ...f.request, actor: { providerId: "discord", providerUserId: "guest" } },
      {
        ...f.request,
        audience: {
          ...f.request.audience,
          personIds: [...dayovaFounderPersonIds, "guest"]
        }
      },
      { ...f.request, subject: { type: "meeting" as const, meetingId: "real-meeting" } }
    ])
      await expect(f.source.capture(request)).rejects.toThrow();
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual([]);
  });
  it.each(["partial", "boundary", "deleted", "duplicate", "wrong-source"])(
    "refuses a %s capture before it can support a decision",
    async (failure) => {
      const f = fixture();
      if (failure === "partial")
        f.current.snapshot.completeness = {
          state: "partial",
          reasons: [{ code: "history-truncated", message: "History omitted" }]
        };
      if (failure === "boundary")
        f.current.snapshot.boundary.messageIds = [subject.anchorMessageId];
      if (failure === "deleted")
        f.current.snapshot.messages[0] = {
          ...f.current.snapshot.messages[0]!,
          state: "deleted",
          text: null
        };
      if (failure === "duplicate")
        f.current.snapshot.messages[0]!.id = subject.anchorMessageId;
      if (failure === "wrong-source") f.current.source.parentObjectId = "another-thread";
      await expect(f.source.capture(f.request)).rejects.toThrow();
      expect(
        (await database.query("SELECT * FROM observed_source_snapshots")).rows
      ).toEqual([]);
    }
  );
  it.each([
    "wording",
    "identity",
    "ambiguous",
    "missing-original",
    "forged-evidence",
    "audience"
  ])("invalidates retained source proof after %s changes", async (change) => {
    const f = fixture();
    const source = await f.source.capture(f.request);
    if (change === "wording")
      f.current.snapshot.messages[0]!.text = "We have now decided something different.";
    if (change === "identity") f.switchIdentity();
    if (change === "ambiguous") f.makeAmbiguous();
    if (change === "missing-original") source.revision = "999";
    if (change === "forged-evidence")
      source.evidence[0]!.text = "Fabricated final decision";
    if (change === "audience") source.audience.personIds.push("guest");
    await expect(f.source.requireCurrent(source)).rejects.toThrow();
  });
  it("preserves advisory poll facts separately, permits result evolution, and rejects changed choices", async () => {
    const f = fixture();
    const message = f.current.snapshot.messages[0]!;
    if (message.state !== "available") throw new Error("fixture");
    message.author = { providerUserId: "luma", displayName: "Luma" };
    message.text = "Luma-generated advisory wording";
    message.poll = {
      question: "RevenueCat or Stripe?",
      options: [
        { id: "1", text: "RevenueCat", emoji: null },
        { id: "2", text: "Stripe", emoji: null }
      ],
      allowsMultiple: false,
      wordingOrigin: "luma-generated",
      closesAt: "2026-09-12T10:00:00.000Z",
      results: { status: "unknown", reason: "missing" }
    };
    const source = await f.source.capture(f.request);
    expect(source.evidence[0]).toMatchObject({
      origin: "provider-derived",
      authorPersonId: null
    });
    expect(source.evidence[1]).toMatchObject({ origin: "poll", authorPersonId: null });
    message.poll.results = {
      status: "finalized",
      counts: [
        { optionId: "1", votes: 1 },
        { optionId: "2", votes: 3 }
      ]
    };
    message.poll.closesAt = null;
    await expect(f.source.requireCurrent(source)).resolves.toBeUndefined();
    expect(source.evidence[1]!.text).toContain('"status":"unknown"');
    message.poll.options[0]!.text = "Changed choice";
    await expect(f.source.requireCurrent(source)).rejects.toThrow();
    await expect(
      f.source.authorizeRetained({ source, audience: source.audience })
    ).resolves.toBe(true);
    expect(source.evidence[1]!.text).toContain('"status":"unknown"');
    delete message.poll;
    await expect(
      f.source.authorizeRetained({ source, audience: source.audience })
    ).resolves.toBe(false);
  });
});

describe("Retained Conversation Decision source authorization", () => {
  it("admits retained wording after an edit for original recipients while exact execution proof rejects the changed source", async () => {
    const f = fixture();
    const original = await f.source.capture(f.request);
    const snapshots = (await database.query("SELECT * FROM observed_source_snapshots"))
      .rows;
    const heads = (await database.query("SELECT * FROM observed_sources")).rows;
    const edited = f.current.snapshot.messages[0]!;
    if (edited.state !== "available") throw new Error("fixture");
    edited.text = "RevenueCat ist jetzt der aktuelle Vorschlag.";
    edited.editedAt = "2026-09-11T12:00:00.000Z";
    edited.author.displayName = "A renamed founder";
    f.current.snapshot.conversation.title = "Updated discussion label";
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    await expect(
      f.source.authorizeRetained({ source: original, audience: original.audience })
    ).resolves.toBe(true);
    await expect(
      f.source.authorizeRetained({
        source: original,
        audience: { workspaceId: workspace.workspaceId, personIds: ["person_jakob"] }
      })
    ).resolves.toBe(true);
    expect(original.evidence[0]?.text).toBe(
      "Wir könnten RevenueCat verwenden; das ist noch nicht final."
    );
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual(snapshots);
    expect((await database.query("SELECT * FROM observed_sources")).rows).toEqual(heads);
  });
  it.each([
    "deleted-message",
    "erased-text",
    "excluded-message",
    "changed-author",
    "identity-remap",
    "ambiguous-identity",
    "revoked-grant",
    "changed-parent",
    "missing-original",
    "forged-history",
    "expanded-audience"
  ] as const)("withholds retained history after %s", async (scenario) => {
    const f = fixture();
    const original = await f.source.capture(f.request);
    const message = f.current.snapshot.messages[0]!;
    if (message.state !== "available") throw new Error("fixture");
    switch (scenario) {
      case "deleted-message":
        f.current.snapshot.messages[0] = { ...message, state: "deleted", text: null };
        break;
      case "erased-text":
        message.text = "";
        break;
      case "excluded-message":
        f.current.snapshot.messages.shift();
        f.current.snapshot.boundary.messageIds.shift();
        f.current.snapshot.boundary.firstMessageId = f.current.snapshot.messages[0]!.id;
        f.current.snapshot.messages.forEach((retained, index) => {
          retained.ordinal = index;
        });
        break;
      case "changed-author":
        message.author.providerUserId = "726409024894926869";
        break;
      case "identity-remap":
        f.switchIdentity();
        break;
      case "ambiguous-identity":
        f.makeAmbiguous();
        break;
      case "revoked-grant":
        f.capture.mockRejectedValue(new Error("private channel no longer admitted"));
        break;
      case "changed-parent":
        f.current.snapshot.conversation.parentConversationObjectId = "another-parent";
        break;
      case "missing-original":
        await database.query("DELETE FROM observed_source_snapshots");
        break;
      case "forged-history":
        original.evidence[0]!.text = "A replacement story";
        break;
      case "expanded-audience":
        original.audience.personIds.push("person_guest");
        break;
    }
    await expect(
      f.source.authorizeRetained({ source: original, audience: original.audience })
    ).resolves.toBe(false);
  });
  it("does not infer a new recipient grant from an original source or accept a foreign workspace", async () => {
    const f = fixture();
    const source = await f.source.capture(f.request);
    for (const audience of [
      { workspaceId: workspace.workspaceId, personIds: ["person_guest"] },
      { workspaceId: "another-workspace", personIds: ["person_jakob"] },
      { workspaceId: workspace.workspaceId, personIds: [] },
      { workspaceId: workspace.workspaceId, personIds: ["person_jakob", "person_jakob"] }
    ])
      await expect(f.source.authorizeRetained({ source, audience })).resolves.toBe(false);
  });
});

async function processedFixture() {
  const f = fixture();
  for (const message of f.current.snapshot.messages)
    message.author.personId = "person_jakob";
  const anchor = f.current.snapshot.messages.at(-1)!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text = "<@luma> what have we decided about Luma?";
  const inquiry: ContextInquiry = {
    type: "ask",
    workspaceId: workspace.workspaceId,
    inquiryId: "processed-inquiry",
    question: "what have we decided about Luma?",
    subject,
    audience: f.request.audience
  };
  const answer = vi.fn(() =>
    Promise.reject(new Error("No answer text is needed for original-source admission"))
  );
  const context = createContextIntelligence({
    database,
    ledger: f.ledger,
    conversationEvidenceSource: { capture: f.capture },
    answerer: { answer }
  });
  await expect(context.inquire(inquiry)).rejects.toThrow();
  const capture = () =>
    f.source.captureProcessed({ workspace, subject, audience: f.request.audience });
  return { ...f, inquiry, context, answer, processedCapture: capture };
}
describe("processed original Discord Conversation source", () => {
  it("uses an actual Context capture and original audience before AI, without a recording instruction, recapture write or invented requester", async () => {
    const f = await processedFixture();
    const rows = (await database.query("SELECT * FROM observed_source_snapshots")).rows
      .length;
    const source = await f.processedCapture();
    expect(source.revision).toMatch(/^processed:1:/u);
    expect(source.evidence.at(-1)?.text).toContain("what have we decided");
    expect(source.evidence[0]).toMatchObject({
      authorPersonId: "person_jakob",
      origin: "human"
    });
    await f.source.requireCurrent(source);
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toHaveLength(rows);
    expect(f.answer).toHaveBeenCalledTimes(1);
    expect(
      f.capture.mock.calls.every(
        (call) =>
          !(call as unknown[]).some(
            (argument) =>
              typeof argument === "object" &&
              argument !== null &&
              "purpose" in argument &&
              argument.purpose === "decision-record"
          )
      )
    ).toBe(true);
  });
  it("refuses a raw legacy ledger snapshot without a durable original audience admission", async () => {
    const f = fixture();
    await f.ledger.record({ workspaceId: workspace.workspaceId, ...f.current });
    await expect(
      f.source.captureProcessed({ workspace, subject, audience: f.request.audience })
    ).rejects.toThrow("admission");
  });
  it.each(["original-audience", "source", "author", "missing", "corrupt"])(
    "refuses changed or missing processed proof: %s",
    async (kind) => {
      const f = await processedFixture();
      const original = await f.processedCapture();
      if (kind === "original-audience") original.audience.personIds.push("guest");
      if (kind === "source") {
        const message = f.current.snapshot.messages[0]!;
        if (message.state === "available") message.text = "Changed source";
      }
      if (kind === "author") f.switchIdentity();
      if (kind === "missing")
        await database.exec("DELETE FROM processed_conversation_admissions");
      if (kind === "corrupt")
        await database.exec(
          "UPDATE processed_conversation_admissions SET payload_hash='corrupt'"
        );
      await expect(f.source.requireCurrent(original)).rejects.toThrow();
    }
  );
  it("allows eligible edited source history while keeping current execution exact", async () => {
    const f = await processedFixture(),
      original = await f.processedCapture();
    const message = f.current.snapshot.messages[0]!;
    if (message.state !== "available") throw new Error("fixture");
    message.text = "A later edited proposal.";
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    expect(
      await f.source.authorizeRetained({ source: original, audience: original.audience })
    ).toBe(true);
    expect(f.answer).toHaveBeenCalledTimes(1);
  });
  it("rejects an original source author label that conflicts with the currently verified provider account", async () => {
    const f = await processedFixture();
    await database.exec("DELETE FROM processed_conversation_admissions");
    f.current.snapshot.messages[0]!.author.personId = "person_fabius";
    await expect(
      f.context.inquire({ ...f.inquiry, inquiryId: "second" })
    ).rejects.toThrow();
    await expect(f.processedCapture()).rejects.toThrow();
  });
  it("runs processed Discord original evidence through real MI automatic detection without an explicit command", async () => {
    const f = await processedFixture(),
      record = decisionRecord();
    record.authority.snapshot.grants[0]!.personId = "person_jakob";
    const detect = vi.fn<AutomaticDecisionDetector["detect"]>((request) =>
      Promise.resolve({
        complete: true,
        candidates: [
          {
            confidence: "high",
            interpretation: {
              candidate: {
                ...record.candidate,
                modality: "proposal",
                decisionMakerPersonIds: [],
                acceptanceEvidenceIds: [],
                statement: {
                  text: request.source.evidence[0]!.text,
                  evidenceIds: [request.source.evidence[0]!.id]
                }
              },
              reconciliation: { action: "create" }
            }
          }
        ]
      })
    );
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () => Promise.reject(new Error("No Meeting"))
      },
      decisionIntelligence: {
        evidenceSource: f.source,
        authority: {
          read: () => Promise.resolve(record.authority.snapshot),
          requireCurrent: () => Promise.resolve()
        },
        interpreter: {
          interpret: () => Promise.reject(new Error("No explicit command"))
        },
        accessPolicy: f.accessPolicy,
        audience: () => Promise.resolve(f.request.audience),
        automatic: { evidenceSource: f.source, detector: { detect } },
        records: {
          providerId: "notion",
          discover: () =>
            Promise.resolve({ id: "empty", revision: "1", complete: true, records: [] }),
          requireCurrent: () => Promise.resolve(),
          read: () => Promise.resolve(null),
          readReference: () => Promise.resolve(null),
          findWritten: () => Promise.resolve(null),
          write: () => Promise.reject(new Error("No recording authorization"))
        }
      }
    });
    const observation = {
      workspace,
      subject,
      observations: [
        { type: "decision-source-processed" as const, observationId: "processed-discord" }
      ] as [{ type: "decision-source-processed"; observationId: string }]
    };
    let result: Awaited<ReturnType<typeof mi.observe>> | undefined;
    const context = createContextIntelligence({
      database,
      ledger: f.ledger,
      conversationEvidenceSource: { capture: f.capture },
      answerer: { answer: f.answer },
      onProcessedSource: async (event) => {
        expect(event.subject).toEqual(subject);
        expect(event.sourceRevision).toBe(1);
        result = await mi.observe({
          ...observation,
          observations: [
            {
              type: "decision-source-processed",
              observationId: `context-processed:${event.admissionId}`
            }
          ]
        });
      }
    });
    await expect(
      context.inquire({ ...f.inquiry, inquiryId: "pipeline-inquiry" })
    ).rejects.toThrow();
    if (!result || !("candidates" in result))
      throw new Error("Automatic source notification was not consumed");

    expect(result.candidates[0]).toMatchObject({
      state: "needs-clarification",
      candidate: { modality: "proposal" },
      approvedIntentId: null
    });
    expect(result.source.evidence.at(-1)!.text).toContain("what have we decided");
    await mi.observe(observation);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(f.answer).toHaveBeenCalledTimes(2);
  });
});
