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
import type {
  CanonicalDecisionRecord,
  DecisionCandidate
} from "../../src/domain/decision-records.js";
import { createDecisionHumanReviewAccess } from "../../src/decision-intelligence/human-review.js";
import {
  createDiscordMeetingBot,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";

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
  let identityAllowed = true;
  let authorityAllowed = true;
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
  const written = new Map<string, CanonicalDecisionRecord>();
  const accessPolicy = {
    authorize: (request: { providerUserId: string }) =>
      Promise.resolve(
        !identityAllowed
          ? null
          : {
              personId:
                request.providerUserId === "founder" ? "jakob" : request.providerUserId,
              displayName: "Founder",
              discordUserId: request.providerUserId,
              discordUsername: null,
              githubLogin: null,
              githubUserId: null,
              atlassianAccountId: null,
              notionUserId: null,
              linearUserId: null,
              languagePreference: "auto" as const
            }
      )
  };
  const audience = () =>
    Promise.resolve({ workspaceId: workspace.workspaceId, personIds: [...people] });
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
        requireCurrent: () =>
          authorityAllowed
            ? Promise.resolve()
            : Promise.reject(new Error("Authority revoked"))
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
        read: ({ recordId }) => Promise.resolve(written.get(recordId) ?? null),
        readReference: ({ reference }) =>
          Promise.resolve(written.get(reference.externalId) ?? null),
        findWritten: () => Promise.resolve(null),
        write
      },
      accessPolicy,
      audience
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
    written,
    reviewAccess: createDecisionHumanReviewAccess({ database, accessPolicy, audience }),
    accessPolicy,
    allowWrites: () =>
      write.mockImplementation(({ stage, operationId }) => {
        if (stage.type !== "create-record") throw new Error("Unexpected test stage");
        const result = {
          content: structuredClone(stage.record),
          reference: {
            providerId: "notion",
            objectType: "document" as const,
            externalId: "decision-page",
            url: "https://notion.so/decision-page"
          },
          version: "v1"
        };
        written.set(result.reference.externalId, result);
        return Promise.resolve({ operationId, observedAt: time, record: result });
      }),
    revokeIdentity: () => {
      identityAllowed = false;
    },
    revokeAuthority: () => {
      authorityAllowed = false;
    },
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

function acceptRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  reviewToken: string,
  actor = "founder"
): ObserveDecision {
  return {
    workspace,
    subject: f.request.subject,
    observations: [
      {
        type: "decision-candidate-accepted",
        observationId: "literal-owner-acceptance",
        requestId: "record-request",
        actor: { providerId: "discord", providerUserId: actor },
        reviewToken,
        instruction:
          "Ich entscheide: Luma bleibt intern bei uns vier Gründern. Bitte genau so festhalten."
      }
    ]
  };
}

