import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import type {
  LogicalMeeting,
  MeetingCaptureRevision
} from "../../src/logical-meetings/interface.js";
import type {
  LumaSynthesis,
  MeetingCaptureSetObserved
} from "../../src/domain/meeting-capture-synthesis.js";
import { createMeetingCaptureIngestion } from "../../src/knowledge/meeting-capture-ingestion.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z";
function revision(
  provider: string,
  captureId = provider,
  sourceRevision = 1,
  calendar = "weekly"
): MeetingCaptureRevision {
  const verbatim = provider === "notion";
  const externalReference = {
    providerId: provider,
    externalId: captureId,
    objectType: "document" as const,
    url: `https://example.test/${captureId}`
  };
  return {
    address: {
      providerId: provider,
      providerConnectionId: `${provider}-connection`,
      externalCaptureId: captureId,
      sourceKind: "meeting-capture"
    },
    sourceRevision,
    contentHash: `hash:${captureId}:${sourceRevision}`,
    capturedAt: at,
    providerVersion: `v${sourceRevision}`,
    eligibility: { state: "eligible" },
    availability: "complete",
    capabilities: {
      rawTranscript: verbatim ? "available" : "unavailable",
      enhancedNotes: "available",
      speakerIdentity: "unavailable",
      attendees: "unavailable",
      revisionMetadata: "available"
    },
    identityFacts: {
      calendarEventKeys: calendar ? [calendar] : [],
      conferenceKeys: [],
      interval: null,
      attendeePersonIds: [],
      titleFingerprint: "same-title",
      contextKeys: []
    },
    materials: [
      {
        kind: verbatim ? "verbatim-transcript" : "derived-notes",
        provenance: verbatim ? "original-speech" : "provider-derived",
        sourceObjectId: `material:${captureId}`,
        sourceVersion: `${sourceRevision}`,
        externalReference
      }
    ],
    externalReference
  };
}
async function setup(legacyIds = false) {
  const database = await createPgliteDatabase();
  const revisions = new Map<string, MeetingCaptureRevision>();
  const texts = new Map<string, string>();
  const revoked = new Set<string>();
  let audience = ["person_jakob", "person_fabius"];
  let authorizationScopeId = "fixture-original-grant";
  let opaqueId = 0;
  const logicalMeetings = createLogicalMeetings({
    database,
    ...(legacyIds
      ? { createOpaqueId: () => `${++opaqueId % 2 ? "ä" : "z"}-${opaqueId}` }
      : {}),
    captureRevisionVerifier: {
      verify: ({ revision: value }) =>
        Promise.resolve(
          revisions.get(value.address.externalCaptureId)?.contentHash ===
            value.contentHash
            ? { status: "verified" }
            : { status: "rejected", message: "Unknown fixture revision" }
        )
    }
  });
  let calls = 0;
  let quote = false;
  let duringModel: (() => Promise<void>) | undefined;
  let duringRead: (() => void) | undefined;
  let duringAttemptClaim: (() => void) | undefined;
  let failMigration = false;
  let transformProposal: ((value: CaptureSynthesisProposal) => void) | undefined;
  const model: ReasoningModel = {
    generateStructured: async <T>(request: StructuredReasoningRequest<T>) => {
      calls += 1;
      await duringModel?.();
      const value: CaptureSynthesisProposal = {
        claims: request.evidence.map((evidence, index) => ({
          key: `claim-${index}`,
          kind: "decision",
          text: evidence.excerpt!,
          confidence: "medium",
          evidenceIds: [evidence.evidenceId],
          quotations: quote
            ? [{ evidenceId: evidence.evidenceId, text: evidence.excerpt! }]
            : [],
          conflictingKeys: request.evidence.length > 1 && index === 0 ? ["claim-1"] : []
        }))
      };
      transformProposal?.(value);
      return {
        value: value as T,
        metadata: {
          provider: "fixture",
          model: "fixture",
          promptVersion: request.promptVersion
        }
      };
    }
  };
  const databaseWithClaimBoundary: LumaDatabase = new Proxy(database, {
    get(target, property): unknown {
      if (property === "exec")
        return (sql: string) => {
          if (
            failMigration &&
            sql.includes("CREATE TABLE IF NOT EXISTS meeting_capture_synthesis")
          ) {
            failMigration = false;
            return Promise.reject(new Error("Temporary schema initialization failure"));
          }
          return target.exec(sql);
        };
      if (property === "query")
        return async <T>(sql: string, params?: unknown[]) => {
          const result = await target.query<T>(sql, params);
          if (sql.startsWith("INSERT INTO meeting_capture_synthesis_attempts"))
            duringAttemptClaim?.();
          return result;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const createMI = () =>
    createMeetingIntelligence({
      database: databaseWithClaimBoundary,
      reasoningModel: model,
      captureSynthesis: {
        logicalMeetings,
        audience: () =>
          Promise.resolve({
            workspaceId: workspace.workspaceId,
            personIds: [...audience]
          }),
        access: {
          readCurrent: ({ capture, audience: currentAudience }) => {
            const sourceId = capture.address.externalCaptureId;
            if (
              revoked.has(sourceId) ||
              currentAudience.personIds.some(
                (id) => !["person_jakob", "person_fabius", "person_julius"].includes(id)
              ) ||
              revisions.get(sourceId)?.contentHash !== capture.latestRevision.contentHash
            )
              throw new Error("Source unavailable");
            const result = {
              authorizationScopeId,
              canonicalAnchorRef:
                capture.address.providerId === "notion"
                  ? capture.latestRevision.externalReference
                  : null,
              materials: capture.latestRevision.materials.map((descriptor) => ({
                descriptor,
                text: texts.get(sourceId)!
              }))
            };
            duringRead?.();
            return Promise.resolve(result);
          }
        }
      }
    });
  let mi = createMI();
  let observation = 0;
  const add = async (value: MeetingCaptureRevision, text = "Wir könnten starten.") => {
    revisions.set(value.address.externalCaptureId, value);
    texts.set(value.address.externalCaptureId, text);
    const result = await logicalMeetings.resolveCapture({
      workspaceId: workspace.workspaceId,
      revision: value
    });
    if (result.status !== "accepted") throw new Error(JSON.stringify(result));
    return result.decision;
  };
  const observe = async (meetingId: string, observationId?: string) => {
    const meeting = await logicalMeetings.get({
      workspaceId: workspace.workspaceId,
      logicalMeetingId: meetingId
    });
    if (!meeting) throw new Error("Missing logical meeting");
    const event: MeetingCaptureSetObserved = {
      type: "meeting-capture-set-observed",
      observationId: observationId ?? `capture-observation-${++observation}`,
      workspaceId: workspace.workspaceId,
      meetingId,
      observedAt: at,
      occurredAt: at,
      captures: meeting.captureRefs.map((capture) => ({
        captureId: capture.id,
        sourceRevision: capture.latestRevision.sourceRevision,
        contentHash: capture.latestRevision.contentHash
      }))
    };
    return mi.observe({ workspace, observations: [event] });
  };
  const query = async (meetingId: string) => {
    const result = await mi.query({
      workspaceId: workspace.workspaceId,
      meetingId,
      query: { type: "capture-synthesis" }
    });
    if (result.type !== "capture-synthesis") throw new Error("Wrong query variant");
    return result;
  };
  return {
    database,
    logicalMeetings,
    get mi() {
      return mi;
    },
    recreate: () => {
      mi = createMI();
    },
    add,
    observe,
    query,
    revoked,
    texts,
    calls: () => calls,
    failNextMigration: () => {
      failMigration = true;
    },
    setQuote: () => {
      quote = true;
    },
    setAudience: (value: string[]) => {
      audience = value;
    },
    replaceGrant: () => {
      authorizationScopeId = "fixture-replacement-grant";
    },
    duringModel: (hook: () => Promise<void>) => {
      duringModel = hook;
    },
    duringRead: (hook: () => void) => {
      duringRead = hook;
    },
    duringAttemptClaim: (hook: () => void) => {
      duringAttemptClaim = hook;
    },
    transformProposal: (hook: (value: CaptureSynthesisProposal) => void) => {
      transformProposal = hook;
    }
  };
}

// Exact pre-code-unit wire format, used only to install retained release data.
function legacyCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${legacyCanonical(object[key])}`)
    .join(",")}}`;
}
const legacyDigest = (value: unknown) =>
  createHash("sha256").update(legacyCanonical(value)).digest("hex");
function legacyObservation(meeting: LogicalMeeting): MeetingCaptureSetObserved {
  const captures = meeting.captureRefs
    .map((capture) => ({
      captureId: capture.id,
      sourceRevision: capture.latestRevision.sourceRevision,
      contentHash: capture.latestRevision.contentHash
    }))
    .sort((a, b) => a.captureId.localeCompare(b.captureId, "en-US"));
  const binding = meeting.captureRefs
    .map((capture) => [capture.id, capture.binding, capture.admission])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en-US"));
  return {
    type: "meeting-capture-set-observed",
    observationId: `capture-set:${createHash("sha256")
      .update(
        JSON.stringify([
          workspace.workspaceId,
          meeting.id,
          captures,
          binding,
          meeting.canonicalAnchorRef
        ])
      )
      .digest("hex")}`,
    workspaceId: workspace.workspaceId,
    meetingId: meeting.id,
    occurredAt: meeting.updatedAt,
    observedAt: meeting.updatedAt,
    captures
  };
}

describe("Meeting Intelligence capture synthesis", () => {
  it("keeps the original UUID capture observation ID when switching ingestion to deterministic ordering", async () => {
    const f = await setup();
    try {
      await f.add(revision("notion"));
      const meeting = (await f.add(revision("granola"))).logicalMeeting;
      const original = legacyObservation(meeting);
      expect(
        (await f.mi.observe({ workspace, observations: [original] })).errors
      ).toEqual([]);
      f.recreate();
      expect(
        await createMeetingCaptureIngestion({
          workspace,
          meetingIntelligence: f.mi
        }).ingest(meeting)
      ).toMatchObject({
        duplicateObservationIds: [original.observationId],
        analysisStatus: "not-needed",
        errors: []
      });
      expect(f.calls()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("replays exact retained legacy material and source-set identities after restart without another model charge", async () => {
    const f = await setup(true);
    try {
      await f.add(revision("notion"));
      const meeting = (await f.add(revision("granola"))).logicalMeeting;
      const original = legacyObservation(meeting);
      expect(
        (await f.mi.observe({ workspace, observations: [original] })).errors
      ).toEqual([]);
      const rows = await f.database.query<{ state_json: string }>(
        "SELECT state_json FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
        [workspace.workspaceId, meeting.id]
      );
      const state = JSON.parse(rows.rows[0]!.state_json) as {
        materialDigest: string;
        bindingDigest: string;
        authorizationScopes: Record<string, string>;
        judgments: unknown[];
        synthesis: LumaSynthesis;
      };
      const materials = meeting.captureRefs
        .flatMap((capture) =>
          capture.latestRevision.materials.map((descriptor) => ({
            descriptor,
            text: f.texts.get(capture.address.externalCaptureId)!,
            captureId: capture.id,
            sourceRevision: capture.latestRevision.sourceRevision,
            evidenceId: `capture-evidence:${legacyDigest([capture.id, capture.latestRevision.sourceRevision, descriptor])}`
          }))
        )
        .sort((a, b) => legacyCanonical(a).localeCompare(legacyCanonical(b), "en-US"));
      const legacyMaterialDigest = legacyDigest(materials);
      expect(legacyMaterialDigest).not.toBe(state.materialDigest);
      state.materialDigest = legacyMaterialDigest;
      state.synthesis.sourceSetDigest = legacyDigest([
        state.bindingDigest,
        state.materialDigest,
        state.authorizationScopes,
        workspace
      ]);
      const legacyAttempt = legacyDigest([
        state.synthesis.sourceSetDigest,
        legacyDigest(state.judgments),
        "capture-synthesis-v1"
      ]);
      // Install the immutable prior-release fixture with its original digest and
      // completed attempt; no production migration is allowed to rewrite these.
      for (const table of [
        "meeting_capture_synthesis",
        "meeting_capture_synthesis_revisions"
      ])
        await f.database.query(
          `UPDATE ${table} SET state_json=$3 WHERE workspace_id=$1 AND meeting_id=$2`,
          [workspace.workspaceId, meeting.id, JSON.stringify(state)]
        );
      await f.database.query(
        "DELETE FROM meeting_capture_synthesis_attempts WHERE workspace_id=$1 AND meeting_id=$2",
        [workspace.workspaceId, meeting.id]
      );
      await f.database.query(
        "INSERT INTO meeting_capture_synthesis_attempts(workspace_id,meeting_id,attempt_key) VALUES($1,$2,$3)",
        [workspace.workspaceId, meeting.id, legacyAttempt]
      );
      f.recreate();
      expect((await f.query(meeting.id)).synthesis).toEqual(state.synthesis);
      expect(await f.mi.observe({ workspace, observations: [original] })).toMatchObject({
        duplicateObservationIds: [original.observationId],
        analysisStatus: "not-needed",
        errors: []
      });
      expect(
        await createMeetingCaptureIngestion({
          workspace,
          meetingIntelligence: f.mi
        }).ingest(meeting)
      ).toMatchObject({ analysisStatus: "not-needed", errors: [] });
      expect(f.calls()).toBe(1);
      expect((await f.query(meeting.id)).synthesis?.sourceSetDigest).toBe(
        state.synthesis.sourceSetDigest
      );
      f.revoked.add("granola");
      expect((await f.query(meeting.id)).availability).toBe("unavailable");
      f.revoked.clear();
      expect(
        (
          await f.database.query<{ attempt_key: string }>(
            "SELECT attempt_key FROM meeting_capture_synthesis_attempts WHERE workspace_id=$1 AND meeting_id=$2",
            [workspace.workspaceId, meeting.id]
          )
        ).rows
      ).toEqual([{ attempt_key: legacyAttempt }]);
      // A positively completed old attempt does not block genuinely new material.
      await f.add(revision("notion", "notion", 2));
      expect(await f.observe(meeting.id)).toMatchObject({
        analysisStatus: "completed",
        errors: []
      });
      expect(f.calls()).toBe(2);
    } finally {
      await f.database.close();
    }
  });
  it("holds an unmatched legacy paid attempt instead of inventing a new ordering key and charging again", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      expect((await f.query(meetingId)).availability).toBe("not-produced");
      await f.database.query(
        "INSERT INTO meeting_capture_synthesis_attempts(workspace_id,meeting_id,attempt_key) VALUES($1,$2,$3)",
        [workspace.workspaceId, meetingId, "unknown-legacy-order"]
      );
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: [],
        errors: [{ code: "analysis-request-indeterminate", retryable: false }]
      });
      expect(f.calls()).toBe(0);
      expect(
        (
          await f.database.query(
            "SELECT attempt_key FROM meeting_capture_synthesis_attempts WHERE workspace_id=$1 AND meeting_id=$2",
            [workspace.workspaceId, meetingId]
          )
        ).rows
      ).toEqual([{ attempt_key: "unknown-legacy-order" }]);
    } finally {
      await f.database.close();
    }
  });
  it("withholds an unsupported retained material hash on an unchanged source set without paid re-observation", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      await f.observe(meetingId);
      const rows = await f.database.query<{ state_json: string }>(
        "SELECT state_json FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
        [workspace.workspaceId, meetingId]
      );
      const state = JSON.parse(rows.rows[0]!.state_json) as { materialDigest: string };
      state.materialDigest = "unsupported-legacy-order";
      await f.database.query(
        "UPDATE meeting_capture_synthesis SET state_json=$3 WHERE workspace_id=$1 AND meeting_id=$2",
        [workspace.workspaceId, meetingId, JSON.stringify(state)]
      );
      f.recreate();
      expect((await f.query(meetingId)).availability).toBe("unavailable");
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: []
      });
      expect(f.calls()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("retries a transient schema initialization failure in the same MI instance without losing observation idempotency", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      f.failNextMigration();
      expect(await f.observe(meetingId, "migration-retry")).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: [],
        errors: [{ code: "context-unavailable", retryable: true }]
      });
      expect(f.calls()).toBe(0);
      expect(await f.observe(meetingId, "migration-retry")).toMatchObject({
        analysisStatus: "completed",
        acceptedObservationIds: ["migration-retry"],
        errors: []
      });
      expect(await f.observe(meetingId, "migration-retry")).toMatchObject({
        analysisStatus: "not-needed",
        duplicateObservationIds: ["migration-retry"],
        errors: []
      });
      expect(f.calls()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("does not disclose retained inferred conflicts through a replacement source grant", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("notion"))).logicalMeeting.id;
      await f.add(revision("granola"), "Private original conflicting source");
      expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "completed" });
      f.replaceGrant();
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: []
      });
      expect(f.calls()).toBe(1);
      expect((await f.query(meetingId)).availability).toBe("unavailable");
    } finally {
      await f.database.close();
    }
  });
  it("rechecks source grants after durable paid admission and before disclosing evidence to the model", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      f.duringAttemptClaim(() => {
        f.revoked.add("granola");
      });
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: []
      });
      expect(f.calls()).toBe(0);
      f.revoked.clear();
      f.duringAttemptClaim(() => {});
      expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "completed" });
      expect(f.calls()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it.each([false, true])(
    "withholds an omitted conflict counterpart and restores reciprocal edges on a later coherent source revision (Human confirmed=%s)",
    async (humanConfirmed) => {
      const f = await setup();
      try {
        const meetingId = (await f.add(revision("notion"))).logicalMeeting.id;
        await f.add(revision("granola"), "Wir starten erst nach dem Review.");
        await f.observe(meetingId);
        const first = (await f.query(meetingId)).synthesis!;
        if (humanConfirmed)
          await f.mi.observe({
            workspace,
            observations: [
              {
                type: "capture-synthesis-judgment-recorded",
                observationId: "human-conflict",
                workspaceId: workspace.workspaceId,
                meetingId,
                occurredAt: at,
                observedAt: at,
                participantId: "person_jakob",
                expectedSynthesisRevision: 1,
                claimId: first.claims[0]!.id,
                judgment: { kind: "confirm" }
              }
            ]
          });
        await f.add(revision("notion", "notion", 2));
        f.transformProposal((proposal) => {
          proposal.claims = [proposal.claims[0]!];
          proposal.claims[0]!.conflictingKeys = [];
        });
        expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "deferred" });
        expect((await f.query(meetingId)).availability).toBe("unavailable");
        await f.add(revision("notion", "notion", 3));
        f.transformProposal((proposal) => {
          for (const claim of proposal.claims) claim.conflictingKeys = [];
        });
        expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "completed" });
        const current = (await f.query(meetingId)).synthesis!;
        const authoritative = current.claims.find(
          (claim) => claim.id === first.claims[0]!.id
        )!;
        const counterpart = current.claims.find(
          (claim) => claim.id === authoritative.conflictingClaimIds[0]
        )!;
        expect(counterpart.conflictingClaimIds).toContain(authoritative.id);
        expect(current.claims).toHaveLength(2);
        if (humanConfirmed) expect(authoritative.authority).toBe("human-confirmed");
      } finally {
        await f.database.close();
      }
    }
  );
  it("reports budget exhaustion and retries only a proven undispatched synthesis attempt", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      f.duringModel(() =>
        Promise.reject(
          new AiServiceError("budget-exhausted", "safe budget status", {
            requestDispatched: false,
            limitScope: "month",
            resetAt: "2026-10-01T00:00:00.000Z",
            timezone: "Europe/Berlin"
          })
        )
      );
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        errors: [
          {
            code: "analysis-budget-exhausted",
            retryable: false,
            limitScope: "month",
            resetAt: "2026-10-01T00:00:00.000Z"
          }
        ]
      });
      f.duringModel(() => Promise.resolve());
      expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "completed" });
    } finally {
      await f.database.close();
    }
  });
  it.each([
    { providers: ["notion"] },
    { providers: ["granola"] },
    { providers: ["notion", "granola"] },
    { providers: ["notion", "granola", "granola-fabius"] }
  ])(
    "synthesizes independent %j captures through one Logical Meeting without duplicate revisions",
    async ({ providers }) => {
      const f = await setup();
      try {
        let meetingId = "";
        for (const provider of providers)
          meetingId = (
            await f.add(
              revision(provider),
              provider === "notion"
                ? "Wir könnten starten."
                : "Wir starten erst nach dem Review."
            )
          ).logicalMeeting.id;
        expect(await f.observe(meetingId)).toMatchObject({
          analysisStatus: "completed",
          revision: 1,
          errors: []
        });
        const first = await f.query(meetingId);
        expect(first.availability).toBe("available");
        expect(first.synthesis?.sources).toHaveLength(providers.length);
        expect(first.synthesis?.claims).toHaveLength(providers.length);
        expect(
          first.synthesis?.claims.every((claim) => claim.authority === "inferred")
        ).toBe(true);
        expect(first.synthesis?.coverage).toBe(
          providers.length === 1 && providers[0] === "notion" ? "complete" : "partial"
        );
        expect(first.synthesis?.canonicalAnchorRef?.providerId ?? null).toBe(
          providers.includes("notion") ? "notion" : null
        );
        if (providers.length > 1)
          expect(first.synthesis?.claims[1]?.conflictingClaimIds).toContain(
            first.synthesis?.claims[0]?.id
          );
        expect(await f.observe(meetingId)).toMatchObject({
          analysisStatus: "not-needed",
          revision: 1
        });
        expect(f.calls()).toBe(1);
        await f.add(
          revision(providers[0]!, providers[0], 2),
          "Das ist noch keine Entscheidung."
        );
        expect(await f.query(meetingId)).toMatchObject({
          availability: "unavailable",
          synthesis: null
        });
        expect(await f.observe(meetingId)).toMatchObject({
          analysisStatus: "completed",
          revision: 2
        });
        expect((await f.query(meetingId)).synthesis?.sources).toHaveLength(
          providers.length
        );
        expect(
          (
            await f.database.query<{ count: number }>(
              "SELECT COUNT(*)::int AS count FROM meeting_capture_synthesis_revisions"
            )
          ).rows[0]?.count
        ).toBe(2);
      } finally {
        await f.database.close();
      }
    }
  );
  it("keeps adjacent same-title captures separate and honors a later Human binding correction", async () => {
    const f = await setup();
    try {
      const first = await f.add(revision("notion", "morning", 1, ""), "Morning source");
      const second = await f.add(revision("granola", "evening", 1, ""), "Evening source");
      expect(second.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
      await f.observe(first.logicalMeeting.id);
      await f.observe(second.logicalMeeting.id);
      expect(
        (await f.query(first.logicalMeeting.id)).synthesis?.claims.map(
          (claim) => claim.text
        )
      ).toEqual(["Morning source"]);
      await f.logicalMeetings.recordBindingJudgment({
        workspaceId: workspace.workspaceId,
        captureId: second.captureId,
        actorPersonId: "person_jakob",
        judgmentId: "bind-1",
        observedAt: at,
        reason: "Human confirmed same meeting",
        judgment: { type: "bind", logicalMeetingId: first.logicalMeeting.id }
      });
      expect((await f.query(second.logicalMeeting.id)).availability).toBe("unavailable");
      expect(await f.observe(first.logicalMeeting.id)).toMatchObject({
        analysisStatus: "completed",
        revision: 2
      });
      expect((await f.query(first.logicalMeeting.id)).synthesis?.sources).toHaveLength(2);
    } finally {
      await f.database.close();
    }
  });
  it.each(["notion", "granola"])(
    "allows exact quotations only from actual verbatim %s material",
    async (provider) => {
      const f = await setup();
      try {
        const meetingId = (await f.add(revision(provider))).logicalMeeting.id;
        f.setQuote();
        expect((await f.observe(meetingId)).analysisStatus).toBe(
          provider === "notion" ? "completed" : "deferred"
        );
        expect((await f.query(meetingId)).availability).toBe(
          provider === "notion" ? "available" : "not-produced"
        );
        await f.observe(meetingId);
        expect(f.calls()).toBe(1);
      } finally {
        await f.database.close();
      }
    }
  );
  it("preserves a Human correction across later provider/model inference", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      await f.observe(meetingId);
      const first = (await f.query(meetingId)).synthesis!;
      expect(
        await f.mi.observe({
          workspace,
          observations: [
            {
              type: "capture-synthesis-judgment-recorded",
              observationId: "human-1",
              workspaceId: workspace.workspaceId,
              meetingId,
              occurredAt: at,
              observedAt: at,
              participantId: "person_jakob",
              expectedSynthesisRevision: 1,
              claimId: first.claims[0]!.id,
              judgment: {
                kind: "correct",
                text: "Wir haben den Start ausdrücklich pausiert."
              }
            }
          ]
        })
      ).toMatchObject({ revision: 2, errors: [] });
      await f.add(
        revision("granola", "granola", 2),
        "Provider behauptet weiterhin: starten."
      );
      await f.observe(meetingId);
      expect((await f.query(meetingId)).synthesis?.claims).toMatchObject([
        {
          text: "Wir haben den Start ausdrücklich pausiert.",
          authority: "human-corrected"
        }
      ]);
      expect(f.calls()).toBe(2);
    } finally {
      await f.database.close();
    }
  });
  it("withholds revoked or newly widened audiences and rechecks grants after preparing a query", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      await f.observe(meetingId);
      f.setAudience(["person_jakob", "person_fabius", "person_julius"]);
      expect(await f.query(meetingId)).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
      f.setAudience(["person_jakob", "person_fabius"]);
      f.duringRead(() => {
        f.revoked.add("granola");
      });
      expect(await f.query(meetingId)).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
    } finally {
      await f.database.close();
    }
  });
  it("refuses a stale Human confirmation and duplicate delivery when identical material has a replacement grant", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      await f.observe(meetingId, "first-capture");
      const first = (await f.query(meetingId)).synthesis!;
      f.replaceGrant();
      expect(await f.query(meetingId)).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
      expect(await f.observe(meetingId, "first-capture")).toMatchObject({
        analysisStatus: "deferred",
        duplicateObservationIds: []
      });
      expect(
        await f.mi.observe({
          workspace,
          observations: [
            {
              type: "capture-synthesis-judgment-recorded",
              observationId: "stale-confirmation",
              workspaceId: workspace.workspaceId,
              meetingId,
              occurredAt: at,
              observedAt: at,
              participantId: "person_jakob",
              expectedSynthesisRevision: first.revision,
              claimId: first.claims[0]!.id,
              judgment: { kind: "confirm" }
            }
          ]
        })
      ).toMatchObject({ analysisStatus: "deferred", acceptedObservationIds: [] });
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "completed",
        revision: 2
      });
      expect((await f.query(meetingId)).synthesis?.claims[0]?.authority).toBe("inferred");
    } finally {
      await f.database.close();
    }
  });
  it("discards model output when source authorization changes in flight and does not repeat a dispatched paid attempt", async () => {
    const f = await setup();
    try {
      const meetingId = (await f.add(revision("granola"))).logicalMeeting.id;
      f.duringModel(() => {
        f.revoked.add("granola");
        return Promise.resolve();
      });
      expect(await f.observe(meetingId)).toMatchObject({
        analysisStatus: "deferred",
        acceptedObservationIds: []
      });
      f.revoked.clear();
      expect(await f.observe(meetingId)).toMatchObject({ analysisStatus: "deferred" });
      expect(f.calls()).toBe(1);
      expect((await f.query(meetingId)).synthesis).toBeNull();
    } finally {
      await f.database.close();
    }
  });
});
