import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingCaptureRuntime } from "../../src/app/meeting-capture-runtime.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import {
  createGranolaPolicy,
  type GranolaConnectionPolicy
} from "../../src/granola/policy.js";
import { granolaAccountFingerprint } from "../../src/granola/wire-format.js";
import type { GranolaMcpClient } from "../../src/granola/mcp-client.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import type { DecisionRecords } from "../../src/knowledge/decision-records.js";
import type {
  DecisionSource,
  DecisionInterpretation,
  CanonicalDecisionRecord
} from "../../src/domain/decision-records.js";
import type { AutomaticDecisionBatch } from "../../src/domain/automatic-decisions.js";
import type { CaptureSynthesisJudgmentRecorded } from "../../src/domain/meeting-capture-synthesis.js";
import { createLogicalMeetingDecisionEvidenceSource } from "../../src/decision-intelligence/logical-meeting-evidence-source.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import type { ProcessedLogicalMeetingSourceEvent } from "../../src/meeting-intelligence/meeting-capture-access.js";
const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T10:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const database = await createPgliteDatabase();
  const directory = await mkdtemp(join(tmpdir(), "luma-logical-decision-"));
  cleanups.push(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const text = (value: string) => ({
    content: [{ type: "text", text: value }],
    isError: false
  });
  const account = text("Account Jakob; active workspace Dayova");
  let body = "Wir könnten nächste Woche starten.";
  let absent = false;
  let readHook: (() => Promise<void>) | undefined;
  const document = () =>
    `<meeting id="work" title="Weekly" date="Sep 11, 2026 9:00 AM"><known_participants>Jakob (note creator) &lt;jakob@dayova.test&gt;</known_participants><summary>${body}</summary></meeting>`;
  const client: GranolaMcpClient = {
    tools: () =>
      Promise.resolve([
        { name: "get_account_info", inputSchema: { type: "object", properties: {} } },
        {
          name: "list_meetings",
          inputSchema: { type: "object", properties: { limit: { type: "integer" } } }
        },
        {
          name: "get_meetings",
          inputSchema: {
            type: "object",
            properties: { meeting_ids: { type: "array", items: { type: "string" } } },
            required: ["meeting_ids"]
          }
        }
      ]),
    call: (name) =>
      Promise.resolve(
        name === "get_account_info"
          ? account
          : text(
              name === "list_meetings"
                ? `<meetings_data count="${absent ? 0 : 1}">${absent ? "" : document()}</meetings_data>`
                : absent
                  ? '<meetings_data count="0"></meetings_data>'
                  : document()
            )
      )
  };
  const connection: GranolaConnectionPolicy = {
    connectionId: "jakob",
    ownerPersonId: "person_jakob",
    optInId: "original-opt-in",
    accountFingerprint: granolaAccountFingerprint(account),
    enabled: true,
    audiencePersonIds: [...dayovaFounderPersonIds],
    automaticInternalMeetings: false,
    participantDirectory: [],
    includedMeetingIds: ["work"],
    excludedMeetingIds: []
  };
  const policyPath = join(directory, "policy.json");
  const savePolicy = () =>
    writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        workspaceId: workspace.workspaceId,
        connections: [connection]
      }),
      { mode: 0o600 }
    );
  await savePolicy();
  const runtime = await createMeetingCaptureRuntime({
    database,
    workspace,
    ledger: createObservedSourceLedger({ database }),
    workItemProviderId: "linear",
    granola: {
      policy: createGranolaPolicy({
        path: policyPath,
        workspaceId: workspace.workspaceId
      }),
      connections: [{ connectionId: "jakob", client }]
    }
  });
  cleanups.push(() => runtime.stop());
  const access = runtime.configuration.access;
  const readCurrent = access.readCurrent.bind(access);
  access.readCurrent = async (request) => {
    const result = await readCurrent(request);
    await readHook?.();
    return result;
  };
  const source = createLogicalMeetingDecisionEvidenceSource({
    database,
    configuration: runtime.configuration
  });
  const authority = decisionRecord().authority.snapshot;
  authority.grants[0]!.personId = "person_jakob";
  const audience = {
    workspaceId: workspace.workspaceId,
    personIds: [...dayovaFounderPersonIds]
  };
  const written = new Map<string, CanonicalDecisionRecord>();
  const write = vi.fn<DecisionRecords["write"]>(async (request) => {
    await request.requireCurrent();
    if (request.stage.type !== "create-record") throw new Error("Only create expected");
    const record = {
      content: request.stage.record,
      reference: {
        providerId: "notion",
        externalId: "page",
        url: "https://notion.so/page",
        objectType: "document" as const
      },
      version: request.operationId
    };
    written.set("page", record);
    return { record, operationId: request.operationId, observedAt: at };
  });
  const records: DecisionRecords = {
    providerId: "notion",
    discover: () =>
      Promise.resolve({
        id: "catalog",
        revision: "v1",
        complete: true,
        records: [...written.values()]
      }),
    requireCurrent: () => Promise.resolve(),
    read: ({ recordId }) => Promise.resolve(written.get(recordId) ?? null),
    readReference: ({ reference }) =>
      Promise.resolve(written.get(reference.externalId) ?? null),
    findWritten: () => Promise.resolve(null),
    write
  };
  let statement = "Launch remains a proposal.";
  let useAccuracyAcceptance = false;
  let useCorrection = false;
  const interpretation = (source: DecisionSource): DecisionInterpretation => {
    const raw = source.evidence.find((item) => !item.purpose)!;
    const review = source.evidence
      .filter((item) => item.captureReview)
      .sort((a, b) => a.captureReview!.revision - b.captureReview!.revision)
      .at(-1);
    const acceptance = useAccuracyAcceptance && review ? review : raw;
    const candidate = decisionRecord().candidate;
    candidate.statement = {
      text:
        useCorrection && review?.captureReview?.correctedText
          ? review.captureReview.correctedText
          : statement,
      evidenceIds: [raw.id, ...(useCorrection && review ? [review.id] : [])]
    };
    candidate.modality = "accepted-proposal";
    candidate.decisionMakerPersonIds = ["person_jakob"];
    candidate.acceptanceEvidenceIds = [acceptance.id];
    return { candidate, reconciliation: { action: "create" } };
  };
  const detect = vi.fn(({ source }: { source: DecisionSource }) =>
    Promise.resolve({
      complete: true,
      candidates: [
        {
          confidence: "high" as const,
          interpretation: interpretation(source) as DecisionInterpretation & {
            candidate: NonNullable<DecisionInterpretation["candidate"]>;
          }
        }
      ]
    })
  );
  const interpret = vi.fn(({ source }: { source: DecisionSource }) =>
    Promise.resolve(interpretation(source))
  );
  const synthesis = vi.fn((request: StructuredReasoningRequest<unknown>) =>
    Promise.resolve({
      value: {
        claims: request.evidence.map((item, index) => ({
          key: `claim-${index}`,
          kind: "decision",
          text: "Launch remains a proposal.",
          evidenceIds: [item.evidenceId],
          quotations: [],
          conflictingKeys: [],
          confidence: "medium"
        }))
      } as never,
      metadata: {
        provider: "fixture",
        model: "fixture",
        promptVersion: request.promptVersion
      }
    })
  );
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: { generateStructured: synthesis },
    captureSynthesis: runtime.configuration,
    decisionIntelligence: {
      evidenceSource: source,
      automatic: { evidenceSource: source, detector: { detect } },
      authority: {
        read: () => Promise.resolve(authority),
        requireCurrent: () => Promise.resolve()
      },
      records,
      interpreter: { interpret },
      audience: () => Promise.resolve(audience),
      accessPolicy: {
        authorize: ({ providerUserId }) =>
          Promise.resolve(
            providerUserId === "founder"
              ? {
                  personId: "person_jakob",
                  displayName: "Jakob",
                  discordUserId: "founder",
                  discordUsername: null,
                  githubLogin: null,
                  githubUserId: null,
                  atlassianAccountId: null,
                  notionUserId: null,
                  linearUserId: null,
                  languagePreference: "auto"
                }
              : null
          )
      }
    },
    now: () => new Date(at)
  });
  runtime.connect(mi, createMeetingNotesIngestion({ meetingIntelligence: mi }));
  const events: ProcessedLogicalMeetingSourceEvent[] = [];
  const batches: AutomaticDecisionBatch[] = [];
  let deliver = true;
  let throwDelivery = false;
  const process = (event: ProcessedLogicalMeetingSourceEvent) =>
    mi.observe({
      workspace,
      subject: { type: "meeting", meetingId: event.meetingId },
      observations: [
        {
          type: "decision-source-processed",
          observationId: `processed:${event.contentHash}`
        }
      ]
    });
  runtime.connectProcessedSource(async (event) => {
    events.push(event);
    if (throwDelivery) throw new Error("Durable enqueue unavailable");
    if (deliver) batches.push(await process(event));
  });
  const sync = () => runtime.syncGranolaOnce();
  const query = async () => {
    const result = await mi.query({
      workspaceId: workspace.workspaceId,
      meetingId: events.at(-1)!.meetingId,
      query: { type: "capture-synthesis" }
    });
    if (result.type !== "capture-synthesis" || !result.synthesis)
      throw new Error("Missing synthesis");
    return result.synthesis;
  };
  const review = async (judgment: CaptureSynthesisJudgmentRecorded["judgment"]) => {
    const current = await query();
    return mi.observe({
      workspace,
      observations: [
        {
          type: "capture-synthesis-judgment-recorded",
          observationId: `review:${current.revision}`,
          workspaceId: workspace.workspaceId,
          meetingId: current.logicalMeetingId,
          occurredAt: at,
          observedAt: at,
          participantId: "person_jakob",
          expectedSynthesisRevision: current.revision,
          claimId: current.claims[0]!.id,
          judgment
        }
      ]
    });
  };
  return {
    database,
    runtime,
    source,
    connection,
    savePolicy,
    mi,
    records,
    write,
    detect,
    interpret,
    synthesis,
    events,
    batches,
    audience,
    sync,
    query,
    review,
    process,
    setStatement: (value: string) => {
      statement = value;
    },
    setBody: (value: string) => {
      body = value;
    },
    setAbsent: () => {
      absent = true;
    },
    setReadHook: (value: (() => Promise<void>) | undefined) => {
      readHook = value;
    },
    useAccuracy: () => {
      useAccuracyAcceptance = true;
    },
    useCorrection: () => {
      useCorrection = true;
    },
    stopDelivery: () => {
      deliver = false;
    },
    failDelivery: () => {
      throwDelivery = true;
    },
    resumeDelivery: () => {
      throwDelivery = false;
    }
  };
}

