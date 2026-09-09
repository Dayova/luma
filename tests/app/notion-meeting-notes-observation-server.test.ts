import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { CreateNotionWebhookHttpServerInput } from "../../src/app/notion-webhook-http-server.js";
import {
  startNotionMeetingNotesObservationServer,
  type RunningNotionMeetingNotesObservationServer
} from "../../src/app/notion-meeting-notes-observation-server.js";
import type {
  NotionMeetingNotesSource,
  NotionMeetingNotesSourceConfig
} from "../../src/knowledge/notion-meeting-notes-source.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyWorkCatalogConfig
} from "../../src/work/linear-read-only-work-catalog.js";

const lumaWorkspaceId = "workspace_dayova";
const notionWorkspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const canonicalMeetingsDataSourceId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const subscriptionId = "cccccccc-dddd-eeee-ffff-000000000000";
const integrationId = "dddddddd-eeee-ffff-0000-111111111111";
const meetingPageId = "11111111-2222-3333-4444-555555555555";
const verificationToken = "dedicated-observation-webhook-token";

class RecordingSource implements NotionMeetingNotesSource {
  readonly scans: Array<{ workspaceId: string }> = [];
  readonly refreshes: Array<{ workspaceId: string; pageId: string }> = [];

  scan(input: { workspaceId: string }) {
    this.scans.push(input);
    return Promise.resolve({
      records: [],
      nextCursor: null,
      completeness: "complete" as const,
      partialReasons: []
    });
  }

  refreshPage(input: { workspaceId: string; pageId: string }) {
    this.refreshes.push(input);
    return Promise.resolve({
      status: "ignored" as const,
      records: [],
      completeness: "complete" as const,
      partialReasons: []
    });
  }
}

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("test observation server does not invoke model analysis")
    );
  }
}

function eventually(predicate: () => boolean, message: string): Promise<void> {
  return (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) {
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(message);
  })();
}

function requirePresent<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }

  return value;
}

function observationEnv(): NodeJS.ProcessEnv {
  return {
    LUMA_OBSERVATION_WORKSPACE_ID: lumaWorkspaceId,
    LUMA_NOTION_OBSERVATION_WORKSPACE_ID: notionWorkspaceId,
    LUMA_NOTION_OBSERVATION_MEETINGS_DATA_SOURCE_ID: canonicalMeetingsDataSourceId,
    LUMA_NOTION_OBSERVATION_READONLY_API_TOKEN: "dedicated-notion-read-token",
    LUMA_NOTION_OBSERVATION_SUBSCRIPTION_ID: subscriptionId,
    LUMA_NOTION_OBSERVATION_INTEGRATION_ID: integrationId,
    LUMA_NOTION_OBSERVATION_WEBHOOK_VERIFICATION_TOKEN: verificationToken,
    LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR: ".luma/notion-observation-test",
    LINEAR_READONLY_API_KEY: "dedicated-linear-read-key",
    LINEAR_TEAM_ID: "team-dayova",
    OPENAI_API_KEY: "analysis-only-token"
  };
}

function signedDelivery(): {
  rawBody: Uint8Array;
  headers: { "x-notion-signature": string };
} {
  const rawBody = Buffer.from(
    JSON.stringify({
      id: "eeeeeeee-ffff-0000-1111-222222222222",
      timestamp: "2026-08-11T12:00:00.000Z",
      workspace_id: notionWorkspaceId,
      subscription_id: subscriptionId,
      integration_id: integrationId,
      type: "page.content_updated",
      entity: { id: meetingPageId, type: "page" }
    }),
    "utf8"
  );

  return {
    rawBody,
    headers: {
      "x-notion-signature": `sha256=${createHmac("sha256", verificationToken)
        .update(rawBody)
        .digest("hex")}`
    }
  };
}

