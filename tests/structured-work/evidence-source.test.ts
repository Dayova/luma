import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createStructuredWorkEvidenceSource } from "../../src/structured-work/evidence-source.js";
import {
  structuredWorkEvidence,
  type StructuredWorkSource
} from "../../src/domain/structured-work.js";
import { structuredWorkSourceSchema } from "../../src/structured-work/schemas.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { CaptureConversationEvidenceInput } from "../../src/context-intelligence/conversation-evidence-source.js";
import { captureFixture } from "../consultation/harness.js";
import {
  audience,
  subject,
  workspace,
  sourceFixture,
  structuredWorkFixture,
  title
} from "./fixture.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
function fixture() {
  const core = structuredWorkFixture(database),
    raw = captureFixture();
  const originals = sourceFixture().evidence;
  raw.source.sourceObjectId = subject.anchorMessageId;
  raw.source.parentObjectId = subject.conversationObjectId;
  raw.source.url = "https://discord.com/channels/guild/thread/command";
  raw.snapshot.conversation.conversationObjectId = subject.conversationObjectId;
  raw.snapshot.messages = originals.map((entry, ordinal) => ({
    id: ordinal === originals.length - 1 ? "command" : `message-${ordinal}`,
    ordinal,
    author: {
      providerUserId: entry.authorPersonId!,
      displayName: "Founder",
      personId: "forged-metadata"
    },
    createdAt: raw.observedAt,
    editedAt: null,
    replyToMessageId: null,
    url: `https://discord.com/channels/guild/thread/${ordinal}`,
    state: "available",
    text: ordinal === originals.length - 1 ? `<@luma> ${entry.text}` : entry.text
  }));
  raw.snapshot.boundary = {
    mode: "thread",
    anchorMessageId: "command",
    firstMessageId: "message-0",
    lastMessageId: "command",
    messageIds: raw.snapshot.messages.map((message) => message.id)
  };
  let granted = true;
  const capture = vi.fn((request: CaptureConversationEvidenceInput) => {
    if (
      !granted ||
      request.purpose !== "structured-work" ||
      request.subject.anchorMessageId !== "command" ||
      (request.question !== undefined &&
        request.question !== core.request.observations[0].instruction)
    )
      return Promise.reject(new Error("Unavailable capture"));
    return Promise.resolve(structuredClone(raw));
  });
  const ledger = createObservedSourceLedger({ database });
  const conversation = {
    workspaceId: workspace.workspaceId,
    conversationEvidenceSource: { capture },
    ledger,
    accessPolicy: core.configuration.accessPolicy,
    recipientPersonIds: audience.personIds
  };
  const evidenceSource = createStructuredWorkEvidenceSource({ conversation });
  const request = {
    workspace,
    subject,
    instruction: core.request.observations[0].instruction,
    actor: core.request.observations[0].actor,
    audience
  };
  return {
    core,
    raw,
    ledger,
    conversation,
    evidenceSource,
    request,
    capture,
    revoke: () => {
      granted = false;
    }
  };
}
async function imported(f: ReturnType<typeof fixture>) {
  const time = "2026-09-11T10:00:00.000Z";
  const identity = {
    providerId: "notion",
    sourceKind: "meeting-note" as const,
    sourceObjectId: "root",
    parentObjectId: "page",
    url: "https://notion.so/page"
  };
  const section = (id: string, text: string) => ({
    state: "available" as const,
    sourceBlockId: id,
    text,
    blocks: [
      { id: `${id}-paragraph`, type: "paragraph", text, checked: null, children: [] }
    ]
  });
  const live: RawMeetingNoteSnapshot = {
    schemaVersion: 1,
    title: "Learning times",
    lifecycle: "ready",
    calendar: { startAt: time, endAt: time, attendeeProviderUserIds: ["jakob"] },
    recording: null,
    sections: {
      summary: section("summary", "Generated summary: Jakob owns validation."),
      actionItemsAndNotes: section(
        "notes",
        "Validate the flexible learning times hypothesis."
      ),
      transcript: section(
        "transcript",
        "Jakob: I will validate flexible learning times. The hypothesis is not proven."
      )
    },
    markdown: { content: "# Learning times", truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
  let granted = true;
  const access = createGrantedImportedSourceAnalysisAccess({
    ledger: f.ledger,
    authorize: () => Promise.resolve(granted),
    evidenceSource: () => ({
      capture: () =>
        Promise.resolve({
          status: "captured",
          evidence: {
            source: identity,
            providerVersion: null,
            observedAt: time,
            snapshot: structuredClone(live)
          }
        })
    })
  });
  const source = await f.ledger.record({
    workspaceId: workspace.workspaceId,
    source: identity,
    providerVersion: null,
    observedAt: time,
    snapshot: live
  });
  const observation = observedMeetingNoteToObservation({ workspace, source }, "linear");
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: {
      generateStructured: () =>
        Promise.reject(new Error("No inference for original capture"))
    },
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger: f.ledger
    }),
    importedSourceAnalysis: { access, audience: () => Promise.resolve(audience) }
  });
  await mi.observe({ workspace, observations: [observation] });
  const evidenceSource = createStructuredWorkEvidenceSource({
    conversation: f.conversation,
    importedMeetings: { database, ledger: f.ledger, sourceAccess: access }
  });
  const request = {
    ...f.request,
    subject: { type: "meeting" as const, meetingId: observation.meetingId },
    instructionSubject: subject
  };
  return {
    evidenceSource,
    request,
    live,
    revoke: () => {
      granted = false;
    }
  };
}
function useOriginalInterpreter(
  f: ReturnType<typeof fixture>,
  ownerFrom: "command" | "import"
) {
  f.core.configuration.interpreter = {
    interpret: (request) => {
      const evidence = structuredWorkEvidence(request.source);
      const origin =
        ownerFrom === "command"
          ? (request.source.instructionSource?.evidence ?? request.source.evidence)
          : request.source.evidence;
      const own = origin.filter((entry) =>
        ownerFrom === "command"
          ? entry.text.startsWith("So should I") || entry.text === "Yes."
          : entry.reference.source === "transcript"
      );
      return Promise.resolve({
        targetKey: "hypotheses",
        record: {
          fields: { hypothesis: { type: "text", value: title } },
          evidenceIds: [evidence[0]!.id],
          reconciliation: { action: "create" }
        },
        work: {
          title: "Validate flexible learning times",
          description: "Interview students about changing study times.",
          evidenceIds: [evidence[0]!.id, ...own.map((entry) => entry.id)],
          ownership: {
            status: "confirmed",
            personId: "jakob",
            evidenceIds: own.map((entry) => entry.id)
          },
          reconciliation: { action: "create" }
        }
      });
    }
  };
}
describe("actual governed source adapters for structured work", () => {
  it("retains exact original Conversation material, ignores forged person metadata and revalidates without ledger writes", async () => {
    const f = fixture();
    const captured = await f.evidenceSource.capture(f.request);
    expect(captured.evidence[0]).toMatchObject({
      authorPersonId: "fabius",
      text: sourceFixture().evidence[0]!.text,
      origin: "human"
    });
    expect(captured.evidence[0]!.id).toContain("structured-work-evidence:");
    const rows = (await database.query("SELECT * FROM observed_source_snapshots")).rows;
    await f.evidenceSource.requireCurrent(
      structuredWorkSourceSchema.parse(JSON.parse(JSON.stringify(captured)))
    );
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual(rows);
    f.revoke();
    await expect(f.evidenceSource.requireCurrent(captured)).rejects.toThrow();
  });
  it.each(["actor", "audience", "partial", "boundary", "identity"])(
    "rejects %s before an eligible source is admitted",
    async (kind) => {
      const f = fixture();
      if (kind === "actor") f.request.actor.providerUserId = "fabius";
      if (kind === "audience")
        f.request.audience = { ...audience, personIds: [...audience.personIds, "guest"] };
      if (kind === "partial")
        f.raw.snapshot.completeness = {
          state: "partial",
          reasons: [{ code: "history-truncated", message: "missing" }]
        };
      if (kind === "boundary") f.raw.snapshot.boundary.anchorMessageId = "other";
      if (kind === "identity")
        f.raw.snapshot.messages[0]!.author.providerUserId = "guest";
      await expect(f.evidenceSource.capture(f.request)).rejects.toThrow();
      expect(
        (await database.query("SELECT * FROM observed_source_snapshots")).rows
      ).toEqual([]);
    }
  );
  it("runs the original Conversation through MI and durable execution without creating a Meeting", async () => {
    const f = fixture();
    f.core.configuration.evidenceSource = f.evidenceSource;
    useOriginalInterpreter(f, "command");
    const { mi, execution } = f.core.make();
    const state = await mi.observe(f.core.request);
    expect(state.state).toBe("validated");
    expect(
      (
        await execution.execute({
          workspace,
          subject,
          structuredWorkRequestId: state.requestId,
          intentId: state.approvedIntentId!
        })
      ).state
    ).toBe("completed");
    expect((await database.query("SELECT * FROM meetings")).rows).toEqual([]);
    f.raw.snapshot.messages[0]!.text = "Changed source";
    await expect(
      mi.query({
        workspaceId: workspace.workspaceId,
        subject,
        query: { type: "structured-work-request", requestId: state.requestId }
      })
    ).rejects.toThrow();
  });
  it("retains an actual imported Meeting and its original command independently, without inventing imported speaker identities", async () => {
    const f = fixture(),
      m = await imported(f);
    const source = await m.evidenceSource.capture(m.request);
    expect(source.subject).toEqual(m.request.subject);
    expect(source.instructionSource?.subject).toEqual(subject);
    expect(source.evidence.every((entry) => entry.authorPersonId === null)).toBe(true);
    expect(
      source.instructionSource?.evidence.some((entry) => entry.authorPersonId === "jakob")
    ).toBe(true);
    await m.evidenceSource.requireCurrent(
      structuredWorkSourceSchema.parse(JSON.parse(JSON.stringify(source)))
    );
    const forged: StructuredWorkSource = structuredClone(source);
    forged.evidence[0]!.authorPersonId = "jakob";
    await expect(m.evidenceSource.requireCurrent(forged)).rejects.toThrow();
    const missing = structuredClone(source);
    delete missing.instructionSource;
    await expect(m.evidenceSource.requireCurrent(missing)).rejects.toThrow();
  });
  it.each(["command", "meeting", "command-wording", "meeting-wording"])(
    "withholds the imported pair after %s revocation or change",
    async (kind) => {
      const f = fixture(),
        m = await imported(f);
      const source = await m.evidenceSource.capture(m.request);
      if (kind === "command") f.revoke();
      if (kind === "meeting") m.revoke();
      if (kind === "command-wording")
        f.raw.snapshot.messages[0]!.text = "Edited feedback";
      if (kind === "meeting-wording" && m.live.sections.transcript.state === "available")
        m.live.sections.transcript.text = "Changed original";
      await expect(m.evidenceSource.requireCurrent(source)).rejects.toThrow();
    }
  );
  it.each(["command", "import"] as const)(
    "uses only proved Human %s ownership through actual Meeting MI/FUE",
    async (ownerFrom) => {
      const f = fixture(),
        m = await imported(f);
      f.core.configuration.evidenceSource = m.evidenceSource;
      useOriginalInterpreter(f, ownerFrom);
      const request = {
        ...f.core.request,
        subject: m.request.subject,
        observations: [
          { ...f.core.request.observations[0], instructionSubject: subject }
        ] as [(typeof f.core.request.observations)[0]]
      };
      const { mi, execution } = f.core.make();
      const state = await mi.observe(request);
      if (ownerFrom === "import") {
        expect(state.state).toBe("needs-clarification");
        expect(state.approvedIntentId).toBeNull();
        expect(f.core.createRecord).not.toHaveBeenCalled();
        return;
      }
      expect(state.state).toBe("validated");
      const result = await execution.execute({
        workspace,
        subject: request.subject,
        structuredWorkRequestId: state.requestId,
        intentId: state.approvedIntentId!
      });
      expect(result.state).toBe("completed");
      expect(
        f.core.createRecord.mock.calls[0]![0].draft.source.instructionSource?.subject
      ).toEqual(subject);
      expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(1);
    }
  );
});
