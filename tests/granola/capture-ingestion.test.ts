import { describe, expect, it, vi } from "vitest";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingCaptureIngestion } from "../../src/knowledge/meeting-capture-ingestion.js";
import { createGranolaMeetingCaptureAccess } from "../../src/granola/meeting-capture-access.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createGranolaCaptureIngestionRuntime } from "../../src/granola/capture-ingestion-runtime.js";
import {
  GranolaSourceError,
  type GranolaMcpClient,
  type GranolaReadTool
} from "../../src/granola/mcp-client.js";
import type { GranolaConnectionPolicy } from "../../src/granola/policy.js";
import { granolaAccountFingerprint } from "../../src/granola/wire-format.js";
import type { MeetingCaptureRevision } from "../../src/logical-meetings/interface.js";
const workspaceId = "dayova";
const text = (value: string) => ({
  content: [{ type: "text", text: value }],
  isError: false
});
function document(
  id: string,
  content = "Wir könnten nächste Woche starten.",
  people = "Jakob (note creator) <jakob@dayova.test>\nFabius <fabius@dayova.test>"
) {
  return `<meeting id="${id}" title="Luma weekly" date="Sep 11, 2026 9:00 AM"><known_participants>${people}</known_participants><summary>${content}</summary></meeting>`;
}
function fixture(connectionId = "jakob", include: string[] = ["work"]) {
  let info = text(`Account ${connectionId}; active workspace Dayova`);
  const calls: Array<{ name: GranolaReadTool; args: Record<string, unknown> }> = [];
  const documents = new Map([
    ["work", document("work")],
    [
      "personal",
      document("personal", "PRIVATE PERSONAL MATERIAL", "Friend <friend@example.test>")
    ]
  ]);
  const policy: GranolaConnectionPolicy = {
    connectionId,
    ownerPersonId: "person_jakob",
    optInId: "explicit-connection-opt-in-1",
    accountFingerprint: granolaAccountFingerprint(info),
    enabled: true,
    audiencePersonIds: ["person_jakob"],
    automaticInternalMeetings: false,
    participantDirectory: [],
    includedMeetingIds: include,
    excludedMeetingIds: []
  };
  let beforeCall: ((name: GranolaReadTool) => Promise<void>) | undefined;
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
    call: async (name, args) => {
      calls.push({ name, args });
      await beforeCall?.(name);
      if (name === "get_account_info") return info;
      if (name === "list_meetings")
        return text(
          `<meetings_data count="${documents.size}">${[...documents.values()].join("\n")}</meetings_data>`
        );
      const ids = args["meeting_ids"] as string[];
      return text(documents.get(ids[0]!) ?? "The meeting is unavailable");
    }
  };
  return {
    client,
    policy,
    calls,
    documents,
    changeAccount: () => {
      info = text("Account different; workspace Private");
    },
    beforeCall: (callback: (name: GranolaReadTool) => Promise<void>) => {
      beforeCall = callback;
    }
  };
}
async function latest(
  database: Awaited<ReturnType<typeof createPgliteDatabase>>,
  connection = "jakob",
  capture = "work"
) {
  const rows = await database.query<{ descriptor_json: string }>(
    "SELECT descriptor_json FROM granola_capture_revisions WHERE connection_id=$1 AND capture_id=$2 ORDER BY revision DESC LIMIT 1",
    [connection, capture]
  );
  return JSON.parse(rows.rows[0]!.descriptor_json) as MeetingCaptureRevision;
}

