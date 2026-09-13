import { handleDiscordDecisionRecordCommand } from "../../src/discord/discord-decision-record-runtime.js";
import { createAutomaticDecisionProcessing } from "../../src/app/automatic-decision-processing.js";
import {
  standingFixture,
  audience as permissionAudience
} from "./standing-permission-fixture.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createOpenAIAutomaticDecisionDetector } from "../../src/decision-intelligence/openai-decision-interpreter.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type {
  AutomaticDecisionDetection,
  DecisionStandingGrant,
  ObserveProcessedDecisionSource
} from "../../src/domain/automatic-decisions.js";
import type {
  CanonicalDecisionRecord,
  DecisionWriteReceipt
} from "../../src/domain/decision-records.js";
import type { DecisionIntelligenceConfiguration } from "../../src/decision-intelligence/decision-intelligence.js";
import type { DecisionRecords } from "../../src/knowledge/decision-records.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
function fixture() {
  let currentTime = "2026-09-11T10:00:00Z";
  const now = () => new Date(currentTime);
  const original = decisionRecord(),
    source = structuredClone(original.source),
    authority = structuredClone(original.authority.snapshot);
  const records = new Map<string, CanonicalDecisionRecord>(),
    receipts = new Map<string, DecisionWriteReceipt>();
  let detection: AutomaticDecisionDetection = {
    complete: true,
    candidates: [
      {
        confidence: "high",
        interpretation: {
          candidate: structuredClone(original.candidate),
          reconciliation: { action: "create" }
        }
      }
    ]
  };
  let enabled = false,
    policyCurrent = true,
    sourceCurrent = true,
    authorityCurrent = true,
    authorityAvailable = true,
    catalogAvailable = true,
    complete = true,
    mode: "ok" | "unknown-before" | "unknown-after" = "ok";
  const audience = structuredClone(source.audience);
  const grant: DecisionStandingGrant = {
    id: "record-luma",
    revision: "policy-v1",
    contentHash: "policy-hash",
    source: {
      providerId: "discord",
      objectType: "comment",
      externalId: "standing-instruction",
      url: "https://discord.com/channels/1/2/4"
    },
    audience: structuredClone(audience),
    purpose: "automatic-decision-recording",
    authorizedBy: "jakob",
    actor: { providerId: "discord", providerUserId: "jakob-user" },
    instruction: "Luma may automatically record my clear final Luma decisions.",
    evidence: {
      evidenceId: "standing-instruction",
      source: "human-judgment",
      sourceObjectId: "standing-instruction",
      participantId: "jakob",
      sourceVersion: "policy-v1",
      excerpt: "Luma may automatically record my clear final Luma decisions.",
      externalReference: {
        providerId: "discord",
        objectType: "comment",
        externalId: "standing-instruction",
        url: "https://discord.com/channels/1/2/4"
      }
    },
    scopeId: "luma",
    actions: ["create", "link", "amend", "supersede", "reverse"],
    modalities: ["final-decision", "accepted-proposal", "reversal"],
    dispositions: ["adopt", "pause", "discard"],
    validFrom: "2026-09-11T00:00:00Z",
    validUntil: null
  };
  const catalog = () => ({
    id: "decisions",
    revision: decisionDigest([...records.values()]),
    complete,
    records: structuredClone([...records.values()])
  });
  const provider: DecisionRecords = {
    providerId: "notion",
    discover: vi.fn(() => {
      if (!catalogAvailable) throw new Error("private outage");
      return Promise.resolve(catalog());
    }),
    requireCurrent: ({ snapshot }) => {
      if (snapshot.revision !== catalog().revision) throw new Error("catalog changed");
      return Promise.resolve();
    },
    read: ({ recordId }) => Promise.resolve(records.get(recordId) ?? null),
    readReference: ({ reference }) =>
      Promise.resolve(records.get(reference.externalId) ?? null),
    findWritten: vi.fn<DecisionRecords["findWritten"]>(({ operationId }) =>
      Promise.resolve(receipts.get(operationId) ?? null)
    ),
    write: vi.fn<DecisionRecords["write"]>(({ stage, operationId }) => {
      if (mode === "unknown-before") throw new Error("timeout");
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
          version: operationId
        },
        version: operationId
      };
      records.set(externalId, record);
      const receipt = { record, operationId, observedAt: "2026-09-11T10:00:00Z" };
      receipts.set(operationId, receipt);
      if (mode === "unknown-after") throw new Error("timeout");
      return Promise.resolve(receipt);
    })
  };
  const captureProcessed = vi.fn(() => Promise.resolve(structuredClone(source)));
  const requireSource = vi.fn(() => {
    if (!sourceCurrent) throw new Error("source revoked");
    return Promise.resolve();
  });
  const detect = vi.fn(() => Promise.resolve(structuredClone(detection)));
  const configuration: DecisionIntelligenceConfiguration = {
    evidenceSource: {
      capture: () => {
        throw new Error(
          "Explicit source capture must not be used for automatic processing"
        );
      },
      requireCurrent: requireSource
    },
    authority: {
      read: () => {
        if (!authorityAvailable) throw new Error("authority unavailable");
        return Promise.resolve(structuredClone(authority));
      },
      requireCurrent: () => {
        if (!authorityCurrent) throw new Error("authority revoked");
        return Promise.resolve();
      }
    },
    interpreter: {
      interpret: () => {
        throw new Error("Explicit interpretation must not rerun");
      }
    },
    records: provider,
    accessPolicy: {
      authorize: ({ providerUserId }) =>
        Promise.resolve(
          providerUserId === "jakob-user"
            ? {
                personId: "jakob",
                displayName: "Jakob",
                discordUserId: "jakob-user",
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
    },
    audience: () => Promise.resolve(structuredClone(audience)),
    automatic: {
      evidenceSource: { captureProcessed, requireCurrent: requireSource },
      detector: { detect },
      policy: {
        read: () => Promise.resolve(enabled ? [structuredClone(grant)] : []),
        requireCurrent: () => {
          if (!policyCurrent) throw new Error("standing grant revoked");
          return Promise.resolve();
        }
      }
    }
  };
  const request: ObserveProcessedDecisionSource = {
    workspace: { workspaceId: "dayova", timezone: "Europe/Berlin" },
    subject: source.subject,
    observations: [{ type: "decision-source-processed", observationId: "processed-1" }]
  };
  const make = () =>
    createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () => Promise.reject(new Error("No Meeting model call"))
      },
      decisionIntelligence: configuration,
      now
    });
  const addRecord = () => {
    const content = decisionRecord("prior");
    const value: CanonicalDecisionRecord = {
      content,
      reference: {
        providerId: "notion",
        objectType: "document",
        externalId: "prior",
        url: "https://notion.so/prior",
        version: "v1"
      },
      version: "v1"
    };
    records.set("prior", value);
    return value;
  };
  return {
    now,
    setTime: (value: string) => {
      currentTime = value;
    },
    source,
    authority,
    audience,
    grant,
    configuration,
    request,
    make,
    detect,
    captureProcessed,
    requireSource,
    records,
    provider,
    receipts,
    addRecord,
    get detection() {
      return detection;
    },
    setDetection: (value: AutomaticDecisionDetection) => {
      detection = value;
    },
    enable: () => {
      enabled = true;
    },
    revokePolicy: () => {
      policyCurrent = false;
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
    revokeAuthority: () => {
      authorityCurrent = false;
    },
    missingAuthority: () => {
      authorityAvailable = false;
    },
    missingCatalog: () => {
      catalogAvailable = false;
    },
    incompleteCatalog: () => {
      complete = false;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    }
  };
}
describe("automatic Decision candidates through Meeting Intelligence", () => {
  it("retains a high-confidence clear candidate, independent authority and review-only default across restart", async () => {
    const f = fixture(),
      first = await f.make().observe(f.request);
    expect(first).toMatchObject({
      status: "completed",
      complete: true,
      candidates: [
        {
          state: "candidate",
          approvedIntentId: null,
          automatic: {
            confidence: "high",
            authority: "verified",
            recording: "review-only"
          }
        }
      ]
    });
    expect(first.candidates[0]!.source).toEqual(f.source);
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(
      await f.make().conclude({
        workspaceId: "dayova",
        subject: f.request.subject,
        batchId: first.batchId
      })
    ).toMatchObject({ batch: { batchId: first.batchId } });
    expect((await f.make().observe(f.request)).duplicate).toBe(true);
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it.each([
    "proposal",
    "preference",
    "open-question",
    "tentative-direction",
    "rejected-option",
    "historical"
  ] as const)("does not promote %s even with a standing policy", async (modality) => {
    const f = fixture();
    f.enable();
    f.detection.candidates[0]!.interpretation.candidate.modality = modality;
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]!.approvedIntentId).toBeNull();
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("blocks tentative source wording even if the model incorrectly labels it final", async () => {
    const f = fixture();
    f.enable();
    f.source.evidence[0]!.text = "We should probably use Luma for customers.";
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]!.message).toContain("Tentative");
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("records a permitted clear owner decision once and duplicate processing does not rerun AI or resend", async () => {
    const f = fixture();
    f.enable();
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]).toMatchObject({
      state: "recorded",
      automatic: { recording: "standing-policy" },
      execution: { outcome: { status: "succeeded" } }
    });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.make().observe({
          ...f.request,
          observations: [
            { type: "decision-source-processed", observationId: "processed-again" }
          ]
        })
      ).duplicate
    ).toBe(true);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it("links an equivalent existing record without a duplicate provider mutation", async () => {
    const f = fixture();
    f.enable();
    f.addRecord();
    f.detection.candidates[0]!.interpretation.reconciliation = {
      action: "link",
      targetRecordId: "prior"
    };
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]).toMatchObject({
      state: "recorded",
      execution: {
        outcome: { status: "succeeded", references: [{ externalId: "prior" }] }
      }
    });
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("retains an explicit successor proposal and active contradiction as separate review needs", async () => {
    const f = fixture();
    f.addRecord();
    f.detection.candidates[0]!.interpretation.candidate.statement.text =
      "Luma should now be available to selected partners.";
    f.detection.candidates[0]!.interpretation.reconciliation = {
      action: "supersede",
      targetRecordId: "prior"
    };
    let result = await f.make().observe(f.request);
    expect(result.candidates[0]!.automatic?.reconciliation).toEqual({
      action: "supersede",
      targetRecordId: "prior"
    });
    expect(f.provider.write).not.toHaveBeenCalled();
    f.source.contentHash = "new";
    f.source.authorizationHash = "new";
    f.detection.candidates[0]!.interpretation.reconciliation = {
      action: "clarify",
      reason:
        "This contradicts the active internal-only decision without explicit supersession."
    };
    result = await f.make().observe({
      ...f.request,
      observations: [
        { type: "decision-source-processed", observationId: "processed-correction" }
      ]
    });
    expect(result.candidates[0]).toMatchObject({
      state: "needs-clarification",
      approvedIntentId: null
    });
  });
  it.each(["authority", "catalog", "partial"])(
    "keeps candidates reviewable with unavailable %s",
    async (kind) => {
      const f = fixture();
      f.enable();
      if (kind === "authority") f.missingAuthority();
      else if (kind === "catalog") f.missingCatalog();
      else f.incompleteCatalog();
      const result = await f.make().observe(f.request);
      expect(result.complete).toBe(false);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.approvedIntentId).toBeNull();
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("withholds every write for incomplete candidate detection", async () => {
    const f = fixture();
    f.enable();
    f.detection.complete = false;
    const result = await f.make().observe(f.request);
    expect(result.complete).toBe(false);
    expect(result.candidates[0]!.message).toContain("incomplete");
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it.each(["poll", "provider-derived"] as const)(
    "never treats %s acceptance as Human authority",
    async (origin) => {
      const f = fixture();
      f.enable();
      f.source.evidence[0]!.origin = origin;
      const result = await f.make().observe(f.request);
      expect(result.candidates[0]!.automatic?.authority).toBe("unresolved");
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it.each(["provisional-role", "confirmed-scope"] as const)(
    "does not let a %s title or conflicting owner grant supply authority",
    async (kind) => {
      const f = fixture();
      f.enable();
      f.authority.grants[0]!.kind = kind;
      f.authority.grants[0]!.personId = "fabius";
      const result = await f.make().observe(f.request);
      expect(result.candidates[0]!.approvedIntentId).toBeNull();
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it.each(["scope", "actor", "expired", "audience", "evidence", "action"])(
    "denies a standing policy with an invalid %s proof",
    async (kind) => {
      const f = fixture();
      f.enable();
      if (kind === "scope") f.grant.scopeId = "finance";
      if (kind === "actor") f.grant.actor.providerUserId = "outsider";
      if (kind === "expired") f.grant.validUntil = "2026-09-11T09:00:00Z";
      if (kind === "audience") f.grant.audience.personIds.push("guest");
      if (kind === "evidence") f.grant.evidence.source = "external-activity";
      if (kind === "action") f.grant.actions = ["amend"];
      await f.make().observe(f.request);
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("does not automatically retry an unknown write across restart; explicit recovery uses positive receipts", async () => {
    const f = fixture();
    f.enable();
    f.setMode("unknown-after");
    const first = await f.make().observe(f.request);
    const candidate = first.candidates[0]!;
    expect(candidate.state).toBe("unknown");
    await f.make().observe(f.request);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    const mi = f.make(),
      execution = createFollowUpExecution({ database, meetingIntelligence: mi });
    f.setMode("ok");
    await execution.recover({
      workspace: f.request.workspace,
      subject: f.request.subject,
      decisionRequestId: candidate.requestId,
      intentId: candidate.approvedIntentId!
    });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect(f.provider.findWritten).toHaveBeenCalledTimes(1);
  });
  it("checks standing policy again after stage claim and before dispatch", async () => {
    const f = fixture();
    f.enable();
    const query = database.query.bind(database);
    database.query = async <T>(...args: Parameters<LumaDatabase["query"]>) => {
      const [statement, parameters] = args;
      const result = await query<T>(...args);
      if (
        statement.includes("INSERT INTO decision_write_stages") &&
        parameters?.some(
          (value) => typeof value === "string" && value.includes('"state":"executing"')
        )
      )
        f.revokePolicy();
      return result;
    };
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]).toMatchObject({
      candidate: null,
      approvedIntentId: null,
      state: "needs-clarification"
    });
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("source or audience revocation after detection prevents any external write and disclosure", async () => {
    const f = fixture();
    f.enable();
    f.detect.mockImplementationOnce(() => {
      f.revokeSource();
      return Promise.resolve(structuredClone(f.detection));
    });
    await expect(f.make().observe(f.request)).rejects.toThrow("source revoked");
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("retains a visible budget refusal and never spends again on duplicate processed Evidence", async () => {
    const f = fixture();
    f.detect.mockRejectedValueOnce(
      new AiServiceError(
        "budget-exhausted",
        "The monthly AI usage limit has been reached.",
        { requestDispatched: false }
      )
    );
    const first = await f.make().observe(f.request);
    expect(first).toMatchObject({ status: "needs-clarification", candidates: [] });
    expect(first.message).toContain("limit");
    await f.make().observe(f.request);
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it("waits for the real calendar budget reset, then re-proves the same source without losing the first refusal", async () => {
    const f = fixture();
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    const first = await f.make().observe(f.request);
    expect(first.analysisRetry).toMatchObject({
      disposition: "not-dispatched",
      attempts: 1,
      canRetry: true,
      nextAttemptAt: "2026-09-30T22:00:00.000Z"
    });
    f.setTime("2026-09-30T21:59:59Z");
    expect((await f.make().observe(f.request)).duplicate).toBe(true);
    expect(f.detect).toHaveBeenCalledTimes(1);
    f.setTime("2026-09-30T22:00:00Z");
    const result = await f.make().observe(f.request);
    expect(result.batchId).toBe(first.batchId);
    expect(result.analysisRetry).toMatchObject({
      disposition: "completed",
      attempts: 2,
      canRetry: false
    });
    expect(result.candidates).toHaveLength(1);
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("bounds explicit unsent retries and makes the same retry instruction idempotent", async () => {
    const f = fixture();
    f.detect.mockRejectedValue(
      new AiServiceError("not-configured", "Model unavailable", {
        requestDispatched: false
      })
    );
    const first = await f.make().observe(f.request);
    const retry = (id: string): ObserveProcessedDecisionSource => ({
      ...f.request,
      observations: [
        {
          type: "decision-source-processed",
          observationId: id,
          retryBatchId: first.batchId,
          retryBeforeScheduled: true
        }
      ]
    });
    const second = await f.make().observe(retry("retry-one"));
    expect(second.analysisRetry).toMatchObject({ attempts: 2, canRetry: true });
    expect((await f.make().observe(retry("retry-one"))).duplicate).toBe(true);
    const last = await f.make().observe(retry("retry-two"));
    expect(last.analysisRetry).toMatchObject({
      attempts: 3,
      canRetry: false,
      nextAttemptAt: null
    });
    await f.make().observe(retry("retry-three"));
    f.setTime("2027-01-01T00:00:00Z");
    await f.make().observe(f.request);
    expect(f.detect).toHaveBeenCalledTimes(3);
  });
  it.each([undefined, true])(
    "never retries an ambiguous or dispatched request (%s)",
    async (requestDispatched) => {
      const f = fixture();
      f.detect.mockRejectedValueOnce(
        new AiServiceError(
          "timeout",
          "Outcome unknown",
          requestDispatched === undefined ? {} : { requestDispatched }
        )
      );
      const first = await f.make().observe(f.request);
      expect(first.analysisRetry).toMatchObject({
        disposition: "unknown",
        attempts: 1,
        canRetry: false
      });
      f.setTime("2027-01-01T00:00:00Z");
      await f.make().observe({
        ...f.request,
        observations: [
          {
            type: "decision-source-processed",
            observationId: "manual-retry",
            retryBatchId: first.batchId,
            retryBeforeScheduled: true
          }
        ]
      });
      await f.make().observe(f.request);
      expect(f.detect).toHaveBeenCalledTimes(1);
    }
  );
  it("does not mistake a later source admission refusal for an unsent detector request", async () => {
    const f = fixture();
    f.detect.mockImplementationOnce(() => {
      f.requireSource.mockRejectedValueOnce(
        new AiServiceError("unavailable", "Admission unavailable", {
          requestDispatched: false
        })
      );
      return Promise.resolve(structuredClone(f.detection));
    });
    const first = await f.make().observe(f.request);
    expect(first.analysisRetry).toMatchObject({
      disposition: "unknown",
      canRetry: false
    });
    await f.make().observe({
      ...f.request,
      observations: [
        {
          type: "decision-source-processed",
          observationId: "retry",
          retryBatchId: first.batchId,
          retryBeforeScheduled: true
        }
      ]
    });
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it.each(["changed-source", "revoked-source", "expanded-audience"])(
    "refuses retry against %s before another model attempt",
    async (change) => {
      const f = fixture();
      f.detect.mockRejectedValueOnce(
        new AiServiceError("not-configured", "Not configured", {
          requestDispatched: false
        })
      );
      const first = await f.make().observe(f.request);
      if (change === "changed-source") f.source.contentHash = "changed";
      else if (change === "revoked-source") f.revokeSource();
      else f.audience.personIds.push("outsider");
      await expect(
        f.make().observe({
          ...f.request,
          observations: [
            {
              type: "decision-source-processed",
              observationId: "retry",
              retryBatchId: first.batchId,
              retryBeforeScheduled: true
            }
          ]
        })
      ).rejects.toThrow();
      expect(f.detect).toHaveBeenCalledTimes(1);
    }
  );
  it("rechecks current ownership and standing permission on an explicit retry", async () => {
    const f = fixture();
    f.enable();
    f.detect.mockRejectedValueOnce(
      new AiServiceError("not-configured", "Not configured", { requestDispatched: false })
    );
    const first = await f.make().observe(f.request);
    f.revokePolicy();
    f.revokeAuthority();
    const result = await f.make().observe({
      ...f.request,
      observations: [
        {
          type: "decision-source-processed",
          observationId: "retry",
          retryBatchId: first.batchId,
          retryBeforeScheduled: true
        }
      ]
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.approvedIntentId).toBeNull();
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.detect).toHaveBeenCalledTimes(2);
  });
  it("preserves Human correction on replay and keeps later inference from overriding it", async () => {
    const f = fixture(),
      mi = f.make(),
      first = await mi.observe(f.request),
      candidate = first.candidates[0]!;
    const correction = structuredClone(candidate.candidate!);
    correction.modality = "proposal";
    correction.acceptanceEvidenceIds = [];
    await mi.observe({
      workspace: f.request.workspace,
      subject: f.request.subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "human-correction",
          requestId: candidate.requestId,
          actor: { providerId: "discord", providerUserId: "jakob-user" },
          candidate: correction,
          reason: "This is still a proposal; do not record it."
        }
      ]
    });
    expect((await mi.observe(f.request)).candidates[0]!.candidate?.modality).toBe(
      "proposal"
    );
    expect(f.detect).toHaveBeenCalledTimes(1);
    f.enable();
    f.source.contentHash = "later";
    f.source.authorizationHash = "later";
    const later = await mi.observe({
      ...f.request,
      observations: [{ type: "decision-source-processed", observationId: "later" }]
    });
    expect(later.candidates[0]!.message).toContain("Human judgment");
    expect(f.provider.write).not.toHaveBeenCalled();
  });
});

function wireDetection(f: ReturnType<typeof fixture>) {
  return {
    complete: f.detection.complete,
    candidates: f.detection.candidates.map((entry) => {
      const {
        relatedWork: _work,
        implementationEvidence: _code,
        ...candidate
      } = entry.interpretation.candidate;
      void _work;
      void _code;
      return {
        confidence: entry.confidence,
        interpretation: {
          candidate: {
            ...candidate,
            relatedWorkReferenceIds: [],
            implementationReferenceIds: []
          },
          reconciliation: entry.interpretation.reconciliation
        }
      };
    })
  };
}
describe("actual automatic model composition and batches", () => {
  it("repairs a zero-cap refusal through the real shared budget and detector with exactly one paid dispatch", async () => {
    const f = fixture();
    const client = {
      create: vi.fn(() =>
        Promise.resolve({
          outputText: JSON.stringify(wireDetection(f)),
          model: "gpt-5.6-luna",
          serviceTier: "default",
          status: "completed",
          providerResponseId: "repaired",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0
          }
        })
      )
    };
    f.configuration.automatic!.detector = createOpenAIAutomaticDecisionDetector({
      client,
      budget: createAiUsageBudget({ database, monthlyLimitUsd: 0, now: f.now })
    });
    const first = await f.make().observe(f.request);
    expect(first.analysisRetry).toMatchObject({
      disposition: "not-dispatched",
      canRetry: true
    });
    expect(client.create).not.toHaveBeenCalled();
    const budget = createAiUsageBudget({ database, monthlyLimitUsd: 30, now: f.now });
    f.configuration.automatic!.detector = createOpenAIAutomaticDecisionDetector({
      client,
      budget
    });
    const retry: ObserveProcessedDecisionSource = {
      ...f.request,
      observations: [
        {
          type: "decision-source-processed",
          observationId: "repaired-config",
          retryBatchId: first.batchId,
          retryBeforeScheduled: true
        }
      ]
    };
    const result = await f.make().observe(retry);
    await f.make().observe(retry);
    expect(result.candidates).toHaveLength(1);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(await budget.getStatus("dayova")).toMatchObject({
      requestCount: 1,
      reservedUsd: 0,
      unknownUsd: 0
    });
  });
  it("runs the actual native Responses request with shared durable accounting, no tools/storage/retries and zero replay spend", async () => {
    const f = fixture(),
      budget = createAiUsageBudget({ database });
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as {
        store: boolean;
        tools?: unknown;
        input: string;
        model: string;
      };
      expect(body.store).toBe(false);
      expect(body.tools).toBeUndefined();
      const modelInput = JSON.parse(body.input) as Record<string, unknown>;
      expect(modelInput["requesterPersonId"]).toBeUndefined();
      expect(modelInput["instruction"]).toBeUndefined();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_auto",
            object: "response",
            model: body.model,
            status: "completed",
            service_tier: "default",
            output: [
              {
                type: "message",
                id: "msg_auto",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(wireDetection(f)),
                    annotations: []
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 5 }
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-request-id": "req_auto" }
          }
        )
      );
    });
    vi.stubGlobal("fetch", fetch);
    try {
      f.configuration.automatic!.detector = createOpenAIAutomaticDecisionDetector({
        apiKey: "synthetic-test-key",
        budget
      });
      const mi = f.make();
      expect((await mi.observe(f.request)).candidates[0]!.candidate?.statement.text).toBe(
        f.source.evidence[0]!.text
      );
      await mi.observe(f.request);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await budget.getStatus("dayova")).toMatchObject({
        requestCount: 1,
        reservedUsd: 0,
        unknownUsd: 0,
        byCapability: [{ capability: "decision-interpretation", requestCount: 1 }]
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(["foreign-evidence", "unknown-person", "invented-target", "too-many"])(
    "refuses ungrounded actual detector output: %s",
    async (kind) => {
      const f = fixture(),
        wire = wireDetection(f);
      f.enable();
      if (kind === "foreign-evidence")
        wire.candidates[0]!.interpretation.candidate.statement.evidenceIds = [
          "private-other-source"
        ];
      if (kind === "unknown-person")
        wire.candidates[0]!.interpretation.candidate.decisionMakerPersonIds = [
          "outsider"
        ];
      if (kind === "invented-target")
        wire.candidates[0]!.interpretation.reconciliation = {
          action: "supersede",
          targetRecordId: "invented"
        };
      if (kind === "too-many")
        wire.candidates = Array.from({ length: 21 }, () =>
          structuredClone(wire.candidates[0]!)
        );
      f.configuration.automatic!.detector = createOpenAIAutomaticDecisionDetector({
        budget: createAiUsageBudget({ database }),
        client: {
          create: () =>
            Promise.resolve({
              outputText: JSON.stringify(wire),
              model: "gpt-5.6-luna",
              serviceTier: "default",
              status: "completed",
              providerResponseId: "resp_bad",
              usage: {
                inputTokens: 100,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 10,
                reasoningTokens: 0
              }
            })
        }
      });
      const result = await f.make().observe(f.request);
      expect(result).toMatchObject({ status: "needs-clarification", candidates: [] });
      expect(f.provider.write).not.toHaveBeenCalled();
    }
  );
  it("keeps every same-scope candidate visible for joint review without recording or re-running detection", async () => {
    const f = fixture();
    f.enable();
    f.detection.candidates.push(structuredClone(f.detection.candidates[0]!));
    f.detection.candidates[1]!.interpretation.candidate.statement.text =
      "A separate question in the same scope.";
    const result = await f.make().observe(f.request);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(
      result.candidates.every(
        (candidate) =>
          candidate.message.includes("share this scope") &&
          candidate.approvedIntentId === null
      )
    ).toBe(true);
    expect(f.provider.write).not.toHaveBeenCalled();
    await f.make().observe(f.request);
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  function secondScope(f: ReturnType<typeof fixture>) {
    const next = structuredClone(f.detection.candidates[0]!);
    next.interpretation.candidate.scopeId = "website";
    next.interpretation.candidate.statement.text = "Keep the website internal too.";
    f.detection.candidates.push(next);
    f.authority.grants.push({
      ...structuredClone(f.authority.grants[0]!),
      id: "website-owner",
      scopeId: "website"
    });
    f.configuration.automatic!.policy!.read = () =>
      Promise.resolve([
        f.grant,
        { ...structuredClone(f.grant), id: "record-website", scopeId: "website" }
      ]);
  }
  it("settles independent scopes only through exact owned positive catalog deltas", async () => {
    const f = fixture();
    f.enable();
    secondScope(f);
    const result = await f.make().observe(f.request);
    expect(result.candidates.map((candidate) => candidate.state)).toEqual([
      "recorded",
      "recorded"
    ]);
    expect(f.provider.write).toHaveBeenCalledTimes(2);
    expect(f.detect).toHaveBeenCalledTimes(1);
    await f.make().observe(f.request);
    expect(f.provider.write).toHaveBeenCalledTimes(2);
  });
  it("preserves the first known reference and visible second request when an unrelated catalog edit blocks the next scope", async () => {
    const f = fixture();
    f.enable();
    secondScope(f);
    const write = f.provider.write;
    f.provider.write = vi.fn<DecisionRecords["write"]>(async (request) => {
      const result = await write(request);
      f.addRecord();
      return result;
    });
    const result = await f.make().observe(f.request);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      state: "recorded",
      execution: { outcome: { status: "succeeded" } }
    });
    expect(result.candidates[1]).toMatchObject({
      candidate: null,
      approvedIntentId: null,
      state: "needs-clarification"
    });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
  });
  it("stops later scopes after an uncertain stage and preserves first-stage recovery information", async () => {
    const f = fixture();
    f.enable();
    secondScope(f);
    f.setMode("unknown-after");
    const result = await f.make().observe(f.request);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.state).toBe("unknown");
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    await f.make().observe(f.request);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
  });
});

describe("automatic observation and final-proof invariants", () => {
  it("rejects reuse of a processed-source Observation ID for changed Evidence without paid replay", async () => {
    const f = fixture();
    await f.make().observe(f.request);
    f.source.contentHash = "changed";
    f.source.authorizationHash = "changed";
    await expect(f.make().observe(f.request)).rejects.toThrow("immutable");
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it("withholds an ungrounded candidate from even a programmable detector", async () => {
    const f = fixture();
    f.detection.candidates[0]!.interpretation.candidate.statement.evidenceIds = [
      "unknown-evidence"
    ];
    const result = await f.make().observe(f.request);
    expect(result.candidates).toEqual([]);
    expect(result.complete).toBe(false);
    expect(f.provider.write).not.toHaveBeenCalled();
  });
  it("withdraws a catalog-grounded candidate if authority changes during final batch delivery", async () => {
    const f = fixture();
    let reads = 0;
    const current = f.configuration.authority.requireCurrent.bind(
      f.configuration.authority
    );
    f.configuration.authority.requireCurrent = async (input) => {
      await current(input);
      reads++;
      if (reads === 3) f.revokeAuthority();
    };
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]).toMatchObject({
      candidate: null,
      approvedIntentId: null,
      state: "needs-clarification"
    });
    expect(result.complete).toBe(false);
  });
});

describe("unqualified original owner acceptance", () => {
  it.each([
    "Have we decided to launch Luma publicly?",
    "We have not yet decided to launch Luma publicly.",
    "Wir haben noch nicht entschieden, Luma öffentlich anzubieten."
  ])("keeps questioning or negated source wording for review: %s", async (text) => {
    const f = fixture();
    f.enable();
    f.source.evidence[0]!.text = text;
    await f.make().observe(f.request);
    expect(f.provider.write).not.toHaveBeenCalled();
  });
});

describe("durable automatic source processing through public MI", () => {
  const workers: Array<Awaited<ReturnType<typeof createAutomaticDecisionProcessing>>> =
    [];
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
  });
  async function workerFor(f: ReturnType<typeof fixture>) {
    const worker = await createAutomaticDecisionProcessing({
      database,
      workspace: f.request.workspace,
      meetingIntelligence: f.make(),
      now: f.now
    });
    workers.push(worker);
    const notify = () =>
      f.source.subject.type === "meeting"
        ? worker.meeting({
            workspaceId: "dayova",
            meetingId: f.source.subject.meetingId,
            observationId: "accepted-import",
            sourceRevision: 1,
            contentHash: f.source.contentHash
          })
        : worker.conversation({
            workspaceId: "dayova",
            subject: f.source.subject,
            admissionId: "original-admission",
            sourceRevision: 1,
            contentHash: f.source.contentHash
          });
    return { worker, notify };
  }
  it("persists the scheduled budget reset across restart and resumes the exact unsent batch once", async () => {
    const f = fixture(),
      first = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    await first.notify();
    first.worker.start();
    await expect.poll(async () => (await first.worker.status()).unavailable).toBe(1);
    const original = (await first.worker.review(f.source.subject)).batch!;
    await first.worker.stop();
    const second = await workerFor(f);
    second.worker.start();
    await second.notify();
    await second.worker.pause();
    expect(f.detect).toHaveBeenCalledTimes(1);
    f.setTime(original.analysisRetry!.nextAttemptAt!);
    second.worker.start();
    await expect.poll(async () => (await second.worker.status()).completed).toBe(1);
    const result = (await second.worker.review(f.source.subject)).batch!;
    expect(result.batchId).toBe(original.batchId);
    expect(result.analysisRetry).toMatchObject({ attempts: 2, disposition: "completed" });
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect(
      (await database.query("SELECT retry_at FROM automatic_decision_jobs")).rows
    ).toEqual([{ retry_at: null }]);
  });
  it("recovers an unsent MI result after a crash before its queue receipt, without guessing another job's proof", async () => {
    const f = fixture(),
      first = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    await first.notify();
    first.worker.start();
    await expect.poll(async () => (await first.worker.status()).unavailable).toBe(1);
    const original = (await first.worker.review(f.source.subject)).batch!;
    await first.worker.stop();
    // Actual durable MI history survives, but neither batch link nor outcome made
    // it into the queue receipt before process exit.
    await database.query(
      "UPDATE automatic_decision_jobs SET phase='processing',batch_id=NULL,retry_at=NULL"
    );
    f.setTime(original.analysisRetry!.nextAttemptAt!);
    const second = await workerFor(f);
    second.worker.start();
    await expect.poll(async () => (await second.worker.status()).completed).toBe(1);
    expect((await second.worker.review(f.source.subject)).batch?.batchId).toBe(
      original.batchId
    );
    expect(f.detect).toHaveBeenCalledTimes(2);
  });
  it("recovers the exact unsent result when the queue receipt fails but its failure receipt commits", async () => {
    const f = fixture(),
      first = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    const query = database.query.bind(database);
    let rejectedReceipt = false;
    const spy = vi
      .spyOn(database, "query")
      .mockImplementation(<T>(...args: Parameters<LumaDatabase["query"]>) => {
        if (
          !rejectedReceipt &&
          args[0].includes("UPDATE automatic_decision_jobs SET phase=$3,batch_id=$4")
        ) {
          rejectedReceipt = true;
          return Promise.reject(new Error("Transient queue receipt failure"));
        }
        return query<T>(...args);
      });
    try {
      await first.notify();
      first.worker.start();
      await expect.poll(async () => (await first.worker.status()).unavailable).toBe(1);
      const original = (await first.worker.review(f.source.subject)).batch!;
      expect(original.analysisRetry).toMatchObject({
        disposition: "not-dispatched",
        attempts: 1
      });
      await first.worker.stop();
      spy.mockRestore();
      f.setTime(original.analysisRetry!.nextAttemptAt!);
      const second = await workerFor(f);
      second.worker.start();
      await expect.poll(async () => (await second.worker.status()).completed).toBe(1);
      expect((await second.worker.review(f.source.subject)).batch?.batchId).toBe(
        original.batchId
      );
      expect(f.detect).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
  it.each(["unsent", "completed"])(
    "repairs a failed explicit retry receipt from its exact durable %s attempt",
    async (outcome) => {
      const f = fixture(),
        { worker, notify } = await workerFor(f);
      f.detect.mockRejectedValueOnce(
        new AiServiceError("budget-exhausted", "Monthly cap reached", {
          requestDispatched: false
        })
      );
      await notify();
      worker.start();
      await expect.poll(async () => (await worker.status()).unavailable).toBe(1);
      if (outcome === "unsent")
        f.detect.mockRejectedValueOnce(
          new AiServiceError("not-configured", "Configuration changed", {
            requestDispatched: false
          })
        );
      const query = database.query.bind(database);
      let failed = false;
      const spy = vi
        .spyOn(database, "query")
        .mockImplementation(<T>(...args: Parameters<LumaDatabase["query"]>) => {
          if (
            !failed &&
            args[0].includes("UPDATE automatic_decision_jobs SET phase=$3,batch_id=$4")
          ) {
            failed = true;
            return Promise.reject(new Error("Manual receipt unavailable"));
          }
          return query<T>(...args);
        });
      try {
        await expect(worker.retry(f.source.subject, "explicit-repair")).rejects.toThrow(
          "Manual receipt unavailable"
        );
        await expect
          .poll(
            async () =>
              (await worker.status())[outcome === "unsent" ? "unavailable" : "completed"]
          )
          .toBe(1);
        const batch = (await worker.review(f.source.subject)).batch!;
        expect(batch.analysisRetry).toMatchObject({
          attempts: 2,
          lastObservationId: "explicit-repair",
          disposition: outcome === "unsent" ? "not-dispatched" : "completed"
        });
        const rows = await database.query<{ retry_at: string | null }>(
          "SELECT retry_at FROM automatic_decision_jobs"
        );
        expect(
          rows.rows[0]?.retry_at === null ? null : Number(rows.rows[0]?.retry_at)
        ).toBe(
          batch.analysisRetry!.nextAttemptAt
            ? Date.parse(batch.analysisRetry!.nextAttemptAt)
            : null
        );
        await worker.stop();
        spy.mockRestore();
        f.setTime(batch.analysisRetry!.nextAttemptAt ?? "2027-01-01T00:00:00Z");
        const next = await workerFor(f);
        next.worker.start();
        await expect.poll(async () => (await next.worker.status()).completed).toBe(1);
        expect(f.detect).toHaveBeenCalledTimes(outcome === "unsent" ? 3 : 2);
      } finally {
        spy.mockRestore();
      }
    }
  );
  it("does not leave a manual attempt actively processing when owned source admission throws", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    await notify();
    worker.start();
    await expect.poll(async () => (await worker.status()).unavailable).toBe(1);
    f.captureProcessed.mockImplementationOnce(() => {
      f.revokeSource();
      return Promise.resolve(structuredClone(f.source));
    });
    await expect(worker.retry(f.source.subject, "revoked-repair")).rejects.toThrow(
      "source revoked"
    );
    expect(await worker.status()).toMatchObject({ processing: 0, interrupted: 1 });
    await worker.pause();
    expect(f.detect).toHaveBeenCalledTimes(1);
    await expect(worker.review(f.source.subject)).rejects.toThrow("source revoked");
  });
  it("does not schedule an interrupted job using an unrelated latest unsent batch", async () => {
    const f = fixture(),
      first = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    const foreign = await f.make().observe(f.request);
    await first.notify();
    await first.worker.stop();
    await database.query("UPDATE automatic_decision_jobs SET phase='processing'");
    f.setTime(foreign.analysisRetry!.nextAttemptAt!);
    const second = await workerFor(f);
    const proofs = f.requireSource.mock.calls.length;
    second.worker.start();
    await expect.poll(() => f.requireSource.mock.calls.length).toBeGreaterThan(proofs);
    await second.worker.pause();
    expect(await second.worker.status()).toMatchObject({ interrupted: 1, completed: 0 });
    expect(f.detect).toHaveBeenCalledTimes(1);
  });
  it("keeps candidates read-only, offers explicit repair and rechecks final Discord delivery", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    await notify();
    worker.start();
    await expect.poll(async () => (await worker.status()).unavailable).toBe(1);
    const mi = f.make();
    if (f.source.subject.type !== "conversation-thread") throw new Error("fixture");
    const runtime = {
      automatic: worker,
      meetingIntelligence: mi,
      execution: createFollowUpExecution({ database, meetingIntelligence: mi }),
      config: {
        parentChannelIds: ["parent"],
        allowedDiscordUserIds: ["jakob-user"],
        maxMessages: 50,
        maxEvidenceChars: 32000,
        minIntervalMs: 60000
      }
    };
    const command = {
      type: "decision-record-candidates" as const,
      interactionId: "read",
      guildId: "guild",
      channelId: f.source.subject.conversationObjectId,
      sourceMessageId: f.source.subject.anchorMessageId,
      actorDiscordUserId: "jakob-user",
      occurredAt: f.now().toISOString()
    };
    const read = await handleDiscordDecisionRecordCommand({
      runtime,
      workspace: f.request.workspace,
      command,
      requireCurrent: f.requireSource
    });
    expect(read.content).toContain("retry:true");
    expect(read.content).toContain("2026-09-30T22:00:00.000Z");
    expect(f.detect).toHaveBeenCalledTimes(1);
    const retryCommand = { ...command, interactionId: "repair", retry: true };
    const repaired = await handleDiscordDecisionRecordCommand({
      runtime,
      workspace: f.request.workspace,
      command: retryCommand,
      requireCurrent: f.requireSource
    });
    await handleDiscordDecisionRecordCommand({
      runtime,
      workspace: f.request.workspace,
      command: retryCommand,
      requireCurrent: f.requireSource
    });
    expect(repaired.content).toContain("candidate 1/1");
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect(f.provider.write).not.toHaveBeenCalled();
    f.revokeSource();
    await expect(repaired.requireCurrent!()).rejects.toThrow();
  });
  it("does not let a delayed older refusal overwrite a newer completed retry receipt", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("not-configured", "First refusal", { requestDispatched: false })
    );
    await notify();
    worker.start();
    await expect.poll(async () => (await worker.status()).unavailable).toBe(1);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("not-configured", "Second refusal", { requestDispatched: false })
    );
    let release = () => {},
      signal = () => {},
      held = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const query = database.query.bind(database);
    const spy = vi
      .spyOn(database, "query")
      .mockImplementation(async <T>(...args: Parameters<LumaDatabase["query"]>) => {
        if (
          !held &&
          args[0].includes("UPDATE automatic_decision_jobs SET phase=$3,batch_id=$4")
        ) {
          held = true;
          signal();
          await gate;
        }
        return query<T>(...args);
      });
    try {
      const older = worker.retry(f.source.subject, "first-repair");
      await blocked;
      let newerFinished = false;
      const newer = worker.retry(f.source.subject, "second-repair").then(() => {
        newerFinished = true;
      });
      // Hold the physical receipt while allowing the second public request to
      // arrive. It must await the whole earlier settlement, then read its head.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(newerFinished).toBe(false);
      expect(f.detect).toHaveBeenCalledTimes(2);
      release();
      await Promise.all([older, newer]);
      expect(f.detect).toHaveBeenCalledTimes(3);
      expect(await worker.status()).toMatchObject({
        completed: 1,
        unavailable: 0,
        needsAttention: 0
      });
      expect((await worker.review(f.source.subject)).batch?.analysisRetry).toMatchObject({
        attempts: 3,
        disposition: "completed"
      });
    } finally {
      release();
      await worker.pause();
      spy.mockRestore();
    }
  });
  it("coalesces concurrent explicit requests and drains the admitted model before shutdown", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("not-configured", "Not configured", { requestDispatched: false })
    );
    await notify();
    worker.start();
    await expect.poll(async () => (await worker.status()).unavailable).toBe(1);
    let release = () => {};
    const pending = new Promise<AutomaticDecisionDetection>((resolve) => {
      release = () => resolve(structuredClone(f.detection));
    });
    f.detect.mockImplementationOnce(() => pending);
    const retry = worker.retry(f.source.subject, "repair");
    await expect.poll(() => f.detect.mock.calls.length).toBe(2);
    const duplicate = worker.retry(f.source.subject, "repair");
    const other = worker.retry(f.source.subject, "other-repair");
    const before = await worker.review(f.source.subject);
    expect(before.batch?.analysisRetry).toMatchObject({
      disposition: "unknown",
      canRetry: false
    });
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(worker.retry(f.source.subject, "too-late")).rejects.toThrow("paused");
    release();
    await Promise.all([retry, duplicate, other, stop]);
    expect(f.detect).toHaveBeenCalledTimes(2);
    expect((await worker.review(f.source.subject)).batch?.candidates).toHaveLength(1);
  });
  it("never schedules or manually repeats an unknown dispatched operation after restart", async () => {
    const f = fixture(),
      first = await workerFor(f);
    f.detect.mockRejectedValueOnce(
      new AiServiceError("timeout", "Unknown outcome", { requestDispatched: true })
    );
    await first.notify();
    first.worker.start();
    await expect.poll(async () => (await first.worker.status()).unavailable).toBe(1);
    await first.worker.stop();
    f.setTime("2027-01-01T00:00:00Z");
    const second = await workerFor(f);
    second.worker.start();
    await second.worker.retry(f.source.subject, "manual");
    await second.notify();
    await second.worker.pause();
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(
      (await second.worker.review(f.source.subject)).batch?.analysisRetry
    ).toMatchObject({ canRetry: false, disposition: "unknown" });
  });
  it("does not strand an accepted source arriving while the empty queue read finishes", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    let signalEmpty = () => {},
      releaseEmpty = () => {};
    const empty = new Promise<void>((resolve) => {
      signalEmpty = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseEmpty = resolve;
    });
    const original = database.query.bind(database);
    let gated = false;
    // Preserve real uniqueness/transactions and hold only delivery of a physical
    // empty dequeue result, while another accepted notification commits.
    const spy = vi
      .spyOn(database, "query")
      .mockImplementation(async <T>(...args: Parameters<typeof database.query>) => {
        const response = await original<T>(...args);
        if (
          !gated &&
          args[0].includes("SET phase='processing'") &&
          response.rows.length === 0
        ) {
          gated = true;
          signalEmpty();
          await released;
        }
        return response;
      });
    try {
      worker.start();
      await empty;
      await notify();
      releaseEmpty();
      await vi.waitFor(
        async () =>
          expect(await worker.status()).toMatchObject({
            queued: 0,
            processing: 0,
            completed: 1
          }),
        { timeout: 2000 }
      );
      expect(f.detect).toHaveBeenCalledTimes(1);
    } finally {
      releaseEmpty();
      await worker.stop();
      spy.mockRestore();
    }
  });
  it("retains notifications before processing, coalesces duplicate deliveries and exposes the exact current review without a Human write request", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    await Promise.all([notify(), notify(), notify()]);
    expect(f.detect).not.toHaveBeenCalled();
    expect(await worker.status()).toMatchObject({ active: false, queued: 1 });
    worker.start();
    await vi.waitFor(
      async () =>
        expect(await worker.status()).toMatchObject({
          queued: 0,
          processing: 0,
          completed: 1
        }),
      { timeout: 3000 }
    );
    const result = await worker.review(f.source.subject);
    expect(result.batch?.candidates).toHaveLength(1);
    expect(result.batch?.candidates[0]?.automatic?.recording).toBe("review-only");
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.detect).toHaveBeenCalledTimes(1);
    await notify();
    await worker.stop();
    expect(f.detect).toHaveBeenCalledTimes(1);
    const latest = await f.make().query({
      workspaceId: "dayova",
      subject: f.source.subject,
      query: { type: "automatic-decision-candidates" }
    });
    expect(latest.batchId).toBe(result.batch?.batchId);
  });
  it("does not repeat an interrupted attempt after restart and recovers an already retained MI review without another model call", async () => {
    const f = fixture(),
      first = await workerFor(f);
    await first.notify();
    first.worker.start();
    await vi.waitFor(
      async () => expect(await first.worker.status()).toMatchObject({ completed: 1 }),
      { timeout: 3000 }
    );
    await first.worker.stop();
    await database.query(
      "UPDATE automatic_decision_jobs SET phase='processing',batch_id=NULL WHERE workspace_id=$1",
      ["dayova"]
    );
    const second = await workerFor(f);
    second.worker.start();
    await expect.poll(async () => (await second.worker.status()).completed).toBe(1);
    expect(await second.worker.status()).toMatchObject({ interrupted: 0, queued: 0 });
    const recovered = await second.worker.review(f.source.subject);
    expect(recovered.status).toBe("completed");
    expect(recovered.batch?.candidates).toHaveLength(1);
    expect(f.detect).toHaveBeenCalledTimes(1);
    f.revokeSource();
    await expect(second.worker.review(f.source.subject)).rejects.toThrow(
      "source revoked"
    );
  });
  it("reports a blocked shared AI budget without losing its source notification or retrying the paid operation", async () => {
    const f = fixture(),
      { worker, notify } = await workerFor(f);
    f.detect.mockRejectedValue(
      new AiServiceError("budget-exhausted", "Monthly cap reached", {
        requestDispatched: false
      })
    );
    await notify();
    worker.start();
    await vi.waitFor(
      async () =>
        expect(await worker.status()).toMatchObject({ unavailable: 1, processing: 0 }),
      { timeout: 3000 }
    );
    const review = await worker.review(f.source.subject);
    expect(review.batch?.message).toBe("Monthly cap reached");
    await notify();
    await worker.stop();
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.provider.write).not.toHaveBeenCalled();
    await expect(
      worker.meeting({
        workspaceId: "other",
        meetingId: "meeting",
        observationId: "o",
        sourceRevision: 1,
        contentHash: "h"
      })
    ).rejects.toThrow();
  });
});

describe("automatic decisions with actual durable native standing permission", () => {
  async function composed() {
    const f = fixture(),
      permissions = standingFixture(database),
      policy = await permissions.make();
    f.source.audience = structuredClone(permissionAudience);
    for (const item of f.source.evidence) {
      if (item.authorPersonId === "jakob") item.authorPersonId = "person_jakob";
      if (item.reference.participantId === "jakob")
        item.reference.participantId = "person_jakob";
    }
    f.detection.candidates[0]!.interpretation.candidate.decisionMakerPersonIds = [
      "person_jakob"
    ];
    f.configuration.accessPolicy = permissions.accessPolicy;
    f.configuration.authority = permissions.authority;
    f.configuration.audience = () => Promise.resolve(structuredClone(permissionAudience));
    f.configuration.automatic!.policy = policy;
    f.request.workspace.workspaceId = permissionAudience.workspaceId;
    await policy.command(permissions.command());
    return { f, permissions, policy };
  }
  it("uses only explicit stored owner permission, records once, and a recreated core does not replay the write", async () => {
    const { f, policy } = await composed();
    const result = await f.make().observe(f.request);
    expect(result.candidates[0]).toMatchObject({
      state: "recorded",
      automatic: { recording: "standing-policy" }
    });
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect((await f.make().observe(f.request)).duplicate).toBe(true);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    await policy.stop();
  });
  it("revokes actual durable permission after stage admission and prevents provider dispatch", async () => {
    const { f, permissions, policy } = await composed();
    const originalQuery = database.query.bind(database);
    let revoked = false;
    database.query = async <T>(...args: Parameters<LumaDatabase["query"]>) => {
      const result = await originalQuery<T>(...args);
      if (
        !revoked &&
        args[0].includes("INSERT INTO decision_write_stages") &&
        args[1]?.some(
          (value) => typeof value === "string" && value.includes('"state":"executing"')
        )
      ) {
        revoked = true;
        await policy.command(permissions.command(2, { action: "disable" }));
      }
      return result;
    };
    await f.make().observe(f.request);
    expect(revoked).toBe(true);
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(await policy.read({ audience: permissionAudience })).toEqual([]);
  });
});