describe("Notion Meeting Notes observation server", () => {
  it("does not fall back to standard Notion or writer Linear credentials", async () => {
    await expect(
      startNotionMeetingNotesObservationServer({
        NOTION_API_TOKEN: "writer-notion-token",
        NOTION_MEETINGS_DATA_SOURCE_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        LINEAR_API_KEY: "writer-linear-key",
        LINEAR_TEAM_ID: "cccccccc-dddd-eeee-ffff-000000000000"
      })
    ).rejects.toThrow("LUMA_NOTION_OBSERVATION_READONLY_API_TOKEN is required");
  });

  it.each([
    "NOTION_API_TOKEN",
    "LINEAR_API_KEY",
    "LUMA_NATIVE_NOTION_READONLY_API_TOKEN",
    "DISCORD_TOKEN"
  ])("rejects the ambient incompatible credential %s", async (key) => {
    const env = observationEnv();
    env[key] = "incompatible-ambient-credential";
    let openedDatabase = false;

    await expect(
      startNotionMeetingNotesObservationServer(env, {
        createDatabase() {
          openedDatabase = true;
          return Promise.reject(new Error("database must not open"));
        }
      })
    ).rejects.toThrow(`${key} must not be configured`);
    expect(openedDatabase).toBe(false);
  });

  it("refuses the ordinary server's PGlite directory before opening a database", async () => {
    const env = observationEnv();
    env["LUMA_PGLITE_DATA_DIR"] = ".luma/shared";
    env["LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR"] = ".luma/shared";

    await expect(startNotionMeetingNotesObservationServer(env)).rejects.toThrow(
      "must identify dedicated durable storage"
    );
  });

  it("refuses an equivalent filesystem spelling of the ordinary server's PGlite directory", async () => {
    const env = observationEnv();
    env["LUMA_PGLITE_DATA_DIR"] = ".luma/shared";
    env["LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR"] = "./.luma/observer/../shared";
    let openedDatabase = false;

    await expect(
      startNotionMeetingNotesObservationServer(env, {
        createDatabase() {
          openedDatabase = true;
          return Promise.reject(new Error("database must not open"));
        }
      })
    ).rejects.toThrow("must identify dedicated durable storage");
    expect(openedDatabase).toBe(false);
  });

  it("refuses a symlink to the ordinary server's PGlite directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-notion-observer-"));
    const shared = join(root, "shared");
    const observerAlias = join(root, "observer-alias");
    await mkdir(shared);
    await symlink(shared, observerAlias);
    const env = observationEnv();
    env["LUMA_PGLITE_DATA_DIR"] = shared;
    env["LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR"] = observerAlias;
    let openedDatabase = false;

    try {
      await expect(
        startNotionMeetingNotesObservationServer(env, {
          createDatabase() {
            openedDatabase = true;
            return Promise.reject(new Error("database must not open"));
          }
        })
      ).rejects.toThrow("must identify dedicated durable storage");
      expect(openedDatabase).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a logical Luma workspace that aliases the Notion provider workspace", async () => {
    const env = observationEnv();
    env["LUMA_OBSERVATION_WORKSPACE_ID"] = notionWorkspaceId;
    let openedDatabase = false;

    await expect(
      startNotionMeetingNotesObservationServer(env, {
        createDatabase() {
          openedDatabase = true;
          return Promise.reject(new Error("database must not open"));
        }
      })
    ).rejects.toThrow("must be distinct from LUMA_NOTION_OBSERVATION_WORKSPACE_ID");
    expect(openedDatabase).toBe(false);
  });

  it("refuses the fixed-page native Notion credential even when it differs", async () => {
    const env = observationEnv();
    env["LUMA_NATIVE_NOTION_READONLY_API_TOKEN"] = "separate-native-token";
    let openedDatabase = false;

    await expect(
      startNotionMeetingNotesObservationServer(env, {
        createDatabase() {
          openedDatabase = true;
          return Promise.reject(new Error("database must not open"));
        }
      })
    ).rejects.toThrow("LUMA_NATIVE_NOTION_READONLY_API_TOKEN must not be configured");
    expect(openedDatabase).toBe(false);
  });

  it("assembles a dedicated Notion-only observer with logical and provider workspaces kept distinct", async () => {
    const source = new RecordingSource();
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      teamId: "team-dayova",
      api: createLinearReadOnlyApiForTest({
        searchIssues: () => Promise.resolve([]),
        getIssue: () => Promise.reject(new Error("no lookup expected"))
      })
    });
    let database: LumaDatabase | null = null;
    let sourceConfig: NotionMeetingNotesSourceConfig | null = null;
    let readOnlyCatalogConfig: LinearReadOnlyWorkCatalogConfig | null = null;
    let httpInput: CreateNotionWebhookHttpServerInput | null = null;
    let running: RunningNotionMeetingNotesObservationServer | null = null;

    try {
      running = await startNotionMeetingNotesObservationServer(observationEnv(), {
        async createDatabase(dataDir) {
          void dataDir;
          database = await createPgliteDatabase();
          return database;
        },
        createMeetingNotesSource(config) {
          sourceConfig = config;
          return source;
        },
        createReadOnlyWorkCatalog(config) {
          readOnlyCatalogConfig = config;
          return catalog;
        },
        createReasoningModel() {
          return new NoAnalysisReasoningModel();
        },
        createHttpServer(input) {
          httpInput = input;
          return {
            start() {
              input.observationHost.start();
              return Promise.resolve({ hostname: "127.0.0.1", port: 43210 });
            },
            stop() {
              return input.observationHost.stop();
            }
          };
        }
      });

      expect(running.address).toEqual({ hostname: "127.0.0.1", port: 43210 });
      const configuredSource = requirePresent<NotionMeetingNotesSourceConfig>(
        sourceConfig,
        "source factory was not called"
      );
      expect(configuredSource).toMatchObject({
        token: "dedicated-notion-read-token",
        meetingsDataSourceId: canonicalMeetingsDataSourceId
      });
      expect(configuredSource.providerId).toBeUndefined();
      expect(configuredSource.token).not.toBe(observationEnv()["NOTION_API_TOKEN"]);
      const configuredCatalog = requirePresent<LinearReadOnlyWorkCatalogConfig>(
        readOnlyCatalogConfig,
        "read-only catalog factory was not called"
      );
      expect(configuredCatalog).toMatchObject({
        teamId: "team-dayova",
        readOnlyApiKey: "dedicated-linear-read-key"
      });
      expect("apiKey" in configuredCatalog).toBe(false);
      expect("api" in configuredCatalog).toBe(false);
      await eventually(
        () => source.scans.length === 1,
        "host startup did not begin canonical reconciliation"
      );
      expect(source.scans).toEqual([{ workspaceId: lumaWorkspaceId }]);

      const configuredHttp = requirePresent<CreateNotionWebhookHttpServerInput>(
        httpInput,
        "HTTP server factory was not called"
      );
      expect(configuredHttp.observationHost.receive(signedDelivery())).toEqual({
        status: "accepted"
      });
      await eventually(
        () => source.refreshes.length === 1,
        "signed signal did not use the source refresh seam"
      );
      expect(source.refreshes).toEqual([
        { workspaceId: lumaWorkspaceId, pageId: meetingPageId }
      ]);
      expect(JSON.stringify(running.status())).not.toContain(
        "dedicated-notion-read-token"
      );
      expect(JSON.stringify(running.status())).not.toContain(verificationToken);
      const createdDatabase = requirePresent<LumaDatabase>(
        database,
        "database factory was not called"
      );
      await expect(
        createdDatabase.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM follow_up_executions"
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await running?.stop();
    }
  });
});