describe("Original Human review of imported Decision candidates", () => {
  it("refuses a generic recording instruction even when the interpreter incorrectly calls it acceptance", async () => {
    const f = await fixture();
    f.interpret.mockImplementation((request) => {
      const evidence = request.humanReviewEvidence![0]!;
      return Promise.resolve({
        candidate: {
          ...decisionRecord().candidate,
          statement: { text: "Luma bleibt intern.", evidenceIds: [evidence.id] },
          acceptanceEvidenceIds: [evidence.id]
        },
        reconciliation: { action: "create" }
      });
    });
    const result = await f.mi.observe(f.request);
    expect(result).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
    expect(result.message).toMatch(/not the owner's acceptance/);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("accepts the exact candidate separately from unattributed transcript, writes once and replays without another model call", async () => {
    const f = await fixture();
    f.allowWrites();
    const first = await f.mi.observe(f.request);
    const acceptance = acceptRequest(f, first.reviewToken!);
    const accepted = await f.mi.observe(acceptance);
    expect(accepted.state).toBe("confirmed");
    expect(accepted.source).toEqual(first.source);
    expect(accepted.source.evidence.every((item) => item.authorPersonId === null)).toBe(
      true
    );
    expect(f.interpret).toHaveBeenCalledTimes(1);
    const executor = createFollowUpExecution({ database, meetingIntelligence: f.mi });
    const request = {
      workspace,
      subject: f.request.subject,
      decisionRequestId: accepted.requestId,
      intentId: accepted.approvedIntentId!
    };
    expect((await executor.execute(request)).record.outcome.status).toBe("succeeded");
    await executor.execute(request);
    expect((await f.mi.observe(acceptance)).duplicate).toBe(true);
    expect((await f.mi.query(f.query)).state).toBe("recorded");
    expect(
      (
        await f.mi.conclude({
          workspaceId: workspace.workspaceId,
          subject: f.request.subject,
          requestId: first.requestId
        })
      ).request.state
    ).toBe("recorded");
    expect(f.write).toHaveBeenCalledTimes(1);
    const content = f.written.get("decision-page")!.content;
    expect(content.source).toEqual(first.source);
    expect(content.authority.humanReviews).toHaveLength(2);
    expect(content.authority.humanReviews![1]!.evidence).toMatchObject({
      origin: "human",
      authorPersonId: "jakob",
      text:
        acceptance.observations[0].type === "decision-candidate-accepted"
          ? acceptance.observations[0].instruction
          : ""
    });
    expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(1);
  });
  it("can record an owner's literal original decision instruction immediately, without inventing transcript authors", async () => {
    const f = await fixture();
    f.interpret.mockImplementation((request) => {
      const evidence = request.humanReviewEvidence![0]!;
      return Promise.resolve({
        candidate: {
          ...decisionRecord().candidate,
          statement: {
            text: "Luma bleibt intern bei den vier Gründern.",
            evidenceIds: [evidence.id]
          },
          acceptanceEvidenceIds: [evidence.id]
        },
        reconciliation: { action: "create" }
      });
    });
    const request = structuredClone(f.request);
    if (request.observations[0].type !== "decision-record-requested")
      throw new Error("fixture");
    request.observations[0].instruction =
      "Ich entscheide: Luma bleibt intern bei den vier Gründern. Bitte als Entscheidung festhalten.";
    const result = await f.mi.observe(request);
    expect(result.state).toBe("confirmed");
    expect(f.interpret.mock.calls[0]![0].humanReviewEvidence?.[0]).toMatchObject({
      authorPersonId: "jakob",
      text: request.observations[0].instruction
    });
    expect(result.source.evidence.every((item) => item.authorPersonId === null)).toBe(
      true
    );
    await f.mi.observe(request);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it("refuses a stale review token and never treats a different founder as the accountable owner", async () => {
    const f = await fixture();
    const first = await f.mi.observe(f.request);
    await expect(f.mi.observe(acceptRequest(f, "stale"))).rejects.toThrow(
      /review changed/
    );
    const other = await f.mi.observe(acceptRequest(f, first.reviewToken!, "fabius"));
    expect(other).toMatchObject({ state: "needs-clarification", approvedIntentId: null });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it("cannot transfer exact owner acceptance to different candidate content via a later correction", async () => {
    const f = await fixture();
    const first = await f.mi.observe(f.request);
    const accepted = await f.mi.observe(acceptRequest(f, first.reviewToken!));
    const candidate: DecisionCandidate = structuredClone(accepted.candidate!);
    candidate.statement.text = "Luma is now public.";
    const corrected = await f.mi.observe({
      workspace,
      subject: f.request.subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "changed-candidate",
          requestId: first.requestId,
          actor: { providerId: "discord", providerUserId: "founder" },
          candidate,
          reason: "Changed wording"
        }
      ]
    });
    expect(corrected).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
    expect(corrected.message).toMatch(/different exact candidate/);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "authority", "identity", "audience"])(
    "rechecks %s after acceptance before execution and replay",
    async (change) => {
      const f = await fixture();
      f.allowWrites();
      const first = await f.mi.observe(f.request);
      const acceptance = acceptRequest(f, first.reviewToken!);
      const accepted = await f.mi.observe(acceptance);
      if (change === "source") f.revoke();
      if (change === "authority") f.revokeAuthority();
      if (change === "identity") f.revokeIdentity();
      if (change === "audience") f.people.push("guest");
      await expect(
        createFollowUpExecution({ database, meetingIntelligence: f.mi }).execute({
          workspace,
          subject: f.request.subject,
          decisionRequestId: first.requestId,
          intentId: accepted.approvedIntentId!
        })
      ).rejects.toThrow();
      await expect(f.mi.query(f.query)).rejects.toThrow();
      await expect(f.mi.observe(acceptance)).rejects.toThrow();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.interpret).toHaveBeenCalledTimes(1);
    }
  );
  it("requires the separate original Human receipt and original recipients for retained review", async () => {
    const f = await fixture();
    f.allowWrites();
    const first = await f.mi.observe(f.request);
    const accepted = await f.mi.observe(acceptRequest(f, first.reviewToken!));
    await createFollowUpExecution({ database, meetingIntelligence: f.mi }).execute({
      workspace,
      subject: f.request.subject,
      decisionRequestId: first.requestId,
      intentId: accepted.approvedIntentId!
    });
    const review = f.written.get("decision-page")!.content.authority.humanReviews![1]!;
    expect(
      await f.reviewAccess.authorizeRetainedHumanReview({
        audience: review.audience,
        review
      })
    ).toBe(true);
    expect(
      await f.reviewAccess.authorizeRetainedHumanReview({
        audience: { ...review.audience, personIds: ["jakob"] },
        review
      })
    ).toBe(true);
    expect(
      await f.reviewAccess.authorizeRetainedHumanReview({
        audience: { ...review.audience, personIds: ["guest"] },
        review
      })
    ).toBe(false);
    const forged = structuredClone(review);
    forged.evidence.text = "Invented acceptance";
    expect(
      await f.reviewAccess.authorizeRetainedHumanReview({
        audience: review.audience,
        review: forged
      })
    ).toBe(false);
    await database.query("DELETE FROM decision_human_reviews WHERE review_id=$1", [
      review.id
    ]);
    expect(
      await f.reviewAccess.authorizeRetainedHumanReview({
        audience: review.audience,
        review
      })
    ).toBe(false);
    await expect(f.mi.query(f.query)).rejects.toThrow();
  });
  it("rolls back the acceptance observation and candidate together if immutable review persistence fails", async () => {
    const f = await fixture();
    const first = await f.mi.observe(f.request);
    await database.exec(
      "ALTER TABLE decision_human_reviews ADD CONSTRAINT refuse_acceptance CHECK (payload_json::json->>'reviewToken' IS NULL)"
    );
    await expect(f.mi.observe(acceptRequest(f, first.reviewToken!))).rejects.toThrow();
    expect((await f.mi.query(f.query)).reviewToken).toBe(first.reviewToken);
    expect(
      (
        await database.query(
          "SELECT * FROM decision_observations WHERE observation_id='literal-owner-acceptance'"
        )
      ).rows
    ).toEqual([]);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
});

async function importedDecisionBot(f: Awaited<ReturnType<typeof fixture>>) {
  let command: ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | undefined;
  const transport: DiscordTransport = {
    connect: (handler) => {
      command = handler;
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    resolveChannel: ({ channelId }) =>
      Promise.resolve({
        id: channelId,
        guildId: "guild",
        kind: "public-thread",
        parentChannelId: "parent"
      }),
    createThread: () => Promise.reject(new Error("Existing bound thread only")),
    sendMessage: () => Promise.reject(new Error("Only command replies"))
  };
  const executor = createFollowUpExecution({ database, meetingIntelligence: f.mi });
  const people = await Promise.all(
    f.people.map((personId) =>
      f.accessPolicy.authorize({
        providerUserId: personId === "jakob" ? "founder" : personId
      })
    )
  );
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence: f.mi,
    followUpExecution: executor,
    identityDirectory: createStaticIdentityDirectory({
      people: people.filter((person) => person !== null)
    }),
    authorizedPersonIds: [...f.people],
    transport,
    workspace,
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    importedMeetingAccess: {
      resolve: () => Promise.resolve(f.imported.meetingId),
      requireCurrent: async ({ state, personIds }) => {
        for (const source of state.importedSources)
          await f.access.requireCurrent({
            source,
            audience: { workspaceId: workspace.workspaceId, personIds: [...personIds] }
          });
      }
    },
    decisionRecords: {
      meetingIntelligence: f.mi,
      execution: executor,
      config: {
        parentChannelIds: ["parent"],
        allowedDiscordUserIds: ["founder", "fabius"],
        maxMessages: 50,
        maxEvidenceChars: 32000,
        minIntervalMs: 1000
      }
    }
  });
  await bot.start();
  const base = {
    guildId: "guild",
    channelId: "review-thread",
    actorDiscordUserId: "founder",
    occurredAt: time,
    interactionId: "record-imported"
  };
  return {
    bot,
    base,
    invoke: (input: DiscordCommand) => command!(input),
    bind: () =>
      command!({
        ...base,
        type: "bind",
        interactionId: "bind-imported",
        sourcePage: "11111111-1111-4111-8111-111111111111"
      })
  };
}

describe("Native imported Decision commands through the actual MI facade", () => {
  it("rechecks the imported thread binding after interpretation before executing an otherwise approved record", async () => {
    const f = await fixture();
    f.allowWrites();
    const live = await importedDecisionBot(f);
    try {
      await live.bind();
      f.interpret.mockImplementation(async (request) => {
        await database.query(
          "UPDATE discord_meeting_threads SET thread_id='moved-thread' WHERE workspace_id=$1",
          [workspace.workspaceId]
        );
        const evidence = request.humanReviewEvidence![0]!;
        return {
          candidate: {
            ...decisionRecord().candidate,
            statement: { text: "Luma bleibt intern.", evidenceIds: [evidence.id] },
            acceptanceEvidenceIds: [evidence.id]
          },
          reconciliation: { action: "create" }
        };
      });
      const response = await live.invoke({
        ...live.base,
        type: "decision-record-meeting",
        instruction: "Ich entscheide: Luma bleibt intern. Bitte festhalten."
      });
      expect(response.content).toContain("could not verify");
      expect(f.write).not.toHaveBeenCalled();
      expect(f.interpret).toHaveBeenCalledTimes(1);
    } finally {
      await live.bot.stop();
    }
  });
  it("preserves English and German decision negation and quoted wording through public observation", async () => {
    const f = await fixture();
    const original = f.request.observations[0];
    if (original?.type !== "decision-record-requested") throw new Error("fixture");
    const instructions = [
      "Record Jakob's decision that Luma will not yet launch.",
      'Record the decision: "Do not update the production service yet."',
      "Record the decision: 'Do not create public accounts yet.'",
      "Dokumentiere die Entscheidung, dass Luma noch nicht startet.",
      "Dokumentiere die Entscheidung: „Bitte dokumentiere diese Entscheidung nicht.“",
      "Dokumentiere die Entscheidung: Wir starten heute, aber nicht öffentlich."
    ];
    for (const [index, instruction] of instructions.entries()) {
      await f.mi.observe({
        ...f.request,
        observations: [
          { ...original, observationId: `content-negation-${index}`, instruction }
        ]
      });
      expect(f.interpret).toHaveBeenCalledTimes(index + 1);
      expect(f.interpret.mock.calls[index]![0].instruction).toBe(instruction);
      expect(f.write).not.toHaveBeenCalled();
    }
  });

  it("does not analyze or record a bound Meeting when the original command refuses recording", async () => {
    const f = await fixture();
    f.allowWrites();
    const live = await importedDecisionBot(f);
    try {
      await live.bind();
      const original = f.request.observations[0];
      if (original?.type !== "decision-record-requested") {
        throw new Error("Expected the fixture's decision recording request");
      }
      const refusals = [
        "Create a decision record, but not yet.",
        "Record this decision, but not now.",
        'Record the decision: "Luma will not yet launch.", but not now.',
        "Do not record this decision.",
        "Please don't update the existing decision.",
        "Bitte dokumentiere diese Entscheidung nicht.",
        "Dokumentiere die Entscheidung: „Luma bleibt intern.“, aber noch nicht.",
        "Aktualisiere den bestehenden Decision Record bitte noch nicht."
      ];
      for (const [index, instruction] of refusals.entries()) {
        await live.invoke({
          ...live.base,
          interactionId: `refusal-${index}`,
          type: "decision-record-meeting",
          instruction
        });
        expect(f.interpret).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
        await expect(
          f.mi.observe({
            ...f.request,
            observations: [{ ...original, instruction }]
          })
        ).rejects.toThrow("refusal");
        expect(f.interpret).not.toHaveBeenCalled();
      }
    } finally {
      await live.bot.stop();
    }
  });

  it("binds the actual import, reviews and accepts its candidate, then records once without another model call", async () => {
    const f = await fixture();
    f.allowWrites();
    const live = await importedDecisionBot(f);
    try {
      const record: DiscordCommand = {
        ...live.base,
        type: "decision-record-meeting",
        instruction: "Record the decision from this imported Meeting."
      };
      expect((await live.invoke(record)).content).toContain("/meeting bind");
      expect(f.interpret).not.toHaveBeenCalled();
      expect((await live.bind()).content).toContain("Imported Meeting attached");
      const candidate = await live.invoke(record);
      expect(candidate.content).toContain("needs-clarification");
      expect(candidate.content).toContain("Luma bleibt intern bei den vier Gründern.");
      expect(candidate.content.length).toBeLessThanOrEqual(1850);
      const requestId = "discord:record-imported:decision-record";
      const review = await live.invoke({
        ...live.base,
        type: "decision-record-status",
        requestId,
        page: 1000
      });
      const reviewToken = /Review token: ([a-f0-9]{64})/u.exec(review.content)?.[1];
      expect(reviewToken).toBeDefined();
      const acceptance: DiscordCommand = {
        ...live.base,
        type: "decision-record-accept",
        interactionId: "accept-imported",
        requestId,
        reviewToken: reviewToken!,
        instruction: "Ich bestätige diese genaue Entscheidung. Bitte festhalten."
      };
      expect(
        (await live.invoke({ ...acceptance, reviewToken: "stale" })).content
      ).toContain("could not verify");
      expect(f.write).not.toHaveBeenCalled();
      const accepted = await live.invoke(acceptance);
      expect(accepted.content).toContain("recorded");
      await accepted.requireCurrent?.();
      expect((await live.invoke(acceptance)).content).toContain("recorded");
      expect(
        (await live.invoke({ ...live.base, type: "decision-record-status", requestId }))
          .content
      ).toContain("recorded");
      expect(f.interpret).toHaveBeenCalledTimes(1);
      expect(f.write).toHaveBeenCalledTimes(1);
      expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(1);
      expect(
        f.written
          .get("decision-page")!
          .content.source.evidence.every((item) => item.authorPersonId === null)
      ).toBe(true);
    } finally {
      await live.bot.stop();
    }
  });
  it.each(["binding", "source"])(
    "withholds the actual cached Discord response after %s changes",
    async (change) => {
      const f = await fixture();
      const live = await importedDecisionBot(f);
      try {
        await live.bind();
        const response = await live.invoke({
          ...live.base,
          type: "decision-record-meeting",
          instruction: "Record this imported discussion."
        });
        expect(response.requireCurrent).toBeDefined();
        if (change === "source") f.revoke();
        else
          await database.query(
            "UPDATE discord_meeting_threads SET thread_id='another-thread' WHERE workspace_id=$1",
            [workspace.workspaceId]
          );
        await expect(response.requireCurrent!()).rejects.toThrow();
        expect(f.write).not.toHaveBeenCalled();
      } finally {
        await live.bot.stop();
      }
    }
  );
  it("makes every long candidate detail reviewable through bounded pages before giving the acceptance token", async () => {
    const f = await fixture();
    const original = f.interpret.getMockImplementation()!;
    const longReason = "This precise reason remains under review. ".repeat(80);
    f.interpret.mockImplementation(async (request) => {
      const result = await original(request);
      result.candidate!.rationale = [
        { text: longReason, evidenceIds: result.candidate!.statement.evidenceIds }
      ];
      return result;
    });
    const live = await importedDecisionBot(f);
    try {
      await live.bind();
      const first = await live.invoke({
        ...live.base,
        type: "decision-record-meeting",
        instruction: "Record the meeting decision."
      });
      expect(first.content).not.toContain("Review token:");
      const count = Number(/Candidate review 1\/(\d+)/u.exec(first.content)?.[1]);
      expect(count).toBeGreaterThan(2);
      const pages: string[] = [];
      for (let page = 1; page <= count; page++) {
        const result = await live.invoke({
          ...live.base,
          type: "decision-record-status",
          requestId: "discord:record-imported:decision-record",
          page
        });
        expect(result.content.length).toBeLessThanOrEqual(1850);
        pages.push(
          result.content
            .split(`Candidate review ${page}/${count}:\n`)[1]!
            .split(/\n(?:Read the remaining|Review token:)/u)[0]!
        );
        if (page < count) expect(result.content).not.toContain("Review token:");
        else expect(result.content).toContain("Review token:");
      }
      expect(pages.join("")).toContain(longReason);
      expect(f.interpret).toHaveBeenCalledTimes(1);
    } finally {
      await live.bot.stop();
    }
  });
});
