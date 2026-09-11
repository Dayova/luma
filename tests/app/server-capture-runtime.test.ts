import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createGranolaOAuthCallbackHost } from "../../src/app/granola-oauth-callback-host.js";
import { granolaOAuthRuntimeConfig } from "../../src/app/granola-oauth-runtime.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

const parent = "100000000000000001";
function environment(): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "test-only",
    DISCORD_CLIENT_ID: "test-client",
    DISCORD_GUILD_ID: "guild",
    LUMA_WORKSPACE_ID: "workspace_dayova",
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
    OPENAI_API_KEY: "test-only",
    LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED: "1",
    LUMA_GRANOLA_OAUTH_ENABLED: "1",
    LUMA_GRANOLA_CREDENTIAL_KEY_PATH: "/protected/key",
    LUMA_GRANOLA_OAUTH_REDIRECT_URI: "https://luma.example/granola/callback",
    LUMA_SYNTHESIS_NOTION_API_TOKEN: "test-only-writer",
    LUMA_SYNTHESIS_IMPORTED_MEETINGS_DATA_SOURCE_ID:
      "11111111-1111-4111-8111-111111111111",
    LUMA_SYNTHESIS_CREDENTIAL_SCOPE_ID: "synthesis-writer",
    LUMA_SYNTHESIS_SIGNING_KEY: "test-only-stable-signing-key-over-32-bytes",
    LUMA_CONTEXT_SHARING_POLICY_PATH: "/protected/sharing.json"
  };
}
describe("shared capture production composition", () => {
  it("starts founder onboarding and capture review on one store without consent, source reads or paid calls, then closes its listener and store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-capture-app-"));
    const database = await createPgliteDatabase();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider call"));
    let app: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const key = join(directory, "granola.key"),
        sharing = join(directory, "sharing.json");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      await writeFile(
        sharing,
        JSON.stringify({ version: 1, workspaceId: "workspace_dayova", grants: [] }),
        { mode: 0o600 }
      );
      let callback:
        Awaited<ReturnType<typeof createGranolaOAuthCallbackHost>> | undefined;
      let command: Parameters<DiscordJsTransport["connect"]>[0] | undefined;
      const transport: DiscordJsTransport = {
        connect: (handler) => {
          expect(callback?.status().listening).toBe(true);
          command = handler;
          return Promise.resolve();
        },
        disconnect: () => Promise.resolve(),
        resolveChannel: ({ channelId }) =>
          Promise.resolve({
            id: channelId,
            guildId: "guild",
            kind: "text-channel",
            parentChannelId: null,
            botCanRead: true,
            botCanReply: true
          }),
        createThread: () => Promise.reject(new Error("No synthetic Meeting")),
        sendMessage: () => Promise.reject(new Error("No unsolicited message")),
        capture: () => Promise.reject(new Error("No conversation capture"))
      };
      app = await startServer(
        {
          ...environment(),
          LUMA_GRANOLA_CREDENTIAL_KEY_PATH: key,
          LUMA_CONTEXT_SHARING_POLICY_PATH: sharing
        },
        {
          createDatabase: () => Promise.resolve(database),
          createDiscordTransport: () => transport,
          createGranolaCallbackHost: async (input) => {
            callback = await createGranolaOAuthCallbackHost({ ...input, port: 0 });
            return callback;
          }
        }
      );
      if (!command) throw new Error("No command handler");
      const result = await command({
        type: "captures",
        page: 1,
        guildId: "guild",
        channelId: parent,
        interactionId: "captures",
        actorDiscordUserId: "779381502311137301",
        occurredAt: "2026-09-11T10:00:00.000Z"
      });
      expect(result.content).toContain("No currently shared captures");
      expect((await database.query("SELECT * FROM meetings")).rows).toEqual([]);
      expect((await database.query("SELECT * FROM ai_usage_requests")).rows).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await app.stop();
      expect(callback?.status().listening).toBe(false);
      expect(database.closed).toBe(true);
    } finally {
      if (app) await app.stop();
      else await database.close();
      fetchSpy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { LUMA_GRANOLA_OAUTH_ENABLED: "true" },
    { LUMA_GRANOLA_OAUTH_ENABLED: " 1" },
    { LUMA_GRANOLA_CREDENTIAL_KEY_PATH: "relative.key" },
    { LUMA_GRANOLA_OAUTH_REDIRECT_URI: "http://luma.example/callback" },
    { LUMA_GRANOLA_OAUTH_REDIRECT_URI: "https://luma.example/callback?state=unexpected" },
    { LUMA_GRANOLA_OAUTH_REDIRECT_URI: "https://user:secret@luma.example/callback" },
    { LUMA_GRANOLA_OAUTH_HTTP_HOST: "0.0.0.0" },
    { LUMA_GRANOLA_OAUTH_HTTP_PORT: "0" },
    { LUMA_GRANOLA_OAUTH_HTTP_PORT: "70000" },
    { LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED: "0" }
  ])(
    "rejects incompatible onboarding configuration before opening the database: %j",
    async (change) => {
      const createDatabase = vi.fn(() =>
        Promise.reject(new Error("Resource allocation reached"))
      );
      await expect(
        startServer({ ...environment(), ...change }, { createDatabase })
      ).rejects.toThrow();
      expect(createDatabase).not.toHaveBeenCalled();
    }
  );

  it("allows only loopback HTTP for local callback development", () => {
    expect(
      granolaOAuthRuntimeConfig({
        ...environment(),
        LUMA_GRANOLA_OAUTH_REDIRECT_URI: "http://127.0.0.1:3002/callback"
      })?.hostname
    ).toBe("127.0.0.1");
    expect(granolaOAuthRuntimeConfig({})).toBeNull();
  });
});
