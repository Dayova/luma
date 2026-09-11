import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createImportedMeetingDecisionEvidenceSource } from "../../src/decision-intelligence/imported-meeting-evidence-source.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import type { DecisionInterpreter } from "../../src/decision-intelligence/ports.js";
import type { DecisionRecords } from "../../src/knowledge/decision-records.js";
import type { ObserveDecision } from "../../src/domain/decision-records.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
const workspace = { workspaceId: "dayova", timezone: "Europe/Berlin" };
const time = "2026-09-11T10:00:00.000Z";

async function fixture() {
  const people = ["jakob", "fabius", "philipp", "julius"];
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
    title: "Luma decision discussion",
    lifecycle: "ready",
    calendar: { startAt: time, endAt: time, attendeeProviderUserIds: ["jakob"] },
    recording: null,
    sections: {
      summary: section("summary", "Generated summary: Jakob decided to publish Luma."),
      actionItemsAndNotes: section("notes", "Luma launch discussion"),
      transcript: section(
        "transcript",
        "Jakob: Luma bleibt intern bei den vier Gründern. Wir könnten später Support anbieten."
      )
    },
    markdown: { content: "# Meeting", truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
  let granted = true;
  let revokeDuringRead = false;
  const ledger = createObservedSourceLedger({ database });
  const access = createGrantedImportedSourceAnalysisAccess({
    ledger,
    authorize: () => Promise.resolve(granted),
    evidenceSource: () => ({
      capture: () => {
        if (revokeDuringRead) granted = false;
        return Promise.resolve({
          status: "captured",
          evidence: {
            source: structuredClone(identity),
            providerVersion: null,
            observedAt: time,
            snapshot: structuredClone(live)
          }
        });
      }
    })
  });
  const source = createImportedMeetingDecisionEvidenceSource({
    database,
    ledger,
    sourceAccess: access
  });
  const record = decisionRecord();
  const interpret = vi.fn<DecisionInterpreter["interpret"]>((request) => {
    const transcript = request.source.evidence.find(
      (entry) => entry.reference.source === "transcript"
    )!;
    return Promise.resolve({
      candidate: {
        ...record.candidate,
        statement: {
          text: "Luma bleibt intern bei den vier Gründern.",
          evidenceIds: [transcript.id]
        },
        acceptanceEvidenceIds: [transcript.id]
      },
      reconciliation: { action: "create" }
    });
  });
  const write = vi.fn<DecisionRecords["write"]>(() => {
    throw new Error("No Human acceptance permits a write");
  });
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: {
      generateStructured: () =>
        Promise.reject(
          new Error("No general analysis is needed to use retained original evidence")
        )
    },
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger
    }),
    importedSourceAnalysis: {
      access,
      audience: () =>
        Promise.resolve({ workspaceId: workspace.workspaceId, personIds: [...people] })
    },
    decisionIntelligence: {
      meetingEvidenceSource: source,
      evidenceSource: {
        capture: () => Promise.reject(new Error("No synthetic Conversation")),
        requireCurrent: () => Promise.reject(new Error("No synthetic Conversation"))
      },
      authority: {
        read: () => Promise.resolve(record.authority.snapshot),
        requireCurrent: () => Promise.resolve()
      },
      interpreter: { interpret },
      records: {
        providerId: "notion",
        discover: () =>
          Promise.resolve({
            id: "decisions",
            revision: "1",
            complete: true,
            records: []
          }),
        requireCurrent: () => Promise.resolve(),
        read: () => Promise.resolve(null),
        findWritten: () => Promise.resolve(null),
        write
      },
      accessPolicy: {
        authorize: () =>
          Promise.resolve({
            personId: "jakob",
            displayName: "Jakob",
            discordUserId: "founder",
            discordUsername: null,
            githubLogin: null,
            githubUserId: null,
            atlassianAccountId: null,
            notionUserId: null,
            linearUserId: null,
            languagePreference: "auto"
          })
      },
      audience: () =>
        Promise.resolve({ workspaceId: workspace.workspaceId, personIds: [...people] })
    },
    now: () => new Date(time)
  });
  const retain = () =>
    ledger.record({
      workspaceId: workspace.workspaceId,
      source: identity,
      providerVersion: null,
      observedAt: time,
      snapshot: live
    });
  const imported = observedMeetingNoteToObservation(
    { workspace, source: await retain() },
    "linear"
  );
  const accepted = await mi.observe({ workspace, observations: [imported] });
  expect(accepted.acceptedObservationIds).toEqual([imported.observationId]);
  const request: ObserveDecision = {
    workspace,
    subject: { type: "meeting", meetingId: imported.meetingId },
    observations: [
      {
        type: "decision-record-requested",
        observationId: "record-request",
        actor: { providerId: "discord", providerUserId: "founder" },
        instruction: "Record the decision from this Meeting."
      }
    ]
  };
  const query = {
    workspaceId: workspace.workspaceId,
    subject: request.subject,
    query: { type: "decision-request" as const, requestId: "record-request" }
  };
  return {
    mi,
    source,
    ledger,
    access,
    imported,
    request,
    query,
    retain,
    live,
    identity,
    people,
    interpret,
    write,
    revoke: () => {
      granted = false;
    },
    revokeDuringRead: () => {
      revokeDuringRead = true;
    }
  };
}

