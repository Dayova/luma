import { describe, expect, it } from "vitest";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createOpenAIReasoningModel } from "../../src/ai/openai-reasoning-model.js";
import type { ReasoningModel } from "../../src/ai/reasoning-model.js";
import { createNativeNotionReviewMcp } from "../../src/app/native-notion-review-mcp.js";
import { createNativeNotionReviewRuntime } from "../../src/app/native-notion-review-runtime.js";
import {
  createNativeReviewSourceAccess,
  hasNativeReviewSourceBinding
} from "../../src/knowledge/native-review-source-access.js";
import { importedSourceMeetingId } from "../../src/domain/imported-source-provenance.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import type { MeetingNoteEvidenceSource } from "../../src/native-review/source-bound-native-review.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest
} from "../../src/work/linear-read-only-work-catalog.js";
import { createWorkspaceBoundWorkCatalog } from "../../src/app/workspace-bound-work-catalog.js";
import {
  evidence,
  locator,
  providerHarness,
  workspace
} from "./native-notion-review-fixtures.js";

const bearer = "test-native-mcp-unique-bearer-value-0123456789";
async function harness(analyze = false) {
  const h = providerHarness();
  const database = await createPgliteDatabase(),
    ledger = createObservedSourceLedger({ database });
  let searches = 0,
    shared = true,
    available = true,
    captured = evidence();
  let model: ReasoningModel = {
    generateStructured: () =>
      Promise.reject(new Error("No AI is needed for this source reconciliation"))
  };
  let captureGate: (() => Promise<void>) | undefined;
  const source: MeetingNoteEvidenceSource = {
    capture: async () => {
      await captureGate?.();
      return available
        ? { status: "captured", evidence: structuredClone(captured) }
        : {
            status: "unavailable",
            code: "meeting-note-page-not-found",
            message: "Unavailable",
            retryable: false
          };
    }
  };
  const createHistory = (pageId = captured.source.parentObjectId!) =>
    createNativeReviewSourceAccess({
      database,
      workspaceId: workspace.workspaceId,
      pageId,
      ledger,
      access: h.createAccess(),
      evidenceSource: source,
      authorizeSources: () => Promise.resolve(shared)
    });
  const history = createHistory();
  const catalog = createLinearReadOnlyWorkCatalogForTest({
    teamId: "team-dayova",
    api: createLinearReadOnlyApiForTest({
      searchIssues: () => {
        searches++;
        return Promise.resolve([]);
      },
      getIssue: () => Promise.reject(new Error("Unexpected exact lookup"))
    })
  });
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: {
      generateStructured: (request) => model.generateStructured(request)
    },
    workCatalogs: [
      createWorkspaceBoundWorkCatalog({
        workspaceId: workspace.workspaceId,
        providerScopeId: catalog.providerScopeId,
        workCatalog: catalog
      })
    ],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: "linear"
    }),
    ...(analyze
      ? {
          importedSourceAnalysis: {
            audience: () =>
              Promise.resolve({
                workspaceId: workspace.workspaceId,
                personIds: [
                  "person_jakob",
                  "person_fabius",
                  "person_philipp",
                  "person_julius"
                ]
              }),
            access: history.sourceHistoryAccess
          }
        }
      : {})
  });
  const createRuntime = () =>
    createNativeNotionReviewRuntime({
      database,
      workspace,
      ledger,
      meetingIntelligence: mi,
      identityDirectory: h.directory,
      accessPolicy: h.accessPolicy,
      access: h.createAccess(),
      authorizeSources: () => Promise.resolve(shared),
      evidenceSource: source
    });
  const runtime = createRuntime();
  return {
    ...h,
    database,
    ledger,
    mi,
    runtime,
    history,
    createHistory,
    async source() {
      const original = await ledger.get({
        workspaceId: workspace.workspaceId,
        source: {
          providerId: "notion",
          sourceKind: "meeting-note",
          sourceObjectId: "meeting-root"
        },
        revision: 1
      });
      if (!original) throw new Error("Missing original");
      return observedMeetingNoteToObservation(
        { workspace, source: { ...original, change: "unchanged" } },
        "linear"
      ).source;
    },
    async refresh() {
      await ledger.record({
        workspaceId: workspace.workspaceId,
        ...structuredClone(captured)
      });
    },
    createRuntime,
    searches: () => searches,
    share(value: boolean) {
      shared = value;
    },
    remove() {
      available = false;
    },
    change() {
      captured = evidence();
      captured.snapshot.title = "Revised meeting";
    },
    setModel(value: ReasoningModel) {
      model = value;
    },
    setCaptureGate(gate: () => Promise<void>) {
      captureGate = gate;
    },
    interceptObserve(
      replacement: (
        original: MeetingIntelligence["observe"]
      ) => MeetingIntelligence["observe"]
    ) {
      mi.observe = replacement(mi.observe.bind(mi));
    }
  };
}