describe("actual Granola / LogicalMeeting Decision source", () => {
  it("automatically considers accepted original provider notes and replays with no model or fabricated Meeting", async () => {
    const f = await fixture();
    expect(await f.sync()).toMatchObject({ failures: [] });
    const batch = f.batches[0]!;
    expect(
      await f.source.resolveMeeting({
        workspaceId: workspace.workspaceId,
        meetingId: f.events[0]!.meetingId,
        audience: f.audience
      })
    ).toBe(f.events[0]!.meetingId);
    expect(
      await f.source.resolveMeeting({
        workspaceId: workspace.workspaceId,
        meetingId: f.events[0]!.meetingId,
        audience: { ...f.audience, personIds: ["guest"] }
      })
    ).toBeNull();
    expect(batch.source.evidence).toHaveLength(1);
    expect(batch.source.evidence[0]).toMatchObject({
      origin: "provider-derived",
      authorPersonId: null
    });
    expect(batch.source.evidence[0]!.text).toContain(
      "Wir könnten nächste Woche starten."
    );
    expect(batch.candidates[0]).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null,
      automatic: { recording: "review-only" }
    });
    expect((await f.database.query("SELECT * FROM meetings")).rows).toHaveLength(0);
    expect(
      (await f.database.query("SELECT * FROM meeting_observations")).rows
    ).toHaveLength(0);
    expect(
      await f.mi.query({
        workspaceId: workspace.workspaceId,
        subject: batch.subject,
        query: { type: "automatic-decision-candidates", batchId: batch.batchId }
      })
    ).toMatchObject({ batchId: batch.batchId });
    expect(
      await f.mi.conclude({
        workspaceId: workspace.workspaceId,
        subject: batch.subject,
        batchId: batch.batchId
      })
    ).toMatchObject({ batch: { batchId: batch.batchId } });
    await f.sync();
    await f.process(f.events[0]!);
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.synthesis).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["revoked", "excluded", "new-opt-in", "removed", "changed"])(
    "withholds %s sources before output or replay, without paid redetection",
    async (mode) => {
      const f = await fixture();
      await f.sync();
      const batch = f.batches[0]!;
      if (mode === "revoked") f.connection.enabled = false;
      if (mode === "excluded") f.connection.excludedMeetingIds = ["work"];
      if (mode === "new-opt-in") f.connection.optInId = "new-consent";
      if (mode === "removed") f.setAbsent();
      if (mode === "changed") f.setBody("Different wording.");
      await f.savePolicy();
      await expect(f.source.requireCurrent(batch.source)).rejects.toThrow();
      expect(
        await f.source.authorizeRetained({ audience: f.audience, source: batch.source })
      ).toBe(false);
      await expect(
        f.mi.query({
          workspaceId: workspace.workspaceId,
          subject: batch.subject,
          query: { type: "automatic-decision-candidates", batchId: batch.batchId }
        })
      ).rejects.toThrow();
      expect(f.detect).toHaveBeenCalledTimes(1);
      expect(f.write).not.toHaveBeenCalled();
    }
  );
  it("retains edited history only after a current admitted revision proves the same original grant", async () => {
    const f = await fixture();
    await f.sync();
    const original = f.batches[0]!.source;
    f.setBody("We should explore another launch date.");
    await f.sync();
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    expect(
      await f.source.authorizeRetained({ audience: f.audience, source: original })
    ).toBe(true);
    expect(
      await f.source.authorizeRetained({
        audience: { ...f.audience, personIds: ["person_jakob"] },
        source: original
      })
    ).toBe(true);
    expect(
      await f.source.authorizeRetained({
        audience: { ...f.audience, personIds: [...f.audience.personIds, "guest"] },
        source: original
      })
    ).toBe(false);
    const forged = structuredClone(original);
    forged.evidence[0]!.text = "Invented words";
    expect(
      await f.source.authorizeRetained({ audience: f.audience, source: forged })
    ).toBe(false);
  });
  it("preserves actual Human accuracy review without granting the confirmer business authority", async () => {
    const f = await fixture();
    await f.sync();
    f.useAccuracy();
    expect(await f.review({ kind: "confirm" })).toMatchObject({ errors: [] });
    const batch = f.batches.at(-1)!;
    expect(batch.source.evidence.find((item) => item.purpose)).toMatchObject({
      origin: "human",
      authorPersonId: "person_jakob",
      purpose: "capture-synthesis-review",
      captureReview: { action: "confirm", reviewedText: "Launch remains a proposal." }
    });
    expect(batch.candidates[0]).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
    expect(batch.candidates[0]!.message).toMatch(/acceptance/);
    expect(f.write).not.toHaveBeenCalled();
    expect(batch.source.evidence[0]).not.toBeUndefined();
    expect(batch.source.evidence.find((item) => !item.purpose)).toEqual(
      f.batches[0]!.source.evidence[0]
    );
  });
  it.each(["reject", "correct"] as const)(
    "keeps %s Human feedback current even when the detector repeats the prior claim",
    async (kind) => {
      const f = await fixture();
      await f.sync();
      const original = f.batches[0]!.source;
      expect(
        await f.review(
          kind === "reject"
            ? { kind }
            : { kind, text: "We are exploring; no launch is scheduled." }
        )
      ).toMatchObject({ errors: [] });
      const candidate = f.batches.at(-1)!.candidates[0]!;
      expect(candidate).toMatchObject({
        state: "needs-clarification",
        approvedIntentId: null,
        candidate: { statement: { text: "Launch remains a proposal." } }
      });
      expect(candidate.message).toContain("Human rejected or corrected");
      await expect(f.source.requireCurrent(original)).rejects.toThrow();
      expect(f.write).not.toHaveBeenCalled();
    }
  );
  it("keeps the Human correction attached to the same material after source revision and paraphrasing", async () => {
    const f = await fixture();
    await f.sync();
    await f.review({
      kind: "correct",
      text: "We are exploring; no launch is scheduled."
    });
    f.setBody("A later provider version still describes a possible launch.");
    f.setStatement("The team will launch soon.");
    await f.sync();
    const batch = f.batches.at(-1)!;
    expect(batch.candidates[0]!.message).toContain("Human rejected or corrected");
    expect(
      batch.source.evidence.find((item) => item.captureReview)?.captureReview?.evidenceIds
    ).toContain(batch.source.evidence.find((item) => !item.purpose)!.id);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("fences a Human review accepted during a current-source read", async () => {
    const f = await fixture();
    await f.sync();
    const original = f.batches[0]!.source;
    f.stopDelivery();
    f.setReadHook(async () => {
      f.setReadHook(undefined);
      await f.review({ kind: "reject" });
    });
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("refuses missing and corrupted original admission receipts without reconstructing permission", async () => {
    const f = await fixture();
    await f.sync();
    const original = f.batches[0]!.source;
    await f.database.query(
      "UPDATE logical_meeting_decision_source_receipts SET receipt_json='{}'"
    );
    expect(
      await f.source.authorizeRetained({ source: original, audience: f.audience })
    ).toBe(false);
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    await f.database.query("DELETE FROM logical_meeting_decision_source_receipts");
    await expect(f.source.requireCurrent(original)).rejects.toThrow();
    expect(
      (await f.database.query("SELECT * FROM logical_meeting_decision_source_receipts"))
        .rows
    ).toHaveLength(0);
  });
  it("allows a separate exact owner's Decision acceptance without manufacturing speech", async () => {
    const f = await fixture();
    await f.sync();
    const batch = f.batches[0]!,
      candidate = batch.candidates[0]!;
    const accepted = await f.mi.observe({
      workspace,
      subject: batch.subject,
      observations: [
        {
          type: "decision-candidate-accepted",
          observationId: "owner-accepts",
          requestId: candidate.requestId,
          actor: { providerId: "discord", providerUserId: "founder" },
          reviewToken: candidate.reviewToken!,
          instruction: "I accept this exact decision and want it recorded."
        }
      ]
    });
    expect(accepted.approvedIntentId).not.toBeNull();
    expect(accepted.source).toEqual(batch.source);
    await createFollowUpExecution({
      database: f.database,
      meetingIntelligence: f.mi
    }).execute({
      workspace,
      subject: batch.subject,
      decisionRequestId: candidate.requestId,
      intentId: accepted.approvedIntentId!
    });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.interpret).not.toHaveBeenCalled();
  });
  it("lets later exact business acceptance override automatic clarification but never a changed candidate", async () => {
    const f = await fixture();
    await f.sync();
    await f.review({ kind: "reject" });
    const batch = f.batches.at(-1)!,
      candidate = batch.candidates[0]!;
    const accepted = await f.mi.observe({
      workspace,
      subject: batch.subject,
      observations: [
        {
          type: "decision-candidate-accepted",
          observationId: "new-business-decision",
          requestId: candidate.requestId,
          actor: { providerId: "discord", providerUserId: "founder" },
          reviewToken: candidate.reviewToken!,
          instruction: "I now accept this exact business decision and want it recorded."
        }
      ]
    });
    expect(accepted.approvedIntentId).not.toBeNull();
    expect(
      accepted.source.evidence.some((item) => item.captureReview?.action === "reject")
    ).toBe(true);
    const changed = structuredClone(accepted.candidate!);
    changed.statement.text = "A different decision that was never accepted.";
    const update = await f.mi.observe({
      workspace,
      subject: batch.subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "changed-after-acceptance",
          requestId: candidate.requestId,
          actor: { providerId: "discord", providerUserId: "founder" },
          candidate: changed,
          reason: "Changed candidate"
        }
      ]
    });
    expect(update).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
    expect(update.message).toMatch(
      /Human rejected or corrected|different exact candidate/
    );
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("retains accepted source after notification failure and retries delivery without new synthesis", async () => {
    const f = await fixture();
    f.failDelivery();
    expect(await f.sync()).toMatchObject({ failures: [expect.anything()] });
    expect(await f.query()).toMatchObject({ revision: 1 });
    expect(f.batches).toHaveLength(0);
    f.resumeDelivery();
    expect(await f.sync()).toMatchObject({ failures: [] });
    expect(f.batches).toHaveLength(1);
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.synthesis).toHaveBeenCalledTimes(1);
  });
  it("does not disclose prior review after original source permission is reissued", async () => {
    const f = await fixture();
    await f.sync();
    await f.review({ kind: "correct", text: "Correction retained privately." });
    const source = f.batches.at(-1)!.source;
    f.connection.optInId = "replacement-consent";
    await f.savePolicy();
    await f.sync();
    await expect(
      f.source.captureProcessed({
        workspace,
        subject: source.subject,
        audience: f.audience
      })
    ).rejects.toThrow();
    expect(await f.source.authorizeRetained({ source, audience: f.audience })).toBe(
      false
    );
  });
});
