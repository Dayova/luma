import type * as Discord from "discord.js";
import { Events } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

type MakeRequest = typeof Discord.DefaultRestOptions.makeRequest;

const sdk = vi.hoisted(() => ({
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  register: vi.fn<() => Promise<void>>(),
  login: vi.fn<(request: MakeRequest) => Promise<void>>(),
  destroy: vi.fn<() => Promise<void>>(),
  request: vi.fn<MakeRequest>()
}));

vi.mock("discord.js", async (importOriginal) => {
  const original = await importOriginal<typeof Discord>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    DefaultRestOptions: { ...original.DefaultRestOptions, makeRequest: sdk.request },
    Client: class extends EventEmitter {
      private readonly request: MakeRequest;
      constructor(options: Discord.ClientOptions) {
        super();
        if (!options.rest?.makeRequest) throw new Error("missing owned REST transport");
        this.request = options.rest.makeRequest;
        sdk.emit = this.emit.bind(this);
      }
      login(): Promise<void> {
        return sdk.login(this.request);
      }
      destroy(): Promise<void> {
        return sdk.destroy();
      }
    },
    REST: class {
      setToken() {
        return this;
      }
      put(): Promise<void> {
        return sdk.register();
      }
    }
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  sdk.register.mockResolvedValue();
  sdk.login.mockImplementation(() => {
    queueMicrotask(() => sdk.emit(Events.ClientReady));
    return Promise.resolve();
  });
  sdk.destroy.mockResolvedValue();
  sdk.request.mockImplementation(() => Promise.reject(new Error("unexpected request")));
});

describe("Discord transport startup cancellation", () => {
  it("stops a stalled registration and fences its late completion from login", async () => {
    const registration = deferred<void>();
    // Model a REST rate-limit wait which does not immediately reject on abort.
    sdk.register.mockReturnValue(registration.promise);
    const controller = new AbortController();
    const live = transport();
    const connecting = live.connect(command, undefined, controller.signal);
    const result = expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.register).toHaveBeenCalledOnce());

    controller.abort();
    await result;
    await live.disconnect();
    expect(sdk.destroy).toHaveBeenCalledOnce();
    expect(sdk.login).not.toHaveBeenCalled();

    registration.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sdk.login).not.toHaveBeenCalled();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });

  it("aborts client-owned gateway discovery before a late gateway can be started", async () => {
    let gatewaySignal: AbortSignal | null | undefined;
    const gatewayStarted = vi.fn();
    sdk.request.mockImplementation((_url, options) => {
      gatewaySignal = options.signal;
      return new Promise((_resolve, reject) => {
        if (!options.signal) throw new Error("gateway request has no abort signal");
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          {
            once: true
          }
        );
      });
    });
    sdk.login.mockImplementation(async (request) => {
      await request("https://discord.invalid/gateway/bot", {});
      gatewayStarted();
    });
    const controller = new AbortController();
    const live = transport();
    const connecting = live.connect(command, undefined, controller.signal);
    const result = expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.request).toHaveBeenCalledOnce());

    controller.abort();
    await result;
    await live.disconnect();
    expect(gatewaySignal?.aborted).toBe(true);
    expect(gatewayStarted).not.toHaveBeenCalled();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });

  it("stops waiting for ready and rejects late event admission after repeated stop", async () => {
    sdk.login.mockResolvedValue();
    const controller = new AbortController();
    const live = transport();
    const handler = vi.fn(command);
    const connecting = live.connect(handler, undefined, controller.signal);
    const result = expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.login).toHaveBeenCalledOnce());

    controller.abort();
    await Promise.all([result, live.disconnect(), live.disconnect()]);
    sdk.emit(Events.ClientReady);
    const interaction = {
      isChatInputCommand: vi.fn(() => true),
      commandName: "meeting",
      reply: vi.fn()
    };
    sdk.emit(Events.InteractionCreate, interaction);
    expect(interaction.isChatInputCommand).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });

  it("preserves a failed disconnect instead of reporting clean cancellation", async () => {
    sdk.login.mockResolvedValue();
    const closeFailure = new Error("client close failed");
    sdk.destroy.mockRejectedValue(closeFailure);
    const controller = new AbortController();
    const live = transport();
    const connecting = live.connect(command, undefined, controller.signal);
    const result = expect(connecting).rejects.toBe(closeFailure);
    await vi.waitFor(() => expect(sdk.login).toHaveBeenCalledOnce());

    controller.abort();
    await result;
    await expect(live.disconnect()).rejects.toBe(closeFailure);
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
});

function transport() {
  return createDiscordJsTransport({
    token: "test-only",
    clientId: "application",
    guildId: "guild",
    allowedParentChannelIds: ["parent"]
  });
}

function command() {
  return Promise.resolve({ content: "unused" });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
