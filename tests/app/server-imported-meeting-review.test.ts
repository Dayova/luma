import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { defaultAppConfig } from "../../src/app/config.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import * as importedRuntime from "../../src/app/imported-source-analysis-runtime.js";
import * as notionSourceRuntime from "../../src/knowledge/notion-meeting-notes-source.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

const workspace = {
  workspaceId: "workspace_runtime_review",
  timezone: defaultAppConfig.defaultWorkspaceTimezone,
  outputLanguagePolicy: defaultAppConfig.outputLanguagePolicy,
  publishingPolicy: defaultAppConfig.publishingPolicy
};
const pageId = "00000000-0000-0000-0000-000000000001";
const time = "2026-09-11T12:00:00.000Z";
const parent = "100000000000000001";
const thread = "100000000000000002";
const actor = "779381502311137301";
const source = {
  // The composition must follow the source adapter's configured identity.
  providerId: "notion-runtime-fixture",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "original-meeting-root",
  parentObjectId: pageId,
  url: `https://notion.so/${pageId}`
};
const raw: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Founder release review",
  lifecycle: "ready",
  calendar: null,
  recording: null,
  sections: {
    summary: {
      state: "available",
      sourceBlockId: "summary",
      text: "Release discussion",
      blocks: []
    },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "notes",
      text: "Jakob could review the release checklist.",
      blocks: [
        {
          id: "checklist",
          type: "to-do",
          text: "Jakob could review the release checklist.",
          checked: false,
          children: []
        }
      ]
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript",
      text: "This remains a proposal.",
      blocks: []
    }
  },
  markdown: {
    content: "# Founder release review",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};

afterEach(() => vi.restoreAllMocks());

async function fixture(options: { source: boolean; access: boolean }) {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  let allowed = true;
  const audiences: string[][] = [];
  const access = createGrantedImportedSourceAnalysisAccess({
    ledger,
    authorize: ({ audience, source: requestedSource }) => {
      audiences.push([...audience.personIds]);
      return Promise.resolve(
        allowed &&
          audience.workspaceId === workspace.workspaceId &&
          requestedSource.providerId === source.providerId
      );
    },
    evidenceSource: () => ({
      capture: () =>
        Promise.resolve({
          status: "captured",
          evidence: {
            source,
            providerVersion: time,
            observedAt: time,
            snapshot: structuredClone(raw)
          }
        })
    })
  });
  const importedSourceAnalysis = {
    access,
    audience: () =>
      Promise.resolve({
        workspaceId: workspace.workspaceId,
        personIds: [...dayovaFounderPersonIds]
      })
  };
  const observation = observedMeetingNoteToObservation(
    {
      workspace,
      source: await ledger.record({
        workspaceId: workspace.workspaceId,
        source,
        providerVersion: time,
        observedAt: time,
        snapshot: raw
      })
    },
    "linear"
  );
  // Seed a retained, already accepted import through the public MI interface.
  await createMeetingIntelligence({
    database,
    importedSourceAnalysis,
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger
    }),
    reasoningModel: {
      generateStructured: <T>() =>
        Promise.resolve({
          value: {
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          } as T,
          metadata: {
            provider: "programmable",
            model: "synthetic",
            promptVersion: "test"
          }
        })
    }
  }).observe({ workspace, observations: [observation] });
  // Only external adapter factories are programmable; production composition,
  // MI projections, the source ledger, grant checks and Discord command flow run.
  vi.spyOn(importedRuntime, "importedSourceAnalysisFromEnv").mockReturnValue(
    options.access ? importedSourceAnalysis : undefined
  );
  vi.spyOn(notionSourceRuntime, "createNotionMeetingNotesSourceFromEnv").mockReturnValue({
    scan: () =>
      Promise.resolve({
        records: [],
        nextCursor: null,
        completeness: "complete",
        partialReasons: []
      }),
    refreshPage: () => Promise.reject(new Error("No source refresh was requested"))
  });
  let handler: Parameters<DiscordJsTransport["connect"]>[0] | undefined;
  const transport: DiscordJsTransport = {
    connect: (command) => {
      handler = command;
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    resolveChannel: ({ channelId }) =>
      Promise.resolve({
        id: channelId,
        guildId: "guild_review",
        kind: channelId === parent ? "text-channel" : "public-thread",
        parentChannelId: channelId === parent ? null : parent
      }),
    createThread: () =>
      Promise.reject(new Error("Binding must reuse the existing thread")),
    sendMessage: () =>
      Promise.reject(new Error("Review must use the interaction response")),
    capture: () => Promise.reject(new Error("No Discord capture was requested"))
  };
  const app = await startServer(
    {
      NODE_ENV: "test",
      DISCORD_TOKEN: "test-only",
      DISCORD_CLIENT_ID: "client_review",
      DISCORD_GUILD_ID: "guild_review",
      LUMA_WORKSPACE_ID: workspace.workspaceId,
      LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
      LUMA_REASONING_MODEL_PROVIDER: "disabled",
      LUMA_NOTION_PROVIDER_ID: ` ${source.providerId} `,
      ...(options.source
        ? {
            NOTION_API_TOKEN: "test-only",
            NOTION_MEETINGS_DATA_SOURCE_ID: "00000000-0000-0000-0000-000000000002"
          }
        : {})
    },
    {
      createDatabase: () => Promise.resolve(database),
      createDiscordTransport: () => transport
    }
  );
  const command = (input: Parameters<NonNullable<typeof handler>>[0]) => {
    if (!handler) throw new Error("Discord command entrypoint was not connected");
    return handler(input);
  };
  const base = {
    guildId: "guild_review",
    channelId: thread,
    actorDiscordUserId: actor,
    occurredAt: time
  };
  return {
    app,
    database,
    audiences,
    meetingId: observation.meetingId,
    revoke: () => {
      allowed = false;
    },
    bind: () =>
      command({ ...base, type: "bind", interactionId: "bind", sourcePage: source.url }),
    review: () => command({ ...base, type: "review", interactionId: "review", page: 1 })
  };
}