describe("shared native Notion review", () => {
  it("retains native provenance when disabled or repointed instead of allowing a broader source grant", async () => {
    const h = await harness();
    const repointed = h.createHistory("10000000-0000-4000-8000-000000000001");
    try {
      await h.runtime.review(locator);
      const source = await h.source();
      const request = {
        source,
        audience: { workspaceId: workspace.workspaceId, personIds: ["person_jakob"] }
      };
      expect(await repointed.ownsSource(source)).toBe(true);
      await expect(
        repointed.sourceHistoryAccess.requireCurrent(request)
      ).rejects.toThrow();
      await expect(
        repointed.sourceHistoryAccess.requireRetained(request)
      ).rejects.toThrow();
      await h.runtime.stop();
      await h.history.stop();
      // The main runtime can deny retained native material even with this feature disabled.
      expect(
        await hasNativeReviewSourceBinding({
          database: h.database,
          workspaceId: workspace.workspaceId,
          source
        })
      ).toBe(true);
      expect(
        await hasNativeReviewSourceBinding({
          database: h.database,
          workspaceId: workspace.workspaceId,
          source: { ...source, parentObjectId: "changed-page" }
        })
      ).toBe(true);
      expect(
        await hasNativeReviewSourceBinding({
          database: h.database,
          workspaceId: "another-workspace",
          source
        })
      ).toBe(false);
    } finally {
      await repointed.stop();
      await h.runtime.stop();
      await h.history.stop();
      await h.database.close();
    }
  });
  it("uses only exact original native provenance for current/history access and never backfills an unrecorded source", async () => {
    const h = await harness(true);
    h.setModel(
      createOpenAIReasoningModel({
        model: "gpt-5.6-luna",
        client: {
          create: () =>
            Promise.resolve({
              outputText: JSON.stringify({
                actionItems: [],
                decisions: [],
                openQuestions: [],
                risks: [],
                followUpIntentions: []
              })
            })
        }
      })
    );
    try {
      await h.runtime.review(locator);
      const source = await h.source(),
        audience = { workspaceId: workspace.workspaceId, personIds: ["person_jakob"] };
      expect(await h.history.ownsSource(source)).toBe(true);
      expect(
        await h.history.ownsSource({ ...source, contentHash: `sha256:${"0".repeat(64)}` })
      ).toBe(false);
      await expect(
        h.history.sourceHistoryAccess.requireCurrent({ source, audience })
      ).resolves.toBeUndefined();
      h.change();
      await h.refresh();
      await expect(
        h.history.sourceHistoryAccess.requireCurrent({ source, audience })
      ).rejects.toThrow();
      await expect(
        h.history.sourceHistoryAccess.requireRetained({ source, audience })
      ).resolves.toBeUndefined();
      h.permissions.permissions.pop();
      expect(await h.history.ownsSource(source)).toBe(true);
      await expect(
        h.history.sourceHistoryAccess.requireRetained({ source, audience })
      ).rejects.toThrow();
    } finally {
      await h.runtime.stop();
      await h.history.stop();
      await h.database.close();
    }
  });
  it("refuses old Human resolution when the actual MI judgment changes during final source proof", async () => {
    const h = await harness();
    try {
      const first = await h.runtime.review(locator);
      let capture = 0;
      h.setCaptureGate(async () => {
        if (++capture !== 2) return;
        const update = await h.mi.observe({
          workspace,
          observations: [
            {
              type: "human-judgment-recorded",
              workspaceId: workspace.workspaceId,
              meetingId: importedSourceMeetingId(first.receipt.source!),
              observationId: "native-final-rejection",
              participantId: "person_jakob",
              occurredAt: "2026-09-11T13:00:00.000Z",
              observedAt: "2026-09-11T13:00:00.000Z",
              judgment: {
                kind: "resolve-action-item-reconciliation",
                reviewId: first.reviews[0]!.proposal.id,
                resolution: { type: "reject-proposal", reason: "Not needed" }
              }
            }
          ]
        });
        expect(update.errors).toEqual([]);
      });
      await expect(h.runtime.requireCurrent(locator, first)).rejects.toMatchObject({
        code: "review-unavailable"
      });
    } finally {
      await h.runtime.stop();
      await h.history.stop();
      await h.database.close();
    }
  });
  it("exposes an exhausted shared AI limit while retaining deterministic reconciliation without an SDK call", async () => {
    const h = await harness(true);
    let dispatched = 0;
    const budget = createAiUsageBudget({ database: h.database, monthlyLimitUsd: 0 });
    h.setModel(
      createOpenAIReasoningModel({
        budget,
        model: "gpt-5.6-luna",
        client: {
          create: () => {
            dispatched++;
            return Promise.reject(new Error("Budget exhausted"));
          }
        }
      })
    );
    try {
      const result = await h.runtime.review(locator);
      expect(result.analysis).toMatchObject({
        status: "deferred",
        errors: [{ code: "analysis-budget-exhausted" }]
      });
      expect(dispatched).toBe(0);
      expect((await h.createRuntime().review(locator)).analysis).toEqual(result.analysis);
    } finally {
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("rechecks native founder/source authorization after actual shared AI reservation and before SDK dispatch", async () => {
    const h = await harness(true);
    const budget = createAiUsageBudget({ database: h.database, monthlyLimitUsd: 30 });
    const reserve = budget.reserve.bind(budget);
    let dispatched = 0,
      reserved = 0;
    budget.reserve = async (request) => {
      const result = await reserve(request);
      reserved++;
      h.permissions.permissions.pop();
      return result;
    };
    h.setModel(
      createOpenAIReasoningModel({
        budget,
        model: "gpt-5.6-luna",
        client: {
          create: () => {
            dispatched++;
            return Promise.reject(new Error("Private source must not reach model"));
          }
        }
      })
    );
    try {
      await expect(h.runtime.review(locator)).rejects.toThrow();
      expect(reserved).toBe(1);
      expect(dispatched).toBe(0);
      expect((await budget.getStatus(workspace.workspaceId)).reservedUsd).toBe(0);
    } finally {
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("retains a slow post-reservation proof through AI timeout and drains it before closing the shared store", async () => {
    const h = await harness(true);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const budget = createAiUsageBudget({ database: h.database, monthlyLimitUsd: 30 }),
      reserve = budget.reserve.bind(budget);
    let armed = false,
      dispatched = 0;
    h.setCaptureGate(async () => {
      if (armed) {
        armed = false;
        entered();
        await hold;
        await h.database.query("SELECT 1");
      }
    });
    budget.reserve = async (request) => {
      const result = await reserve(request);
      armed = true;
      return result;
    };
    h.setModel(
      createOpenAIReasoningModel({
        budget,
        model: "gpt-5.6-luna",
        limits: { timeoutMs: 50 },
        client: {
          create: () => {
            dispatched++;
            return Promise.reject(new Error("Late provider dispatch"));
          }
        }
      })
    );
    try {
      const run = h.runtime.review(locator);
      await ready;
      await run;
      let stopped = false;
      const stop = h.runtime.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stop;
      expect(dispatched).toBe(0);
    } finally {
      release?.();
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("uses actual provider proof and the same MI; replay after rebuild rechecks access without another catalog query", async () => {
    const h = await harness();
    try {
      const first = await h.runtime.review(locator);
      expect(first.receipt.outcome.type).toBe("reviewed");
      expect(first.reviews).toHaveLength(1);
      expect(first.reviews[0]?.status).toBe("proposed");
      expect(h.searches()).toBeGreaterThan(0);
      const searches = h.searches(),
        providerReads = h.requests.length;
      const rebuilt = h.createRuntime();
      expect(await rebuilt.review(locator)).toEqual(first);
      expect(h.searches()).toBe(searches);
      expect(h.requests.length).toBeGreaterThan(providerReads);
      expect(
        (await h.database.query("SELECT * FROM native_review_instructions")).rows
      ).toHaveLength(1);
      expect(
        (await h.database.query("SELECT * FROM source_bound_native_reviews")).rows
      ).toHaveLength(1);
      await rebuilt.stop();
    } finally {
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it.each(["source-edit", "deletion", "sharing", "guest-audience", "event-edit"])(
    "withholds %s replay and final response",
    async (kind) => {
      const h = await harness();
      try {
        const first = await h.runtime.review(locator),
          count = h.searches();
        if (kind === "source-edit") h.change();
        if (kind === "deletion") h.remove();
        if (kind === "sharing") h.share(false);
        if (kind === "guest-audience") h.permissions.permissions.pop();
        if (kind === "event-edit") h.event.content[0]!.text += " changed";
        await expect(h.runtime.review(locator)).rejects.toThrow();
        await expect(h.runtime.requireCurrent(locator, first)).rejects.toThrow();
        expect(h.searches()).toBe(count);
      } finally {
        await h.runtime.stop();
        await h.database.close();
      }
    }
  );
  it("rechecks sharing after the durable instruction write and before any source persistence", async () => {
    const h = await harness();
    const original = h.database.query.bind(h.database);
    h.database.query = async <T>(...args: Parameters<typeof h.database.query>) => {
      const result = await original<T>(...args);
      const sql = args[0];
      if (sql.includes("INSERT INTO native_review_instructions")) h.share(false);
      return result;
    };
    try {
      await expect(h.runtime.review(locator)).rejects.toMatchObject({
        code: "access-unavailable"
      });
      expect(h.searches()).toBe(0);
      expect(
        (await h.database.query("SELECT * FROM observed_sources")).rows
      ).toHaveLength(0);
    } finally {
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("withholds a source edit during the final MI query", async () => {
    const h = await harness();
    try {
      const first = await h.runtime.review(locator);
      const query = h.mi.query.bind(h.mi);
      h.mi.query = async (request) => {
        const result = await query(request);
        h.change();
        return result;
      };
      await expect(h.runtime.requireCurrent(locator, first)).rejects.toMatchObject({
        code: "source-changed"
      });
    } finally {
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("drains an admitted shared ingestion while refusing new requests", async () => {
    const h = await harness();
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    h.interceptObserve((original) => async (request) => {
      entered();
      await hold;
      return original(request);
    });
    try {
      const active = h.runtime.review(locator);
      await ready;
      let done = false;
      const stop = h.runtime.stop().then(() => {
        done = true;
      });
      await expect(h.runtime.review(locator)).rejects.toMatchObject({ code: "stopped" });
      expect(done).toBe(false);
      release();
      await active;
      await stop;
      expect(done).toBe(true);
    } finally {
      release?.();
      await h.runtime.stop();
      await h.database.close();
    }
  });
  it("dispatches the real MCP tool through the native provider, shared MI, and final disclosure fence", async () => {
    const h = await harness();
    const http = createNativeNotionReviewMcp({
      runtime: h.runtime,
      bearerToken: bearer,
      port: 0
    });
    const bound = await http.start(),
      url = `http://127.0.0.1:${bound.port}/notion/review/mcp`;
    const call = (body: unknown, authorization = bearer, origin?: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorization}`,
          ...(origin ? { origin } : {})
        },
        body: JSON.stringify(body)
      });
    try {
      expect(
        (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "bad")).status
      ).toBe(401);
      expect(
        (
          await call(
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            bearer,
            "https://evil.test"
          )
        ).status
      ).toBe(403);
      expect(
        (
          await call({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "review_meeting_note",
              arguments: { ...locator, actor: "Jakob" }
            }
          })
        ).status
      ).toBe(200);
      expect(h.requests).toHaveLength(0);
      const body: unknown = await (
        await call({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "review_meeting_note", arguments: locator }
        })
      ).json();
      expect(body).toMatchObject({ result: { isError: false } });
      expect(JSON.stringify(body)).toContain("prepare release checklist");
      h.permissions.permissions.pop();
      const denied: unknown = await (
        await call({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "review_meeting_note", arguments: locator }
        })
      ).json();
      expect(denied).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(denied)).not.toContain("prepare release checklist");
    } finally {
      await http.stop();
      await h.database.close();
    }
  });
});