describe("Imported Meeting Decision evidence through MI", () => {
  it("preserves original German speech while withholding invented speaker acceptance, with no paid replay or provider write", async () => {
    const f = await fixture();
    const update = await f.mi.observe(f.request);
    expect(update).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
    const transcript = update.source.evidence.find(
      (entry) => entry.reference.source === "transcript"
    );
    expect(transcript).toMatchObject({
      origin: "human",
      authorPersonId: null,
      text: "Jakob: Luma bleibt intern bei den vier Gründern. Wir könnten später Support anbieten."
    });
    expect(
      update.source.evidence.find((entry) => entry.reference.source === "knowledge")
    ).toMatchObject({ origin: "provider-derived", authorPersonId: null });
    expect((await f.mi.query(f.query)).source).toEqual(update.source);
    expect(
      (
        await f.mi.conclude({
          workspaceId: workspace.workspaceId,
          subject: f.request.subject,
          requestId: update.requestId
        })
      ).request.source
    ).toEqual(update.source);
    expect((await f.mi.observe(f.request)).duplicate).toBe(true);
    expect(f.interpret).toHaveBeenCalledTimes(1);
    const execution = createFollowUpExecution({ database, meetingIntelligence: f.mi });
    await expect(
      execution.execute({
        workspace,
        subject: f.request.subject,
        decisionRequestId: update.requestId,
        intentId: "invented-approved-intent"
      })
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(1);
  });
  it("retains edited source wording for original recipients without treating it as a current execution source or changing the ledger", async () => {
    const f = await fixture();
    const original = (await f.mi.observe(f.request)).source;
    if (f.live.sections.transcript.state !== "available") throw new Error("fixture");
    f.live.sections.transcript.text = "New discussion wording";
    f.live.sections.transcript.blocks[0]!.text = "New discussion wording";
    await f.retain();
    const before = (await database.query("SELECT * FROM observed_source_snapshots")).rows;
    await expect(f.mi.query(f.query)).rejects.toThrow();
    await expect(
      f.source.authorizeRetained({ source: original, audience: original.audience })
    ).resolves.toBe(true);
    await expect(
      f.source.authorizeRetained({
        source: original,
        audience: { workspaceId: workspace.workspaceId, personIds: ["jakob"] }
      })
    ).resolves.toBe(true);
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual(before);
    expect(
      original.evidence.some((entry) => entry.text.includes("Wir könnten später Support"))
    ).toBe(true);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it.each([
    "grant",
    "rebind",
    "deleted",
    "section-excluded",
    "block-excluded",
    "erased",
    "receipt-missing",
    "snapshot-missing",
    "forged-speaker",
    "expanded-original"
  ])("withholds source history after %s", async (failure) => {
    const f = await fixture();
    const original = (await f.mi.observe(f.request)).source;
    switch (failure) {
      case "grant":
        f.revoke();
        break;
      case "rebind":
        f.identity.parentObjectId = "another-page";
        await f.retain();
        break;
      case "deleted":
        f.live.lifecycle = "removed";
        f.live.completeness = { state: "removed", message: "Source removed" };
        await f.retain();
        break;
      case "section-excluded":
        f.live.sections.transcript = {
          state: "unavailable",
          sourceBlockId: "transcript",
          reasons: []
        };
        await f.retain();
        break;
      case "block-excluded":
        if (f.live.sections.transcript.state !== "available") throw new Error("fixture");
        f.live.sections.transcript.blocks = [];
        await f.retain();
        break;
      case "erased":
        if (f.live.sections.transcript.state !== "available") throw new Error("fixture");
        f.live.sections.transcript.text = "";
        await f.retain();
        break;
      case "receipt-missing":
        await database.query("DELETE FROM meeting_imported_source_receipts");
        break;
      case "snapshot-missing":
        await database.query("DELETE FROM observed_source_snapshots");
        break;
      case "forged-speaker":
        original.evidence[0]!.authorPersonId = "jakob";
        break;
      case "expanded-original":
        original.audience.personIds.push("guest");
        break;
    }
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    await expect(
      f.source.authorizeRetained({ source: original, audience: original.audience })
    ).resolves.toBe(false);
    if (failure !== "forged-speaker" && failure !== "expanded-original") {
      await expect(f.mi.query(f.query)).rejects.toThrow();
      await expect(
        f.mi.conclude({
          workspaceId: workspace.workspaceId,
          subject: f.request.subject,
          requestId: "record-request"
        })
      ).rejects.toThrow();
    }
    expect(f.write).not.toHaveBeenCalled();
  });
  it("withholds a query if the source grant is revoked during the live provider proof", async () => {
    const f = await fixture();
    const original = (await f.mi.observe(f.request)).source;
    f.revokeDuringRead();
    await expect(f.mi.query(f.query)).rejects.toThrow();
    await expect(f.mi.observe(f.request)).rejects.toThrow();
    await expect(
      f.source.authorizeRetained({ source: original, audience: original.audience })
    ).resolves.toBe(false);
    expect(f.interpret).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("refuses a larger current audience and never infers original disclosure from attendance", async () => {
    const f = await fixture();
    const original = (await f.mi.observe(f.request)).source;
    f.people.push("guest");
    await expect(f.mi.query(f.query)).rejects.toThrow();
    await expect(
      f.mi.conclude({
        workspaceId: workspace.workspaceId,
        subject: f.request.subject,
        requestId: "record-request"
      })
    ).rejects.toThrow();
    await expect(
      f.mi.observe({
        ...f.request,
        observations: [
          { ...f.request.observations[0], observationId: "expanded-request" }
        ]
      })
    ).rejects.toThrow();
    for (const audience of [
      { workspaceId: workspace.workspaceId, personIds: ["guest"] },
      { workspaceId: "foreign", personIds: ["jakob"] },
      { workspaceId: workspace.workspaceId, personIds: [] }
    ])
      await expect(
        f.source.authorizeRetained({ source: original, audience })
      ).resolves.toBe(false);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
});
