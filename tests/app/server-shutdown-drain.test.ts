import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createOpenAIReasoningModel } from "../../src/ai/openai-reasoning-model.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { CLEAN_CLOSE_FILE, pathExists } from "../../src/persistence/store-ownership.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "luma-drain-"));
  const store = join(directory, "store");
  const database = await createPgliteDatabase(store);
  const providerEntered = deferred();
  const providerReply = deferred();
  let handler: Parameters<DiscordJsTransport["connect"]>[0] | undefined;
  const parent = "100000000000000001";
  const thread = "100000000000000002";
  const transport: DiscordJsTransport = {
    connect: (command) => {
      handler = command;
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    resolveChannel: ({ channelId }) =>
      Promise.resolve({
        id: channelId,
        guildId: "guild",
        kind: channelId === parent ? "text-channel" : "public-thread",
        parentChannelId: channelId === parent ? null : parent
      }),
    createThread: () =>
      Promise.resolve({
        id: thread,
        url: `https://discord.com/channels/guild/${thread}`
      }),
    sendMessage: () => Promise.resolve(),
    capture: () => Promise.reject(new Error("No Context Ask capture requested"))
  };
  const app = await startServer(
    {
      DISCORD_TOKEN: "test-only",
      DISCORD_CLIENT_ID: "test-client",
      DISCORD_GUILD_ID: "guild",
      LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
      OPENAI_API_KEY: "test-only"
    },
    {
      createDatabase: () => Promise.resolve(database),
      createDiscordTransport: () => transport,
      createOpenAIReasoningModel: (config) =>
        createOpenAIReasoningModel({
          ...config,
          client: {
            async create(request) {
              providerEntered.resolve();
              await providerReply.promise;
              return {
                outputText: JSON.stringify({
                  actionItems: [],
                  decisions: [],
                  openQuestions: [],
                  risks: [],
                  followUpIntentions: []
                }),
                model: request.model,
                serviceTier: "default",
                status: "completed",
                providerResponseId: "response_shutdown",
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 10,
                  reasoningTokens: 0
                }
              };
            }
          }
        })
    }
  );
  if (!handler) throw new Error("Command entrypoint not connected");
  const command = handler;
  const base = {
    guildId: "guild",
    channelId: parent,
    actorDiscordUserId: "779381502311137301",
    occurredAt: "2026-09-11T09:00:00.000Z"
  };
  await command({
    ...base,
    type: "start",
    interactionId: "start",
    title: "Shutdown proof",
    languageMode: "en"
  });
  const note = command({
    ...base,
    type: "note",
    channelId: thread,
    interactionId: "note",
    text: "We should discuss the release.",
    language: "en"
  });
  await providerEntered.promise;
  return {
    directory,
    store,
    database,
    app,
    note,
    finish: () => providerReply.resolve(),
    lateCommand: () =>
      command({
        ...base,
        type: "note",
        channelId: thread,
        interactionId: "late-note",
        text: "Do not admit this during shutdown.",
        language: "en"
      })
  };
}

describe("owned production shutdown", () => {
  it("stops admission and retains ownership until an admitted paid response is accounted and saved", async () => {
    const f = await fixture();
    try {
      let stopped = false;
      const stopping = f.app.stop().then(() => {
        stopped = true;
      });
      expect((await f.lateCommand()).content).toContain("shutting down");
      expect(stopped).toBe(false);
      expect(f.database.closed).toBe(false);
      expect(await pathExists(join(f.store, CLEAN_CLOSE_FILE))).toBe(false);
      expect(await pathExists(`${f.store}.luma-owner`)).toBe(true);
      await expect(createPgliteDatabase(f.store)).rejects.toThrow("owned");
      f.finish();
      expect((await f.note).content).toContain("Note saved");
      await stopping;
      expect(f.database.closed).toBe(true);
      expect(
        JSON.parse(await readFile(join(f.store, CLEAN_CLOSE_FILE), "utf8"))
      ).toHaveProperty("format", "luma-clean-close-v1");
      const reopened = await createPgliteDatabase(f.store);
      try {
        expect(
          (await reopened.query("SELECT state FROM ai_usage_requests")).rows
        ).toEqual([{ state: "settled" }]);
        const evidence = (
          await reopened.query<{ excerpt: string }>("SELECT excerpt FROM evidence")
        ).rows;
        expect(evidence.map((row) => row.excerpt)).toContain(
          "We should discuss the release."
        );
        expect(evidence.map((row) => row.excerpt)).not.toContain(
          "Do not admit this during shutdown."
        );
      } finally {
        await reopened.close();
      }
    } finally {
      f.finish();
      await f.note;
      if (!f.database.closed) await f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("leaves the held charge and unclean lease intact when the shutdown deadline expires", async () => {
    const f = await fixture();
    try {
      // The provider deadline was registered before fake time starts. Advance
      // only the shutdown clock while the admitted provider is still unresolved.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopping = f.app.stop();
      const rejected = expect(stopping).rejects.toThrow("did not drain");
      await vi.advanceTimersByTimeAsync(90_001);
      await rejected;
      vi.useRealTimers();
      expect(f.database.closed).toBe(false);
      expect(await pathExists(join(f.store, CLEAN_CLOSE_FILE))).toBe(false);
      expect(await pathExists(`${f.store}.luma-owner`)).toBe(true);
      expect(
        (await f.database.query("SELECT state FROM ai_usage_requests")).rows
      ).toEqual([{ state: "reserved" }]);
      await expect(createPgliteDatabase(f.store)).rejects.toThrow("owned");
      // If the caller hasn't terminated yet, a late finish still cannot trigger
      // a detached clean-close continuation from the failed stop operation.
      f.finish();
      await f.note;
      expect(f.database.closed).toBe(false);
      expect(await pathExists(join(f.store, CLEAN_CLOSE_FILE))).toBe(false);
      await expect(f.app.stop()).rejects.toThrow("did not drain");
    } finally {
      vi.useRealTimers();
      f.finish();
      await f.note;
      if (!f.database.closed) await f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