describe("Granola capture ingestion through LogicalMeetings", () => {
  it("enumerates every retained capture beyond the first page, without duplicate revisions or foreign scopes", async () => {
    const database = await createPgliteDatabase();
    const f = fixture("jakob", ["work", "explicit-new"]);
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
    });
    try {
      const source = runtime.sources[0]!;
      await source.fetchCapture({
        workspaceId,
        capture: {
          providerId: "granola",
          providerConnectionId: "jakob",
          externalCaptureId: "work",
          sourceKind: "meeting-capture"
        }
      });
      await database.query(
        `INSERT INTO granola_capture_revisions
        SELECT workspace_id,connection_id,'retained-' || lpad(n::text,4,'0'),r,
          descriptor_json,material,audience_json,account_fingerprint,opt_in_id
        FROM granola_capture_revisions CROSS JOIN generate_series(1,1001) n CROSS JOIN generate_series(1,2) r
        WHERE workspace_id=$1 AND connection_id='jakob' AND capture_id='work' AND revision=1`,
        [workspaceId]
      );
      await database.query(
        `INSERT INTO granola_capture_revisions
        SELECT 'another-workspace',connection_id,'foreign-workspace',revision,descriptor_json,material,audience_json,account_fingerprint,opt_in_id
        FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id='jakob' AND capture_id='work' AND revision=1`,
        [workspaceId]
      );
      await database.query(
        `INSERT INTO granola_capture_revisions
        SELECT workspace_id,'another-connection','foreign-connection',revision,descriptor_json,material,audience_json,account_fingerprint,opt_in_id
        FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id='jakob' AND capture_id='work' AND revision=1`,
        [workspaceId]
      );
      const known = await source.knownCaptures();
      const ids = known.map((capture) => capture.externalCaptureId);
      expect(ids).toHaveLength(1003);
      expect(new Set(ids).size).toBe(1003);
      expect(ids).toEqual(
        expect.arrayContaining(["retained-0501", "retained-1001", "work", "explicit-new"])
      );
      expect(ids).not.toContain("foreign-workspace");
      expect(ids).not.toContain("foreign-connection");
      expect(f.calls.filter((call) => call.name === "get_meetings")).toHaveLength(1);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it("drains a failed in-flight report without rejecting shutdown or losing its failure status", async () => {
    const database = await createPgliteDatabase();
    const f = fixture();
    let entered!: () => void, rejectReport!: (error: Error) => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const report = new Promise<void>((_resolve, reject) => {
      rejectReport = reject;
    });
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) },
      report: () => {
        entered();
        return report;
      }
    });
    try {
      const sync = runtime.syncOnce();
      const failed = expect(sync).rejects.toMatchObject({ code: "source-unavailable" });
      await entry;
      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      const drained = expect(stopping).resolves.toBeUndefined();
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(runtime.syncOnce()).rejects.toMatchObject({
        code: "connection-unavailable"
      });
      rejectReport(new Error("Status reporting unavailable"));
      await failed;
      await drained;
      expect(runtime.status()).toMatchObject({
        active: false,
        scheduled: false,
        lastFailure: "source-unavailable"
      });
    } finally {
      rejectReport(new Error("Cleanup"));
      await runtime.stop();
      await database.close();
    }
  });
  it("reports each connection's actual scan and failures without borrowing another owner's result", async () => {
    const database = await createPgliteDatabase();
    const first = fixture("jakob"),
      second = fixture("fabius");
    second.policy.ownerPersonId = "person_fabius";
    second.policy.audiencePersonIds = ["person_fabius"];
    first.beforeCall(() => Promise.reject(new GranolaSourceError("rate-limited")));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    second.beforeCall(() => held);
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [
        { connectionId: "jakob", client: first.client },
        { connectionId: "fabius", client: second.client }
      ],
      policy: {
        read: (id) =>
          Promise.resolve(structuredClone(id === "jakob" ? first.policy : second.policy))
      }
    });
    try {
      expect(runtime.connectionStatus("unknown")).toBeNull();
      expect(runtime.connectionStatus("fabius")).toMatchObject({
        active: false,
        checked: false,
        scheduled: false,
        failureCodes: []
      });
      runtime.start();
      await vi.waitFor(() =>
        expect(runtime.connectionStatus("fabius")?.active).toBe(true)
      );
      expect(runtime.connectionStatus("jakob")).toEqual({
        active: false,
        checked: true,
        scheduled: true,
        failureCodes: ["rate-limited"]
      });
      expect(runtime.connectionStatus("fabius")).toEqual({
        active: true,
        checked: false,
        scheduled: true,
        failureCodes: []
      });
      release();
      await vi.waitFor(() => expect(runtime.status().active).toBe(false));
      expect(runtime.connectionStatus("fabius")).toEqual({
        active: false,
        checked: true,
        scheduled: true,
        failureCodes: []
      });
    } finally {
      release();
      await runtime.stop();
      await database.close();
    }
  });
  it("never reports an interrupted or unvisited connection as a completed scan", async () => {
    const database = await createPgliteDatabase();
    const first = fixture("jakob"),
      second = fixture("fabius");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.beforeCall(() => held);
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [
        { connectionId: "jakob", client: first.client },
        { connectionId: "fabius", client: second.client }
      ],
      policy: {
        read: (id) =>
          Promise.resolve(structuredClone(id === "jakob" ? first.policy : second.policy))
      }
    });
    try {
      runtime.start();
      await vi.waitFor(() => expect(first.calls.length).toBeGreaterThan(0));
      const stopping = runtime.stop();
      expect(runtime.connectionStatus("jakob")).toEqual({
        active: true,
        checked: false,
        scheduled: false,
        failureCodes: []
      });
      release();
      await stopping;
      expect(runtime.connectionStatus("jakob")).toEqual({
        active: false,
        checked: false,
        scheduled: false,
        failureCodes: []
      });
      expect(runtime.connectionStatus("fabius")).toEqual({
        active: false,
        checked: false,
        scheduled: false,
        failureCodes: []
      });
      expect(second.calls).toEqual([]);
    } finally {
      release();
      await runtime.stop();
      await database.close();
    }
  });

  it("delivers the actual guarded Basic capture into MI synthesis within the owned ingestion run", async () => {
    const database = await createPgliteDatabase();
    const f = fixture();
    const requests: StructuredReasoningRequest<unknown>[] = [];
    let exhausted = false;
    let meetingId = "";
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) },
      onResolved: (meeting) => {
        meetingId = meeting.id;
        return ingestion.ingest(meeting);
      }
    });
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
          requests.push(request);
          if (exhausted)
            throw new AiServiceError("budget-exhausted", "Budget is exhausted", {
              requestDispatched: false
            });
          const evidence = request.evidence[0]!;
          const value: CaptureSynthesisProposal = {
            claims: [
              {
                key: "launch",
                kind: "question",
                text: "Start bleibt ein Vorschlag.",
                evidenceIds: [evidence.evidenceId],
                confidence: "medium",
                quotations: [],
                conflictingKeys: []
              }
            ]
          };
          return Promise.resolve({
            value: value as T,
            metadata: {
              provider: "fixture",
              model: "fixture",
              promptVersion: request.promptVersion
            }
          });
        }
      },
      captureSynthesis: {
        logicalMeetings: runtime.logicalMeetings,
        access: createGranolaMeetingCaptureAccess({
          sources: [{ connectionId: "jakob", source: runtime.sources[0]! }]
        }),
        audience: () => Promise.resolve({ workspaceId, personIds: ["person_jakob"] })
      }
    });
    const ingestion = createMeetingCaptureIngestion({
      workspace: { workspaceId, timezone: "Europe/Berlin" },
      meetingIntelligence: mi
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({
        accepted: 1,
        withheld: 1,
        failures: []
      });
      const query = () =>
        mi.query({ workspaceId, meetingId, query: { type: "capture-synthesis" } });
      expect(await query()).toMatchObject({
        availability: "available",
        synthesis: {
          revision: 1,
          canonicalAnchorRef: null,
          coverage: "partial",
          claims: [{ text: "Start bleibt ein Vorschlag.", quotations: [] }]
        }
      });
      expect(JSON.stringify(requests)).not.toContain("PRIVATE PERSONAL MATERIAL");
      expect(requests[0]?.evidence[0]?.source).toBe("knowledge");
      expect(await runtime.syncOnce()).toMatchObject({ unchanged: 1, failures: [] });
      expect(requests).toHaveLength(1);
      exhausted = true;
      f.documents.set(
        "work",
        document("work", "A revised, still conditional launch proposal.")
      );
      expect(await runtime.syncOnce()).toMatchObject({
        failures: [{ connectionId: "jakob", code: "analysis-budget-exhausted" }]
      });
      expect(runtime.connectionStatus("jakob")).toMatchObject({
        checked: true,
        failureCodes: ["analysis-budget-exhausted"]
      });
      f.policy.excludedMeetingIds.push("work");
      expect(await query()).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it("discovers an eligible Basic capture, retains derived Evidence, and replays unchanged content without new revisions or bindings", async () => {
    const database = await createPgliteDatabase();
    const f = fixture();
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({
        status: "partial",
        accepted: 1,
        withheld: 1,
        failures: []
      });
      const first = await latest(database);
      expect(first.capabilities).toMatchObject({
        rawTranscript: "unavailable",
        speakerIdentity: "unavailable"
      });
      expect(first.materials).toEqual([
        expect.objectContaining({ kind: "derived-notes", provenance: "provider-derived" })
      ]);
      expect(first.identityFacts.interval).toBeNull();
      expect(first.identityFacts.attendeePersonIds).toEqual([]);
      const material = await runtime.sources[0]!.readCurrent({
        revision: first,
        audience: { workspaceId, personIds: ["person_jakob"] }
      });
      expect(material.text).toContain("könnten");
      expect(material.provenance).toBe("provider-derived");
      expect(await runtime.syncOnce()).toMatchObject({ accepted: 1, unchanged: 1 });
      expect((await latest(database)).sourceRevision).toBe(1);
      const rows = await database.query<{ material: string | null }>(
        "SELECT material FROM granola_capture_revisions WHERE capture_id='personal'"
      );
      expect(rows.rows.map((row) => row.material)).toEqual([null]);
      expect(
        f.calls
          .filter((call) => call.name === "get_meetings")
          .every((call) => JSON.stringify(call.args).includes("work"))
      ).toBe(true);
      f.documents.set("work", document("work", "Das ist noch keine Entscheidung."));
      expect(await runtime.syncOnce()).toMatchObject({ accepted: 1, unchanged: 0 });
      expect((await latest(database)).sourceRevision).toBe(2);
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM logical_meetings"
          )
        ).rows[0]!.count
      ).toBe(1);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it("keeps original audiences immutable and denies old source reads after exclusion, live edit, account switch or policy change during fetch", async () => {
    const database = await createPgliteDatabase();
    const f = fixture();
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
    });
    try {
      await runtime.syncOnce();
      const revision = await latest(database);
      const source = runtime.sources[0]!;
      const originalBinding = await runtime.logicalMeetings.resolveCapture({
        workspaceId,
        revision
      });
      if (originalBinding.status !== "accepted")
        throw new Error("Expected accepted binding");
      f.policy.audiencePersonIds.push("person_fabius");
      await runtime.syncOnce();
      await expect(
        source.readCurrent({
          revision,
          audience: { workspaceId, personIds: ["person_fabius"] }
        })
      ).rejects.toThrow("policy-withheld");
      f.policy.excludedMeetingIds.push("work");
      await expect(
        source.readCurrent({
          revision,
          audience: { workspaceId, personIds: ["person_jakob"] }
        })
      ).rejects.toThrow("policy-withheld");
      expect(await runtime.syncOnce()).toMatchObject({ withheld: 2, accepted: 0 });
      expect(
        (
          await runtime.logicalMeetings.get({
            workspaceId,
            logicalMeetingId: originalBinding.decision.logicalMeeting.id
          })
        )?.captureRefs
      ).toEqual([]);
      f.policy.excludedMeetingIds = [];
      f.documents.set("work", document("work", "changed material"));
      await expect(
        source.readCurrent({
          revision,
          audience: { workspaceId, personIds: ["person_jakob"] }
        })
      ).rejects.toThrow("source-changed");
      f.changeAccount();
      await expect(
        source.fetchCapture({ workspaceId, capture: revision.address })
      ).rejects.toThrow("policy-withheld");
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it("fences a privacy change during provider I/O before raw material is committed", async () => {
    const database = await createPgliteDatabase();
    const f = fixture();
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
    });
    f.beforeCall((name) => {
      if (name === "get_meetings") f.policy.excludedMeetingIds.push("work");
      return Promise.resolve();
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({
        accepted: 0,
        failures: [expect.objectContaining({ code: "policy-withheld" })]
      });
      expect(
        (
          await database.query(
            "SELECT material FROM granola_capture_revisions WHERE material IS NOT NULL"
          )
        ).rows
      ).toEqual([]);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it("automatically imports only opted-in internal founder meetings and lets explicit inclusion admit an ambiguous capture later", async () => {
    const database = await createPgliteDatabase();
    const f = fixture("jakob", []);
    f.policy.automaticInternalMeetings = true;
    f.policy.participantDirectory = [
      { email: "jakob@dayova.test", personId: "person_jakob" },
      { email: "fabius@dayova.test", personId: "person_fabius" }
    ];
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [{ connectionId: "jakob", client: f.client }],
      policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({ accepted: 1, withheld: 1 });
      f.policy.includedMeetingIds.push("personal");
      expect(await runtime.syncOnce()).toMatchObject({ accepted: 2 });
      const capture = await latest(database, "jakob", "personal");
      expect(capture.eligibility.state).toBe("eligible");
      expect(capture.sourceRevision).toBe(2);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
  it.each(["summary", "notes", "unknown_section"])(
    "withholds participant markup nested inside %s instead of using it as eligibility metadata",
    async (section) => {
      const database = await createPgliteDatabase();
      const f = fixture("jakob", []);
      f.policy.automaticInternalMeetings = true;
      f.policy.participantDirectory = [
        { email: "jakob@dayova.test", personId: "person_jakob" },
        { email: "fabius@dayova.test", personId: "person_fabius" }
      ];
      f.documents.clear();
      f.documents.set(
        "personal",
        `<meeting id="personal" title="Personal note" date="today"><${section}>PRIVATE PERSONAL MATERIAL <known_participants>Jakob &lt;jakob@dayova.test&gt;\nFabius &lt;fabius@dayova.test&gt;</known_participants></${section}></meeting>`
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
      );
      const runtime = await createGranolaCaptureIngestionRuntime({
        database,
        workspaceId,
        connections: [{ connectionId: "jakob", client: f.client }],
        policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
      });
      try {
        expect(await runtime.syncOnce()).toMatchObject({ accepted: 0 });
        const rows = await database.query<{ material: string | null }>(
          "SELECT material FROM granola_capture_revisions"
        );
        expect(rows.rows.every((row) => row.material === null)).toBe(true);
        expect(f.calls.some((call) => call.name === "get_meetings")).toBe(false);
      } finally {
        await runtime.stop();
        await database.close();
      }
    }
  );

  it("keeps same provider IDs isolated across personal connections and drains admitted sync before stopping", async () => {
    const database = await createPgliteDatabase();
    const a = fixture("jakob"),
      b = fixture("fabius");
    b.policy.ownerPersonId = "person_fabius";
    b.policy.audiencePersonIds = ["person_fabius"];
    b.documents.set("work", document("work", "Different capture"));
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      connections: [
        { connectionId: "jakob", client: a.client },
        { connectionId: "fabius", client: b.client }
      ],
      policy: {
        read: (id) =>
          Promise.resolve(structuredClone(id === "jakob" ? a.policy : b.policy))
      }
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({ accepted: 2 });
      expect((await latest(database, "jakob")).contentHash).not.toBe(
        (await latest(database, "fabius")).contentHash
      );
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      a.beforeCall(async (name) => {
        if (name === "get_meetings") {
          entered();
          await wait;
        }
      });
      const active = runtime.syncOnce();
      await entry;
      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(runtime.syncOnce()).rejects.toThrow();
      release();
      await active;
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });
});

it("ingests through the real authenticated HTTP client, decoder, archive and LogicalMeetings composition", async () => {
  const { createGranolaMcpClient } = await import("../../src/granola/mcp-client.js");
  const database = await createPgliteDatabase();
  const f = fixture();
  const client = createGranolaMcpClient({
    credential: () =>
      Promise.resolve({
        accessToken: "fixture-only",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
    fetch: async (_url, options) => {
      if (typeof options?.body !== "string") throw new Error("Expected JSON request");
      const envelope = JSON.parse(options.body) as {
        id: number;
        method: string;
        params: { name: GranolaReadTool; arguments: Record<string, unknown> };
      };
      if (envelope.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        envelope.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : envelope.method === "tools/list"
            ? { tools: await f.client.tools() }
            : await f.client.call(envelope.params.name, envelope.params.arguments);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result }), {
        headers: { "content-type": "application/json" }
      });
    }
  });
  const runtime = await createGranolaCaptureIngestionRuntime({
    database,
    workspaceId,
    connections: [{ connectionId: "jakob", client }],
    policy: { read: () => Promise.resolve(structuredClone(f.policy)) }
  });
  try {
    expect(await runtime.syncOnce()).toMatchObject({
      accepted: 1,
      withheld: 1,
      failures: []
    });
    const material = await runtime.sources[0]!.readCurrent({
      revision: await latest(database),
      audience: { workspaceId, personIds: ["person_jakob"] }
    });
    expect(material.text).toContain("könnten");
    expect(material.provenance).toBe("provider-derived");
  } finally {
    await runtime.stop();
    await database.close();
  }
});

it("periodically discovers a newly eligible meeting and owns asynchronous status reporting through shutdown", async () => {
  const database = await createPgliteDatabase();
  const f = fixture();
  f.policy.automaticInternalMeetings = true;
  f.policy.participantDirectory = [
    { email: "jakob@dayova.test", personId: "person_jakob" },
    { email: "fabius@dayova.test", personId: "person_fabius" }
  ];
  let firstReport!: () => void;
  const first = new Promise<void>((resolve) => {
    firstReport = resolve;
  });
  let secondReport!: () => void;
  const second = new Promise<void>((resolve) => {
    secondReport = resolve;
  });
  let releaseReport!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  let reports = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const runtime = await createGranolaCaptureIngestionRuntime({
    database,
    workspaceId,
    intervalMs: 60_000,
    connections: [{ connectionId: "jakob", client: f.client }],
    policy: { read: () => Promise.resolve(structuredClone(f.policy)) },
    report: async () => {
      reports += 1;
      if (reports === 1) firstReport();
      if (reports === 2) {
        secondReport();
        await gate;
      }
    }
  });
  try {
    runtime.start();
    await first;
    f.documents.set("new-work", document("new-work", "Eine neue Besprechung."));
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    expect(runtime.status().lastResult).toMatchObject({ accepted: 2 });
    let stopped = false;
    const stop = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseReport();
    await stop;
    expect(runtime.status()).toMatchObject({
      active: false,
      scheduled: false,
      lastFailure: null
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports).toBe(2);
  } finally {
    releaseReport();
    await runtime.stop();
    vi.useRealTimers();
    await database.close();
  }
});
