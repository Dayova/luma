import { describe, expect, it, vi } from "vitest";
import { LumaStartupCancelledError, startServer } from "../../src/app/server.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { LumaDatabase } from "../../src/persistence/db.js";

type StartServerDependencies = NonNullable<Parameters<typeof startServer>[1]>;

describe("Discord server startup resource ownership", () => {
  it("does not acquire resources when already cancelled", async () => {
    const harness = createLifecycleHarness();
    const createDatabase = vi.fn(harness.dependencies.createDatabase);
    const controller = new AbortController();
    controller.abort();

    await expect(
      startServer(
        serverEnv,
        { ...harness.dependencies, createDatabase },
        controller.signal
      )
    ).rejects.toBeInstanceOf(LumaStartupCancelledError);

    expect(createDatabase).not.toHaveBeenCalled();
    expect(harness.createTransport).not.toHaveBeenCalled();
  });

  it("waits for an in-flight database handle before closing cancelled startup", async () => {
    const harness = createLifecycleHarness();
    const acquisition = deferred<LumaDatabase>();
    const controller = new AbortController();
    const startup = startServer(
      serverEnv,
      { ...harness.dependencies, createDatabase: () => acquisition.promise },
      controller.signal
    );
    const result = expect(startup).rejects.toBeInstanceOf(LumaStartupCancelledError);
    controller.abort();
    expect(harness.databaseClose).not.toHaveBeenCalled();

    acquisition.resolve(harness.database);
    await result;

    expect(harness.databaseClose).toHaveBeenCalledOnce();
    expect(harness.createTransport).not.toHaveBeenCalled();
  });

  it("cancels a stalled connection and waits for owned resources to close", async () => {
    const harness = createLifecycleHarness();
    const closing = deferred<void>();
    const controller = new AbortController();
    harness.connect.mockImplementation(cancellableConnect);
    harness.databaseClose.mockReturnValue(closing.promise);
    let settled = false;
    const startup = startServer(serverEnv, harness.dependencies, controller.signal);
    const result = expect(startup).rejects.toBeInstanceOf(LumaStartupCancelledError);
    void startup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.waitFor(() => expect(harness.connect).toHaveBeenCalledOnce());

    controller.abort();
    await vi.waitFor(() => expect(harness.databaseClose).toHaveBeenCalledOnce());
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    closing.resolve();
    await result;
    expect(settled).toBe(true);
  });

  it("does not report clean cancellation when a resource could not close", async () => {
    const harness = createLifecycleHarness();
    const controller = new AbortController();
    harness.connect.mockImplementation(cancellableConnect);
    harness.disconnect.mockRejectedValue(new Error("transport cleanup failed"));
    const startup = startServer(serverEnv, harness.dependencies, controller.signal);
    const result = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(harness.connect).toHaveBeenCalledOnce());

    controller.abort();
    await result;
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).not.toHaveBeenCalled();
  });

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

  it("preserves the store when admission cannot drain without replacing the startup failure", async () => {
    const harness = createLifecycleHarness();
    const startupFailure = new Error("Discord connection failed");
    harness.connect.mockRejectedValueOnce(startupFailure);
    harness.disconnect.mockRejectedValueOnce(new Error("transport cleanup failed"));

    await expect(startServer(serverEnv, harness.dependencies)).rejects.toBe(
      startupFailure
    );

    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.databaseClose).not.toHaveBeenCalled();
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
  const connect = vi.fn<DiscordJsTransport["connect"]>(() => Promise.resolve());
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

  return { dependencies, connect, disconnect, database, databaseClose, createTransport };
}

const cancellableConnect: DiscordJsTransport["connect"] = (_handler, _context, signal) =>
  new Promise<void>((_resolve, reject) => {
    if (!signal) throw new Error("startup signal was not forwarded");
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("cancelled", "AbortError")),
      { once: true }
    );
  });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const serverEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "discord-test-token",
  DISCORD_CLIENT_ID: "discord-test-client",
  DISCORD_GUILD_ID: "guild_test"
};
