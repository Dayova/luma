import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { LumaDatabase } from "../../src/persistence/db.js";

type StartServerDependencies = NonNullable<Parameters<typeof startServer>[1]>;

describe("Discord server startup resource ownership", () => {
  it("closes persistence when provider configuration fails before transport creation", async () => {
    const harness = createLifecycleHarness();

    await expect(
      startServer({ ...serverEnv, LINEAR_TEAM_ID: "team_test" }, harness.dependencies)
    ).rejects.toThrow("LINEAR_API_KEY is required");

    expect(harness.databaseClose).toHaveBeenCalledOnce();
    expect(harness.createTransport).not.toHaveBeenCalled();
  });

  it("closes persistence when the transport factory throws", async () => {
    const harness = createLifecycleHarness();
    const startupFailure = new Error("transport configuration failed");
    harness.createTransport.mockImplementationOnce(() => {
      throw startupFailure;
    });

    await expect(startServer(serverEnv, harness.dependencies)).rejects.toBe(
      startupFailure
    );

    expect(harness.databaseClose).toHaveBeenCalledOnce();
    expect(harness.disconnect).not.toHaveBeenCalled();
  });

  it("releases a constructed transport if later capability composition fails", async () => {
    const harness = createLifecycleHarness();
    const startupFailure = new Error("reasoning adapter configuration failed");

    await expect(
      startServer(
        { ...serverEnv, OPENAI_API_KEY: "openai-test-key" },
        {
          ...harness.dependencies,
          createOpenAIReasoningModel: () => {
            throw startupFailure;
          }
        }
      )
    ).rejects.toBe(startupFailure);

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).toHaveBeenCalledOnce();
  });

  it("disconnects and closes persistence after a failed connection", async () => {
    const harness = createLifecycleHarness();
    const startupFailure = new Error("Discord connection failed");
    harness.connect.mockRejectedValueOnce(startupFailure);

    await expect(startServer(serverEnv, harness.dependencies)).rejects.toBe(
      startupFailure
    );

    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).toHaveBeenCalledOnce();
  });

  it("attempts every resource cleanup without replacing the startup failure", async () => {
    const harness = createLifecycleHarness();
    const startupFailure = new Error("Discord connection failed");
    harness.connect.mockRejectedValueOnce(startupFailure);
    harness.disconnect.mockRejectedValueOnce(new Error("transport cleanup failed"));
    harness.databaseClose.mockRejectedValueOnce(new Error("database cleanup failed"));

    await expect(startServer(serverEnv, harness.dependencies)).rejects.toBe(
      startupFailure
    );

    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).toHaveBeenCalledOnce();
  });

  it("keeps successful resources open until the caller stops the app", async () => {
    const harness = createLifecycleHarness();
    const app = await startServer(serverEnv, harness.dependencies);

    expect(harness.connect).toHaveBeenCalledOnce();
    expect(harness.disconnect).not.toHaveBeenCalled();
    expect(harness.databaseClose).not.toHaveBeenCalled();

    await app.stop();

    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).toHaveBeenCalledOnce();
  });
});

function createLifecycleHarness() {
  const connect = vi.fn(() => Promise.resolve());
  const disconnect = vi.fn(() => Promise.resolve());
  const databaseClose = vi.fn(() => Promise.resolve());
  const database = { close: databaseClose } as unknown as LumaDatabase;
  const transport: DiscordJsTransport = {
    connect,
    disconnect,
    resolveChannel: () => Promise.resolve(null),
    createThread: () => Promise.reject(new Error("unexpected thread creation")),
    sendMessage: () => Promise.reject(new Error("unexpected message send")),
    capture: () => Promise.reject(new Error("unexpected evidence capture"))
  };
  const createTransport = vi.fn(() => transport);
  const dependencies: StartServerDependencies = {
    createDatabase: () => Promise.resolve(database),
    createDiscordTransport: createTransport
  };

  return { dependencies, connect, disconnect, databaseClose, createTransport };
}

const serverEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "discord-test-token",
  DISCORD_CLIENT_ID: "discord-test-client",
  DISCORD_GUILD_ID: "guild_test"
};
