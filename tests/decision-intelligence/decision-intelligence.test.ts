import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type {
  CanonicalDecisionRecord,
  DecisionInterpretation,
  DecisionWriteReceipt,
  DecisionWriteStage,
  ObserveDecision
} from "../../src/domain/decision-records.js";
import {
  DecisionWriteNotAppliedError,
  type DecisionRecords
} from "../../src/knowledge/decision-records.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createOpenAIDecisionInterpreter } from "../../src/decision-intelligence/openai-decision-interpreter.js";
import type { DecisionInterpreter } from "../../src/decision-intelligence/ports.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
function fixture() {
  const original = decisionRecord();
  const source = structuredClone(original.source),
    authority = structuredClone(original.authority.snapshot);
  let interpretation: DecisionInterpretation = {
    candidate: structuredClone(original.candidate),
    reconciliation: { action: "create" }
  };
  const records = new Map<string, CanonicalDecisionRecord>(),
    receipts = new Map<string, DecisionWriteReceipt>();
  let version = 0,
    writeMode: "ok" | "unknown-after" | "unknown-before" | "not-applied" = "ok",
    failStage: DecisionWriteStage["type"] | null = null,
    sourceCurrent = true,
    authorityCurrent = true,
    authorized = true,
    complete = true;
  const catalog = () => ({
    id: "canonical",
    revision: decisionDigest([...records.values()]),
    complete,
    records: structuredClone([...records.values()])
  });
  const provider: DecisionRecords = {
    providerId: "notion",
    discover: vi.fn(() => Promise.resolve(catalog())),
    requireCurrent: ({ snapshot }) => {
      if (snapshot.revision !== catalog().revision) throw new Error("catalog changed");
      return Promise.resolve();
    },
    read: ({ recordId }) =>
      Promise.resolve(structuredClone(records.get(recordId) ?? null)),
    findWritten: vi.fn<DecisionRecords["findWritten"]>(({ operationId }) =>
      Promise.resolve(structuredClone(receipts.get(operationId) ?? null))
    ),
    write: vi.fn<DecisionRecords["write"]>(({ stage, operationId }) => {
      const mode = failStage === null || failStage === stage.type ? writeMode : "ok";
      if (mode === "unknown-before") throw new Error("socket timeout");
      if (mode === "not-applied")
        throw new DecisionWriteNotAppliedError("before-send", "refused");
      const content =
        stage.type === "create-record" || stage.type === "amend-record"
          ? stage.record
          : stage.type === "retire-record"
            ? {
                ...stage.target.content,
                status: stage.status,
                supersededBy: stage.successor
              }
            : { ...stage.target.content, status: "active" as const };
      const externalId =
        "target" in stage ? stage.target.reference.externalId : content.id;
      const record: CanonicalDecisionRecord = {
        content: structuredClone(content),
        reference: {
          providerId: "notion",
          objectType: "document",
          externalId,
          url: `https://notion.so/${externalId}`,
          version: String(++version)
        },
        version: String(version)
      };
      records.set(externalId, record);
      const receipt = { record, operationId, observedAt: "2026-09-11T10:00:00Z" };
      receipts.set(operationId, receipt);
      if (mode === "unknown-after") throw new Error("socket timeout");
      return Promise.resolve(structuredClone(receipt));
    })
  };
  const interpret = vi.fn(() => Promise.resolve(structuredClone(interpretation)));
  const configuration = {
    evidenceSource: {
      capture: vi.fn(() => Promise.resolve(structuredClone(source))),
      requireCurrent: () => {
        if (!sourceCurrent) throw new Error("source revoked");
        return Promise.resolve();
      }
    },
    authority: {
      read: () => Promise.resolve(structuredClone(authority)),
      requireCurrent: () => {
        if (!authorityCurrent) throw new Error("authority changed");
        return Promise.resolve();
      }
    },
    interpreter: { interpret },
    records: provider,
    accessPolicy: {
      authorize: () =>
        Promise.resolve(
          authorized
            ? {
                personId: "philipp",
                displayName: "Philipp",
                discordUserId: "requester",
                discordUsername: null,
                githubLogin: null,
                githubUserId: null,
                atlassianAccountId: null,
                notionUserId: null,
                linearUserId: null,
                languagePreference: "auto" as const
              }
            : null
        )
    },
    audience: () => Promise.resolve(structuredClone(source.audience))
  };
  const make = (interpreter?: DecisionInterpreter) => {
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () => Promise.reject(new Error("No Meeting model call"))
      },
      decisionIntelligence: {
        ...configuration,
        ...(interpreter ? { interpreter } : {})
      },
      now: () => new Date("2026-09-11T10:00:00Z")
    });
    return {
      mi,
      execution: createFollowUpExecution({ database, meetingIntelligence: mi })
    };
  };
  const request: ObserveDecision = {
    workspace: { workspaceId: "dayova", timezone: "Europe/Berlin" },
    subject: source.subject,
    observations: [
      {
        type: "decision-record-requested",
        observationId: "request-1",
        actor: { providerId: "discord", providerUserId: "requester" },
        instruction: "Record Jakob's decision that Luma remains internal."
      }
    ]
  };
  const executable = async (current = make()) => {
    const update = await current.mi.observe(request);
    if (!update.approvedIntentId) throw new Error(update.message);
    return {
      current,
      update,
      input: {
        workspace: request.workspace,
        subject: request.subject,
        decisionRequestId: update.requestId,
        intentId: update.approvedIntentId
      }
    };
  };
  const addRecord = () => {
    const content = decisionRecord("previous");
    const record: CanonicalDecisionRecord = {
      content,
      reference: {
        providerId: "notion",
        objectType: "document",
        externalId: "previous",
        url: "https://notion.so/previous",
        version: "old"
      },
      version: "old"
    };
    records.set("previous", record);
    return record;
  };
  return {
    source,
    authority,
    configuration,
    provider,
    records,
    receipts,
    interpret,
    request,
    make,
    executable,
    addRecord,
    setInterpretation: (value: DecisionInterpretation) => {
      interpretation = value;
    },
    candidate: () => structuredClone(original.candidate),
    setWrite: (mode: typeof writeMode, stage: typeof failStage = null) => {
      writeMode = mode;
      failStage = stage;
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
    revokeAuthority: () => {
      authorityCurrent = false;
    },
    revokeActor: () => {
      authorized = false;
    },
    incomplete: () => {
      complete = false;
    }
  };
}
describe("MI-owned first-class Decision Records", () => {
  it.each(["external-page", "canonical-record"])(
    "amends the explicitly selected %s identity through the production interpreter and owned execution",
    async (identity) => {
      const f = fixture();
      const target = f.addRecord();
      const pageId = "63ae3b42-8991-4fbc-981e-3c3cf6b36b3a";
      target.reference.externalId = pageId;
      target.reference.url = `https://notion.so/${pageId}`;
      f.records.delete("previous");
      f.records.set(pageId, target);
      const observation = f.request.observations[0];
      if (observation.type !== "decision-record-requested") throw new Error("fixture");
      observation.targetRecordId =
        identity === "external-page" ? pageId : target.content.id;
      const { relatedWork, implementationEvidence, ...candidate } = f.candidate();
      expect(relatedWork).toEqual([]);
      expect(implementationEvidence).toEqual([]);
      const budget = createAiUsageBudget({ database });
      const model = vi.fn(() =>
        Promise.resolve({
          outputText: JSON.stringify({
            candidate: {
              ...candidate,
              relatedWorkReferenceIds: [],
              implementationReferenceIds: []
            },
            reconciliation: { action: "amend", targetRecordId: target.content.id }
          }),
          model: "gpt-5.6-luna",
          serviceTier: "default",
          status: "completed",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0
          }
        })
      );
      const current = f.make(
        createOpenAIDecisionInterpreter({ budget, client: { create: model } })
      );
      const update = await current.mi.observe(f.request);
      expect(update.state).toBe("confirmed");
      expect(update.approvedIntentId).not.toBeNull();
      expect(f.provider.write).not.toHaveBeenCalled();
      if (!update.approvedIntentId) throw new Error(update.message);
      const executed = await current.execution.execute({
        workspace: f.request.workspace,
        subject: f.request.subject,
        decisionRequestId: update.requestId,
        intentId: update.approvedIntentId
      });
      expect(executed.record.outcome.references).toEqual([
        expect.objectContaining({ externalId: pageId })
      ]);
      expect(f.provider.write).toHaveBeenCalledTimes(1);
      expect(f.records.size).toBe(1);
      expect(f.records.get(pageId)?.content.id).toBe(target.content.id);
      const replay = await current.mi.observe(f.request);
      expect(replay).toMatchObject({ state: "recorded", duplicate: true });
      expect(model).toHaveBeenCalledTimes(1);
      expect((await budget.getStatus("dayova")).requestCount).toBe(1);
    }
  );
  it.each([
    "same-record-alias",
    "explicit-collision",
    "interpreted-collision",
    "retarget"
  ])("resolves both explicit and interpreted target identities: %s", async (scenario) => {
    const f = fixture();
    const target = f.addRecord();
    target.reference.externalId = "original-page";
    f.records.delete("previous");
    f.records.set("original-page", target);
    const observation = f.request.observations[0];
    if (observation.type !== "decision-record-requested") throw new Error("fixture");
    observation.targetRecordId = "previous";
    let interpretedTarget = "original-page";
    if (scenario !== "same-record-alias") {
      const other = structuredClone(target);
      other.content.id = scenario === "explicit-collision" ? "original-page" : "other";
      other.reference.externalId =
        scenario === "interpreted-collision" ? "previous" : "other-page";
      other.reference.url = `https://notion.so/${other.reference.externalId}`;
      f.records.set("other-key", other);
      observation.targetRecordId =
        scenario === "explicit-collision" || scenario === "interpreted-collision"
          ? "original-page"
          : "previous";
      interpretedTarget = scenario === "retarget" ? "other" : "previous";
    }
    f.setInterpretation({
      candidate: f.candidate(),
      reconciliation: { action: "amend", targetRecordId: interpretedTarget }
    });
    const update = await f.make().mi.observe(f.request);
    expect(update.state).toBe(
      scenario === "same-record-alias" ? "confirmed" : "needs-clarification"
    );
    if (scenario !== "same-record-alias") expect(update.approvedIntentId).toBeNull();
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("preserves a definitive pre-write refusal in status instead of reporting unknown remote work", async () => {
    const f = fixture(),
      e = await f.executable();
    f.setWrite("not-applied");
    await e.current.execution.execute(e.input);
    const status = await f.make().mi.query({
      workspaceId: "dayova",
      subject: f.request.subject,
      query: { type: "decision-request", requestId: "request-1" }
    });
    expect(status.state).toBe("confirmed");
    expect(status.execution?.outcome).toMatchObject({
      status: "failed",
      requiresManualRecovery: false,
      references: []
    });
  });
  it("commits a Human correction and its idempotency observation atomically", async () => {
    const f = fixture(),
      e = await f.executable();
    const correction: ObserveDecision = {
      workspace: f.request.workspace,
      subject: f.request.subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "atomic-correction",
          requestId: "request-1",
          actor: { providerId: "discord", providerUserId: "requester" },
          candidate: { ...f.candidate(), disposition: "pause" },
          reason: "corrected-pause"
        }
      ]
    };
    await database.exec(
      `ALTER TABLE decision_requests ADD CONSTRAINT simulated_head_fault CHECK(payload_json NOT LIKE '%corrected-pause%')`
    );
    await expect(e.current.mi.observe(correction)).rejects.toThrow();
    expect(
      (
        await database.query(
          `SELECT observation_id FROM decision_observations WHERE observation_id='atomic-correction'`
        )
      ).rows
    ).toHaveLength(0);
    await database.exec(
      `ALTER TABLE decision_requests DROP CONSTRAINT simulated_head_fault`
    );
    const accepted = await e.current.mi.observe(correction);
    expect(accepted.candidate?.disposition).toBe("pause");
    expect(accepted.approvedIntentId).not.toBe(e.input.intentId);
    expect((await e.current.mi.observe(correction)).duplicate).toBe(true);
  });
  it("withholds a stale request head when Human correction lands during the final source proof", async () => {
    const f = fixture(),
      e = await f.executable();
    let correcting = false;
    f.configuration.evidenceSource.requireCurrent = async () => {
      if (correcting) return;
      correcting = true;
      await e.current.mi.observe({
        workspace: f.request.workspace,
        subject: f.request.subject,
        observations: [
          {
            type: "decision-candidate-corrected",
            observationId: "racing-correction",
            requestId: "request-1",
            actor: { providerId: "discord", providerUserId: "requester" },
            candidate: { ...f.candidate(), disposition: "pause" },
            reason: "Pause was intended"
          }
        ]
      });
    };
    await expect(
      e.current.mi.query({
        workspaceId: "dayova",
        subject: f.request.subject,
        query: { type: "decision-request", requestId: "request-1" }
      })
    ).rejects.toThrow("Decision state changed");
    expect(
      (
        await e.current.mi.query({
          workspaceId: "dayova",
          subject: f.request.subject,
          query: { type: "decision-request", requestId: "request-1" }
        })
      ).candidate?.disposition
    ).toBe("pause");
  });
  it.each(["budget-exhausted", "provider-quota", "rate-limited", "timeout"] as const)(
    "retains visible safe %s status without repeating paid interpretation",
    async (code) => {
      const f = fixture();
      f.interpret.mockRejectedValueOnce(
        new AiServiceError(code, "private-provider-payload", {
          resetAt: "2026-10-01T00:00:00Z"
        })
      );
      const state = await f.make().mi.observe(f.request);
      expect(state.state).toBe("needs-clarification");
      expect(state.message).not.toContain("private-provider-payload");
      expect(state.message).toMatch(/budget|quota|rate limiting|timed out/u);
      expect((await f.make().mi.observe(f.request)).message).toBe(state.message);
      expect(f.interpret).toHaveBeenCalledTimes(1);
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("uses canonical original speech for an actual Meeting, with an explicit original/current audience grant", async () => {
    const f = fixture();
    let grant = "original-grant";
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: { generateStructured: () => Promise.reject(new Error("deferred")) },
      decisionIntelligence: {
        ...f.configuration,
        meetingSourceAudience: {
          requireCurrent: () => Promise.resolve({ grantId: grant })
        },
        interpreter: {
          interpret: ({ source }) => {
            const speech = source.evidence.find(
              (item) => item.reference.source === "transcript"
            );
            if (!speech) throw new Error("missing speech");
            return Promise.resolve({
              candidate: {
                ...f.candidate(),
                statement: { text: speech.text, evidenceIds: [speech.id] },
                acceptanceEvidenceIds: [speech.id]
              },
              reconciliation: { action: "create" }
            });
          }
        }
      }
    });
    const base = {
      workspaceId: "dayova",
      meetingId: "real-meeting",
      occurredAt: "2026-09-11T10:00:00Z",
      observedAt: "2026-09-11T10:00:00Z"
    };
    await mi.observe({
      workspace: f.request.workspace,
      observations: [
        {
          ...base,
          type: "meeting-started",
          observationId: "start",
          title: "Founders",
          startedAt: base.occurredAt,
          languageMode: "multilingual",
          participantIds: ["jakob", "philipp"]
        },
        {
          ...base,
          type: "utterance-committed",
          observationId: "speech",
          utteranceId: "utterance-1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: base.occurredAt,
          endedAt: base.occurredAt,
          originalText: "Luma bleibt intern bei uns vier Gründern.",
          language: "de"
        }
      ]
    });
    const subject = { type: "meeting" as const, meetingId: "real-meeting" };
    const update = await mi.observe({ ...f.request, subject });
    expect(update.state).toBe("confirmed");
    expect(update.source.evidence[0]).toMatchObject({
      text: "Luma bleibt intern bei uns vier Gründern.",
      authorPersonId: "jakob",
      origin: "human"
    });
    expect(f.configuration.evidenceSource.capture).not.toHaveBeenCalled();
    expect((await database.query(`SELECT meeting_id FROM meetings`)).rows).toEqual([
      { meeting_id: "real-meeting" }
    ]);
    grant = "a-different-grant";
    await expect(
      mi.query({
        workspaceId: "dayova",
        subject,
        query: { type: "decision-request", requestId: "request-1" }
      })
    ).rejects.toThrow("no longer current");
  });
  it("does not infer a Meeting reader grant from attendance or substitute the Conversation source", async () => {
    const f = fixture();
    await expect(
      f.make().mi.observe({
        ...f.request,
        subject: { type: "meeting", meetingId: "ungranted-meeting" }
      })
    ).rejects.toThrow("audience is not configured");
    expect(f.configuration.evidenceSource.capture).not.toHaveBeenCalled();
    expect(f.interpret).not.toHaveBeenCalled();
  });
  it("verifies an existing identical record without mutating it, and refuses to link a different decision", async () => {
    const f = fixture();
    f.addRecord();
    f.setInterpretation({
      candidate: f.candidate(),
      reconciliation: { action: "link", targetRecordId: "previous" }
    });
    const e = await f.executable();
    expect((await e.current.execution.execute(e.input)).record.outcome).toMatchObject({
      status: "succeeded",
      references: [{ externalId: "previous" }]
    });
    expect(f.provider.write).not.toHaveBeenCalled();
    f.request.observations[0] = {
      ...f.request.observations[0],
      observationId: "different"
    };
    f.setInterpretation({
      candidate: {
        ...f.candidate(),
        statement: { text: "Another decision", evidenceIds: ["source-1"] }
      },
      reconciliation: { action: "link", targetRecordId: "previous" }
    });
    expect((await f.make().mi.observe(f.request)).approvedIntentId).toBeNull();
  });
  it("records another evidenced owner's decision, preserves sources, and replays a duplicate without another model or write", async () => {
    const f = fixture(),
      e = await f.executable();
    expect(e.update.state).toBe("confirmed");
    const result = await e.current.execution.execute(e.input);
    expect(result.record.outcome.status).toBe("succeeded");
    const restarted = f.make();
    const replay = await restarted.mi.observe(f.request);
    expect(replay.state).toBe("recorded");
    expect(replay.duplicate).toBe(true);
    await restarted.execution.execute(e.input);
    expect(f.interpret).toHaveBeenCalledTimes(1);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    const content = [...f.records.values()][0]!.content;
    expect(content.authority.decisionMakerPersonIds).toEqual(["jakob"]);
    expect(content.source).toEqual(f.source);
    expect(
      (
        await restarted.mi.conclude({
          workspaceId: "dayova",
          subject: f.request.subject,
          requestId: "request-1"
        })
      ).request.state
    ).toBe("recorded");
  });
  it.each(["proposal", "preference", "open-question", "historical", "unknown"] as const)(
    "does not promote %s modality",
    async (modality) => {
      const f = fixture();
      f.setInterpretation({
        candidate: { ...f.candidate(), modality },
        reconciliation: { action: "create" }
      });
      expect((await f.make().mi.observe(f.request)).state).toBe("needs-clarification");
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("does not derive owner acceptance from native poll tallies or a provider summary", async () => {
    const f = fixture();
    f.source.evidence[0]!.origin = "poll";
    expect((await f.make().mi.observe(f.request)).approvedIntentId).toBeNull();
  });
  it("requires current unambiguous authority instead of provisional job titles", async () => {
    const f = fixture();
    f.authority.grants[0]!.kind = "provisional-role";
    f.authority.grants[0]!.standing = "provisional";
    expect((await f.make().mi.observe(f.request)).state).toBe("needs-clarification");
  });
  it("honors an explicitly evidenced delegation over its delegator's general project ownership", async () => {
    const f = fixture();
    f.authority.grants.push({
      ...f.authority.grants[0]!,
      id: "delegation",
      personId: "philipp",
      kind: "delegation",
      delegatedBy: "jakob"
    });
    f.source.evidence[0]!.authorPersonId = "philipp";
    f.source.evidence[0]!.reference.participantId = "philipp";
    f.setInterpretation({
      candidate: { ...f.candidate(), decisionMakerPersonIds: ["philipp"] },
      reconciliation: { action: "create" }
    });
    expect((await f.make().mi.observe(f.request)).state).toBe("confirmed");
  });
  it("does not treat a stakeholder's mere presence as evidenced consultation about the decision", async () => {
    const f = fixture();
    f.authority.grants[0]!.consultedPersonIds = ["philipp"];
    f.source.evidence.push({
      ...f.source.evidence[0]!,
      id: "greeting",
      reference: {
        ...f.source.evidence[0]!.reference,
        evidenceId: "greeting",
        participantId: "philipp"
      },
      text: "Hallo",
      authorPersonId: "philipp"
    });
    expect((await f.make().mi.observe(f.request)).state).toBe("needs-clarification");
  });
  it.each(["duplicate-content-id", "cross-identity"] as const)(
    "refuses an ambiguous %s canonical target",
    async (kind) => {
      const f = fixture(),
        original = f.addRecord();
      f.records.set("second", {
        ...structuredClone(original),
        content: {
          ...structuredClone(original.content),
          id: kind === "duplicate-content-id" ? "previous" : "second"
        },
        reference: {
          ...original.reference,
          externalId: kind === "cross-identity" ? "previous" : "second",
          url: "https://notion.so/second"
        }
      });
      if (kind === "cross-identity") {
        f.records.get("previous")!.reference.externalId = "first-page";
      }
      f.setInterpretation({
        candidate: f.candidate(),
        reconciliation: { action: "link", targetRecordId: "previous" }
      });
      expect((await f.make().mi.observe(f.request)).state).toBe("needs-clarification");
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("preserves inherited supersession history when amending an active successor", async () => {
    const f = fixture(),
      original = f.addRecord();
    original.content.supersedes = [
      {
        providerId: "notion",
        objectType: "document",
        externalId: "older",
        url: "https://notion.so/older",
        version: "historic"
      }
    ];
    f.setInterpretation({
      candidate: f.candidate(),
      reconciliation: { action: "amend", targetRecordId: "previous" }
    });
    const e = await f.executable();
    expect((await e.current.execution.execute(e.input)).record.outcome.status).toBe(
      "succeeded"
    );
    expect(f.records.get("previous")!.content.supersedes).toEqual(
      original.content.supersedes
    );
  });
  it.each(["revokeSource", "revokeAuthority"] as const)(
    "rechecks %s after the durable pre-send claim",
    async (revoke) => {
      const f = fixture(),
        e = await f.executable();
      const realQuery = database.query.bind(database);
      const spy = vi
        .spyOn(database, "query")
        .mockImplementation(async (sql, params, options) => {
          const result = await realQuery(sql, params, options);
          if (
            sql.startsWith("INSERT INTO decision_requests") &&
            JSON.stringify(params).includes("decision-write-in-progress")
          )
            f[revoke]();
          return result;
        });
      await expect(e.current.execution.execute(e.input)).rejects.toThrow();
      expect(f.provider.write).not.toHaveBeenCalled();
      spy.mockRestore();
      const stage = (
        await database.query<{ payload_json: string }>(
          `SELECT payload_json FROM decision_write_stages`
        )
      ).rows[0]!;
      expect(JSON.parse(stage.payload_json)).toMatchObject({ state: "not-applied" });
    }
  );
  it("refuses unsupported details and mismatched explicit canonical targets", async () => {
    const f = fixture();
    f.setInterpretation({
      candidate: {
        ...f.candidate(),
        rationale: [{ text: "Cheaper", evidenceIds: ["invented"] }]
      },
      reconciliation: { action: "create" }
    });
    expect((await f.make().mi.observe(f.request)).approvedIntentId).toBeNull();
    const another = f.request;
    another.observations[0] = {
      ...another.observations[0],
      type: "decision-record-requested",
      observationId: "request-2",
      instruction: "Update the selected record",
      targetRecordId: "selected"
    };
    f.setInterpretation({
      candidate: f.candidate(),
      reconciliation: { action: "create" }
    });
    expect((await f.make().mi.observe(another)).approvedIntentId).toBeNull();
  });
  it("does not run paid interpretation when canonical discovery is incomplete", async () => {
    const f = fixture();
    f.incomplete();
    expect((await f.make().mi.observe(f.request)).state).toBe("needs-clarification");
    expect(f.interpret).not.toHaveBeenCalled();
  });
  it.each(["revokeSource", "revokeAuthority", "revokeActor"] as const)(
    "withholds execution and query after %s",
    async (revoke) => {
      const f = fixture(),
        e = await f.executable();
      f[revoke]();
      await expect(e.current.execution.execute(e.input)).rejects.toThrow();
      await expect(
        e.current.mi.query({
          workspaceId: "dayova",
          subject: f.request.subject,
          query: { type: "decision-request", requestId: "request-1" }
        })
      ).rejects.toThrow();
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("retains unknown outcome after a lost response and recovers positive evidence without a second write", async () => {
    const f = fixture(),
      e = await f.executable();
    f.setWrite("unknown-after");
    const first = await e.current.execution.execute(e.input);
    expect(first.record.outcome).toMatchObject({
      status: "failed",
      requiresManualRecovery: true
    });
    const restarted = f.make();
    await restarted.execution.execute(e.input);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    const recovered = await restarted.execution.recover(e.input);
    expect(recovered.record.outcome.status).toBe("succeeded");
    expect(f.provider.write).toHaveBeenCalledTimes(1);
  });
  it("never retries an uncertain absent write and fences other canonical mutations", async () => {
    const f = fixture(),
      e = await f.executable();
    f.setWrite("unknown-before");
    await e.current.execution.execute(e.input);
    expect((await f.make().execution.recover(e.input)).record.outcome).toMatchObject({
      status: "failed",
      requiresManualRecovery: true
    });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    f.request.observations[0] = {
      ...f.request.observations[0],
      observationId: "new-request"
    };
    const second = await f.executable();
    await expect(second.current.execution.execute(second.input)).rejects.toThrow(
      "prior Decision write"
    );
    expect(f.provider.write).toHaveBeenCalledTimes(1);
  });
  it("creates pending successor, retires predecessor, then activates successor, retaining partial references across restart", async () => {
    const f = fixture();
    f.addRecord();
    f.setInterpretation({
      candidate: {
        ...f.candidate(),
        statement: {
          text: "Luma may be used by approved support staff.",
          evidenceIds: ["source-1"]
        }
      },
      reconciliation: { action: "supersede", targetRecordId: "previous" }
    });
    const e = await f.executable();
    f.setWrite("not-applied", "retire-record");
    const partial = await e.current.execution.execute(e.input);
    expect(partial.record.outcome).toMatchObject({
      status: "failed",
      requiresManualRecovery: true,
      references: [expect.anything()]
    });
    expect([...f.records.values()].map((record) => record.content.status).sort()).toEqual(
      ["active", "pending"]
    );
    f.setWrite("ok");
    const resumed = await f.make().execution.recover(e.input);
    expect(resumed.record.outcome.status).toBe("succeeded");
    expect(f.records.get("previous")!.content.status).toBe("superseded");
    expect(
      [...f.records.values()].filter((record) => record.content.status === "active")
    ).toHaveLength(1);
    expect(
      [...f.records.values()].find((record) => record.content.id !== "previous")!.content
        .supersedes[0]!.externalId
    ).toBe("previous");
    const writes = vi
      .mocked(f.provider.write)
      .mock.calls.map(([call]) => call.stage.type);
    expect(writes).toEqual([
      "create-record",
      "retire-record",
      "retire-record",
      "activate-record"
    ]);
  });
  it("does not silently replace an observation ID or an explicit Human correction", async () => {
    const f = fixture(),
      e = await f.executable();
    const changed = structuredClone(f.request);
    changed.observations[0] = {
      ...changed.observations[0],
      type: "decision-record-requested",
      instruction: "Record a different decision"
    };
    await expect(e.current.mi.observe(changed)).rejects.toThrow("immutable");
    const corrected = await e.current.mi.observe({
      workspace: f.request.workspace,
      subject: f.request.subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "correction-1",
          requestId: "request-1",
          actor: { providerId: "discord", providerUserId: "requester" },
          candidate: { ...f.candidate(), disposition: "pause" },
          reason: "This was a pause decision."
        }
      ]
    });
    expect(corrected.approvedIntentId).not.toBe(e.input.intentId);
    await expect(e.current.execution.execute(e.input)).rejects.toThrow(
      "canonical approved"
    );
    expect(f.interpret).toHaveBeenCalledTimes(1);
    const history = await database.query(
      `SELECT payload_json FROM decision_request_revisions WHERE workspace_id='dayova' AND request_id='request-1'`
    );
    expect(history.rows.length).toBeGreaterThanOrEqual(3);
  });
  it("retains readable known references when successor activation succeeds but its response is lost", async () => {
    const f = fixture();
    f.addRecord();
    f.setInterpretation({
      candidate: {
        ...f.candidate(),
        statement: { text: "A replacement decision", evidenceIds: ["source-1"] }
      },
      reconciliation: { action: "supersede", targetRecordId: "previous" }
    });
    const e = await f.executable();
    f.setWrite("unknown-after", "activate-record");
    await e.current.execution.execute(e.input);
    const status = await f.make().mi.query({
      workspaceId: "dayova",
      subject: f.request.subject,
      query: { type: "decision-request", requestId: "request-1" }
    });
    expect(status.state).toBe("unknown");
    expect(status.execution?.outcome.references).toHaveLength(2);
    expect((await f.make().execution.recover(e.input)).record.outcome.status).toBe(
      "succeeded"
    );
    expect(f.provider.write).toHaveBeenCalledTimes(3);
  });
  it("projects durable stage uncertainty and known references when an outer execution receipt is missing after a crash", async () => {
    const f = fixture(),
      e = await f.executable();
    f.setWrite("unknown-after");
    await e.current.execution.execute(e.input);
    // Reproduce the persistence boundary: the immutable stage survived, but the
    // outer receipt did not. The integrity binding remains valid.
    const row = (
      await database.query<{ payload_json: string }>(
        `SELECT payload_json FROM decision_requests WHERE workspace_id='dayova' AND request_id='request-1'`
      )
    ).rows[0]!;
    const stored: unknown = JSON.parse(row.payload_json);
    if (
      !stored ||
      typeof stored !== "object" ||
      !("state" in stored) ||
      !stored.state ||
      typeof stored.state !== "object"
    )
      throw new Error("fixture state");
    Object.assign(stored.state, { execution: null, state: "confirmed" });
    await database.query(
      `UPDATE decision_requests SET payload_json=$1,payload_hash=$2 WHERE workspace_id='dayova' AND request_id='request-1'`,
      [JSON.stringify(stored), decisionDigest(stored)]
    );
    const status = await f.make().mi.query({
      workspaceId: "dayova",
      subject: f.request.subject,
      query: { type: "decision-request", requestId: "request-1" }
    });
    expect(status.state).toBe("unknown");
    expect(status.execution?.outcome).toMatchObject({ requiresManualRecovery: true });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
  });
});