describe("production imported Meeting review composition", () => {
  it("binds the original retained Meeting and checks its all-founder source grant at final delivery", async () => {
    const f = await fixture({ source: true, access: true });
    try {
      expect((await f.bind()).content).toContain("Imported Meeting attached");
      const bindings = await f.database.query<{
        meeting_id: string;
        workspace_id: string;
      }>("SELECT meeting_id, workspace_id FROM discord_meeting_threads");
      expect(bindings.rows).toEqual([
        { meeting_id: f.meetingId, workspace_id: workspace.workspaceId }
      ]);
      const result = await f.review();
      expect(result.content).toContain("Jakob could review the release checklist.");
      expect(result.requireCurrent).toBeDefined();
      await result.requireCurrent!();
      expect(f.audiences.length).toBeGreaterThan(0);
      expect(
        f.audiences.every(
          (ids) =>
            JSON.stringify([...ids].sort()) ===
            JSON.stringify([...dayovaFounderPersonIds].sort())
        )
      ).toBe(true);
      f.revoke();
      await expect(result.requireCurrent!()).rejects.toThrow();
      const withheld = await f.review();
      expect(withheld.content).toContain("Imported Meeting unavailable");
      expect(withheld.content).not.toContain("release checklist");
    } finally {
      await f.app.stop();
    }
  });

  it.each([
    { source: false, access: true },
    { source: true, access: false }
  ])(
    "withholds imported binding when canonical source=$source and granted access=$access",
    async (options) => {
      const f = await fixture(options);
      try {
        expect((await f.bind()).content).toContain("current source access");
        const bindings = await f.database.query(
          "SELECT meeting_id FROM discord_meeting_threads"
        );
        expect(bindings.rows).toHaveLength(0);
      } finally {
        await f.app.stop();
      }
    }
  );
});
