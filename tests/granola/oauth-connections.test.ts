import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createGranolaOAuthConnections,
  type GranolaOwnerActor
} from "../../src/granola/oauth-connections.js";
import { granolaOAuthConnectionsFromEnv } from "../../src/app/granola-oauth-runtime.js";
import { createGranolaCaptureIngestionRuntime } from "../../src/granola/capture-ingestion-runtime.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  vi.useRealTimers();
  await database.close();
});
const actor = { providerId: "discord", providerUserId: "jakob" },
  another = { providerId: "discord", providerUserId: "fabius" };
const redirectUri = "https://luma.dayova.test/granola/callback",
  workspaceId = "dayova";
const tools = [
  { name: "get_account_info", inputSchema: { type: "object", properties: {} } },
  {
    name: "list_meetings",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } }
  },
  {
    name: "get_meetings",
    inputSchema: {
      type: "object",
      properties: { meeting_ids: { type: "array", items: { type: "string" } } }
    }
  }
];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
async function fixture() {
  const key = randomBytes(32),
    requests: Array<{ url: string; body: string; authorization: string | null }> = [];
  let time = Date.now(),
    account = "Jakob, workspace Dayova",
    ownerAllowed = true,
    exchangeCount = 0,
    refreshCount = 0;
  let exchangeHook: (() => Promise<void>) | undefined;
  let refreshHook: (() => Promise<void>) | undefined,
    failRefresh = false,
    failExchange = false,
    metadataForgery = false;
  const fetcher: typeof fetch = async (url, init) => {
    const address =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      body = typeof init?.body === "string" ? init.body : "";
    requests.push({
      url: address,
      body,
      authorization: new Headers(init?.headers).get("authorization")
    });
    expect(init?.redirect).toBe("error");
    if (address.endsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: "https://mcp.granola.ai/mcp",
        authorization_servers: ["https://mcp-auth.granola.ai"],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"]
      });
    if (address.endsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: "https://mcp-auth.granola.ai",
        authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
        token_endpoint: metadataForgery
          ? "https://attacker.test/token"
          : "https://mcp-auth.granola.ai/oauth2/token",
        registration_endpoint: "https://mcp-auth.granola.ai/oauth2/register",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["offline_access"]
      });
    if (address.endsWith("/oauth2/register"))
      return json({
        client_id: "client-public",
        token_endpoint_auth_method: "none",
        redirect_uris: [redirectUri]
      });
    if (address.endsWith("/oauth2/token")) {
      const params = new URLSearchParams(body);
      expect(params.get("resource")).toBe("https://mcp.granola.ai/mcp");
      if (params.get("grant_type") === "authorization_code") {
        exchangeCount++;
        await exchangeHook?.();
        if (failExchange) throw new Error("PRIVATE LOST RESPONSE");
        return json({
          access_token: `access-${exchangeCount}`,
          refresh_token: `refresh-${exchangeCount}`,
          token_type: "Bearer",
          expires_in: 3_600
        });
      }
      refreshCount++;
      await refreshHook?.();
      if (failRefresh) throw new Error("PRIVATE ROTATION LOST");
      return json({
        access_token: `rotated-access-${refreshCount}`,
        refresh_token: `rotated-refresh-${refreshCount}`,
        token_type: "Bearer",
        expires_in: 3_600
      });
    }
    if (address !== "https://mcp.granola.ai/mcp") throw new Error("Unexpected URL");
    const rpc = JSON.parse(body) as {
      id: number;
      method: string;
      params: { name: string; arguments: { meeting_ids: string[] } };
    };
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18" };
    else if (rpc.method === "tools/list") result = { tools };
    else if (rpc.params.name === "get_account_info") result = text(account);
    else if (rpc.params.name === "list_meetings")
      result = text(
        '<meetings_data><meeting id="work" title="Weekly" date="Sep 11, 2026 9:00 AM"><summary>Work</summary></meeting><meeting id="private" title="Personal" date="Sep 11, 2026 9:00 AM"><summary>DO NOT ARCHIVE</summary></meeting></meetings_data>'
      );
    else
      result = text(
        '<meeting id="work" title="Weekly" date="Sep 11, 2026 9:00 AM"><summary>We might start after review</summary></meeting>'
      );
    return json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  const authorizeOwner = (value: GranolaOwnerActor) =>
    Promise.resolve(
      ownerAllowed &&
        value.providerId === "discord" &&
        ["jakob", "fabius"].includes(value.providerUserId)
        ? `person_${value.providerUserId}`
        : null
    );
  const config = {
    database,
    workspaceId,
    encryptionKey: key,
    redirectUri,
    authorizeOwner,
    fetch: fetcher,
    now: () => new Date(time)
  };
  const manager = await createGranolaOAuthConnections(config);
  const connect = async (who = actor) => {
    const begun = await manager.begin({ actor: who }),
      url = new URL(begun.authorizationUrl),
      callback = new URL(redirectUri);
    callback.search = new URLSearchParams({
      code: "authorization-code",
      state: url.searchParams.get("state")!
    }).toString();
    const completed = await manager.complete({ actor: who, callbackUrl: callback.href });
    return { ...begun, ...completed, callback: callback.href };
  };
  const attest = async (who = actor) => {
    const inspected = await manager.inspect({ actor: who });
    await manager.attest({
      actor: who,
      ...inspected,
      choices: {
        audiencePersonIds: [
          who.providerUserId === "jakob" ? "person_jakob" : "person_fabius"
        ],
        includedMeetingIds: ["work"],
        excludedMeetingIds: ["private"]
      }
    });
    return inspected;
  };
  return {
    manager,
    config,
    key,
    requests,
    connect,
    attest,
    counts: () => ({ exchangeCount, refreshCount }),
    advance: () => {
      time += 3_550_000;
    },
    changeAccount: () => {
      account = "Other account, private workspace";
    },
    revokeOwner: () => {
      ownerAllowed = false;
    },
    exchangeHook: (hook: () => Promise<void>) => {
      exchangeHook = hook;
    },
    refreshHook: (hook: () => Promise<void>) => {
      refreshHook = hook;
    },
    failRefresh: () => {
      failRefresh = true;
    },
    failExchange: () => {
      failExchange = true;
    },
    forgeMetadata: () => {
      metadataForgery = true;
    }
  };
}
describe("Granola founder OAuth connections", () => {
  it("performs actual PKCE exchange, requires owner account attestation, encrypts credentials and drives bounded eligible capture ingestion", async () => {
    const f = await fixture(),
      connected = await f.connect();
    const url = new URL(connected.authorizationUrl),
      tokenCall = f.requests.find((request) => request.url.endsWith("/oauth2/token"))!;
    const verifier = new URLSearchParams(tokenCall.body).get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge")
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(await f.manager.connections()).toEqual([]);
    expect(f.requests.filter((request) => request.url.endsWith("/mcp"))).toEqual([]);
    await f.attest();
    const stored = (await database.query("SELECT * FROM granola_oauth_connections")).rows;
    expect(JSON.stringify(stored)).not.toMatch(
      /access-1|refresh-1|Jakob, workspace|authorization-code/u
    );
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      policy: f.manager.policy,
      connections: await f.manager.connections()
    });
    try {
      expect(await runtime.syncOnce()).toMatchObject({
        accepted: 1,
        withheld: 1,
        failures: []
      });
      const captures = (
        await database.query<{ material: string | null }>(
          "SELECT material FROM granola_capture_revisions"
        )
      ).rows;
      expect(JSON.stringify(captures)).toContain("We might start");
      expect(JSON.stringify(captures)).not.toContain("DO NOT ARCHIVE");
    } finally {
      await runtime.stop();
      await f.manager.stop();
    }
  });
  it("rejects another founder, modified state, wrong redirect and callback replay without exchanging again", async () => {
    const f = await fixture(),
      begun = await f.manager.begin({ actor }),
      url = new URL(begun.authorizationUrl);
    const callback = `${redirectUri}?code=code&state=${url.searchParams.get("state")}`;
    await expect(
      f.manager.complete({ actor: another, callbackUrl: callback })
    ).rejects.toThrow("invalid-callback");
    await expect(
      f.manager.complete({ actor, callbackUrl: callback + "x" })
    ).rejects.toThrow("invalid-callback");
    await expect(
      f.manager.complete({
        actor,
        callbackUrl: callback.replace("luma.dayova.test", "attacker.test")
      })
    ).rejects.toThrow("invalid-callback");
    await f.manager.complete({ actor, callbackUrl: callback });
    await expect(f.manager.complete({ actor, callbackUrl: callback })).rejects.toThrow(
      "invalid-callback"
    );
    expect(f.counts().exchangeCount).toBe(1);
    await f.manager.stop();
  });
  it("consumes a denied consent callback without exchanging credentials", async () => {
    const f = await fixture(),
      begun = await f.manager.begin({ actor }),
      url = new URL(begun.authorizationUrl);
    const callback = `${redirectUri}?error=access_denied&state=${url.searchParams.get("state")}`;
    await expect(f.manager.complete({ actor, callbackUrl: callback })).rejects.toThrow(
      "authorization-declined"
    );
    await expect(
      f.manager.complete({
        actor,
        callbackUrl: callback.replace("error=access_denied", "code=fake")
      })
    ).rejects.toThrow("invalid-callback");
    expect(f.counts().exchangeCount).toBe(0);
    expect((await f.manager.status())[0]?.status).toBe("reconnect-required");
    await f.manager.stop();
  });
  it("refuses changed account attestation and unauthorized owners", async () => {
    const f = await fixture();
    await f.connect();
    const inspected = await f.manager.inspect({ actor });
    f.changeAccount();
    await expect(
      f.manager.attest({
        actor,
        ...inspected,
        choices: {
          audiencePersonIds: ["person_jakob"],
          includedMeetingIds: [],
          excludedMeetingIds: []
        }
      })
    ).rejects.toThrow("attestation-required");
    expect(await f.manager.connections()).toEqual([]);
    f.revokeOwner();
    await expect(f.manager.begin({ actor })).rejects.toThrow("owner-required");
    await f.manager.stop();
  });
  it("rotates refresh tokens once for simultaneous runtime clients and retains the rotated credential across recreation", async () => {
    const f = await fixture();
    await f.connect();
    await f.attest();
    f.advance();
    const first = (await f.manager.connections())[0]!,
      second = (await f.manager.connections())[0]!;
    await Promise.all([first.client.tools(), second.client.tools()]);
    expect(f.counts().refreshCount).toBe(1);
    const refreshed = f.requests
      .filter((request) => request.url.endsWith("/mcp"))
      .slice(-6);
    expect(
      refreshed.some((request) => request.authorization === "Bearer rotated-access-1")
    ).toBe(true);
    await f.manager.stop();
    const recreated = await createGranolaOAuthConnections(f.config);
    await (await recreated.connections())[0]!.client.tools();
    expect(f.counts().refreshCount).toBe(1);
    await recreated.stop();
  });
  it("preserves per-founder credentials and revokes the old grant when a founder reconnects", async () => {
    const f = await fixture(),
      old = await f.connect();
    await f.attest();
    await f.connect(another);
    await f.attest(another);
    expect(await f.manager.connections()).toHaveLength(2);
    const oldClient = (await f.manager.connections()).find(
      (connection) => connection.connectionId === old.connectionId
    )!;
    const next = await f.connect();
    expect(next.connectionId).not.toBe(old.connectionId);
    await expect(f.manager.policy.read(old.connectionId)).rejects.toThrow(
      "policy-withheld"
    );
    await expect(oldClient.client.tools()).rejects.toThrow();
    expect(await f.manager.connections()).toHaveLength(1);
    await f.manager.stop();
  });
  it.each(["exchange", "refresh"])(
    "never resends an uncertain %s token operation",
    async (operation) => {
      const f = await fixture();
      if (operation === "exchange") {
        f.failExchange();
        await expect(f.connect()).rejects.toThrow("reauthentication-required");
        expect(f.counts().exchangeCount).toBe(1);
      } else {
        await f.connect();
        await f.attest();
        f.advance();
        f.failRefresh();
        await expect(
          (await f.manager.connections())[0]!.client.tools()
        ).rejects.toThrow();
      }
      const before = f.counts();
      const recreated = await createGranolaOAuthConnections(f.config);
      for (const connection of await recreated.connections())
        await expect(connection.client.tools()).rejects.toThrow();
      expect(f.counts()).toEqual(before);
      expect((await recreated.status())[0]?.status).toBe("reconnect-required");
      await recreated.stop();
      await f.manager.stop();
    }
  );
  it("drains admitted refresh work on stop and keeps a concurrent Human disconnect authoritative", async () => {
    const f = await fixture();
    await f.connect();
    await f.attest();
    f.advance();
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        started = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.refreshHook(async () => {
      started();
      await gate;
    });
    const pending = (await f.manager.connections())[0]!.client.tools();
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    await f.manager.disconnect({ actor });
    let stopped = false;
    const stop = f.manager.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await rejected;
    await stop;
    await expect(f.manager.begin({ actor })).rejects.toThrow("stopped");
    const recreated = await createGranolaOAuthConnections(f.config);
    expect((await recreated.status())[0]?.status).toBe("disconnected");
    expect(await recreated.connections()).toEqual([]);
    await recreated.stop();
  });
  it("does not overwrite a founder disconnect when an admitted authorization-code exchange returns later", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.exchangeHook(async () => {
      entered();
      await gate;
    });
    const pending = expect(f.connect()).rejects.toThrow("reauthentication-required");
    await started;
    await f.manager.disconnect({ actor });
    release();
    await pending;
    expect((await f.manager.status())[0]?.status).toBe("disconnected");
    expect(await f.manager.connections()).toEqual([]);
    await f.manager.stop();
  });
  it("does not accept an owner or grant identity injected into browser choices", async () => {
    const f = await fixture();
    await f.connect();
    const inspected = await f.manager.inspect({ actor });
    const choices = {
      audiencePersonIds: ["person_jakob" as const],
      includedMeetingIds: [],
      excludedMeetingIds: [],
      ownerPersonId: "person_fabius",
      optInId: "borrowed-grant"
    };
    await expect(f.manager.attest({ actor, ...inspected, choices })).rejects.toThrow(
      "unavailable"
    );
    expect(await f.manager.connections()).toEqual([]);
    await f.manager.stop();
  });
  it("refreshes an existing MCP session before expiry and denies that initialized client after disconnect", async () => {
    const f = await fixture();
    await f.connect();
    await f.attest();
    const client = (await f.manager.connections())[0]!.client;
    await client.tools();
    f.advance();
    await client.tools();
    expect(f.counts().refreshCount).toBe(1);
    await f.manager.disconnect({ actor });
    const count = f.requests.length;
    await expect(client.call("get_account_info", {})).rejects.toThrow(
      "reauthentication-required"
    );
    expect(f.requests).toHaveLength(count);
    await f.manager.stop();
  });
  it("applies owner exclusions to existing sources without replacing the original opt-in grant", async () => {
    const f = await fixture(),
      connection = await f.connect();
    await f.attest();
    const original = await f.manager.policy.read(connection.connectionId);
    await f.manager.configure({
      actor,
      connectionId: connection.connectionId,
      choices: {
        audiencePersonIds: ["person_jakob"],
        includedMeetingIds: ["work"],
        excludedMeetingIds: ["work", "private"]
      }
    });
    const changed = await f.manager.policy.read(connection.connectionId);
    expect(changed.optInId).toBe(original.optInId);
    expect(changed.excludedMeetingIds).toContain("work");
    const runtime = await createGranolaCaptureIngestionRuntime({
      database,
      workspaceId,
      policy: f.manager.policy,
      connections: await f.manager.connections()
    });
    expect(await runtime.syncOnce()).toMatchObject({
      accepted: 0,
      withheld: 2,
      failures: []
    });
    await runtime.stop();
    await f.manager.stop();
  });
  it("bounds a stalled refresh body and cleanup, draining stop with an honest reconnect state", async () => {
    const f = await fixture();
    await f.connect();
    await f.attest();
    await f.manager.stop();
    f.advance();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const manager = await createGranolaOAuthConnections({
      ...f.config,
      timeoutMs: 20,
      fetch: async (url, init) => {
        if (
          !(
            typeof url === "string" ? url : url instanceof URL ? url.href : url.url
          ).endsWith("/oauth2/token")
        )
          return f.config.fetch(url, init);
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true }
        );
        entered();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
            cancel: () => new Promise(() => undefined)
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
    });
    const client = (await manager.connections())[0]!.client;
    vi.useFakeTimers();
    const pending = expect(client.tools()).rejects.toThrow("reauthentication-required");
    await started;
    let stopped = false;
    const drain = manager.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    await drain;
    expect(aborted).toBe(true);
    vi.useRealTimers();
    const recreated = await createGranolaOAuthConnections(f.config);
    expect((await recreated.status())[0]?.lastFailure).toBe("refresh-unproven");
    await recreated.stop();
  });
  it("pins metadata origins before registration and rejects ciphertext transplanted between founders", async () => {
    const f = await fixture();
    f.forgeMetadata();
    await expect(f.manager.begin({ actor })).rejects.toThrow("unavailable");
    expect(f.requests.some((request) => request.url.endsWith("/oauth2/register"))).toBe(
      false
    );
    await database.query(
      "UPDATE granola_oauth_connections SET owner_person_id='person_fabius'"
    );
    await expect(createGranolaOAuthConnections(f.config)).rejects.toThrow(
      "store-unavailable"
    );
    await f.manager.stop();
  });
  it("requires a protected separate key and never starts network activity during startup", async () => {
    const f = await fixture(),
      directory = await mkdtemp(join(tmpdir(), "luma-granola-key-")),
      path = join(directory, "key");
    try {
      await writeFile(path, f.key, { mode: 0o600 });
      const input = {
        database,
        workspaceId,
        authorizeOwner: f.config.authorizeOwner,
        fetch: f.config.fetch,
        env: {
          LUMA_GRANOLA_OAUTH_ENABLED: "1",
          LUMA_GRANOLA_CREDENTIAL_KEY_PATH: path,
          LUMA_GRANOLA_OAUTH_REDIRECT_URI: redirectUri
        }
      };
      const configured = await granolaOAuthConnectionsFromEnv(input);
      expect(configured).not.toBeNull();
      expect(f.requests).toEqual([]);
      await configured!.stop();
      await chmod(path, 0o644);
      await expect(granolaOAuthConnectionsFromEnv(input)).rejects.toThrow(
        "store-unavailable"
      );
      await chmod(path, 0o600);
      await symlink(path, join(directory, "link"));
      await expect(
        granolaOAuthConnectionsFromEnv({
          ...input,
          env: { ...input.env, LUMA_GRANOLA_CREDENTIAL_KEY_PATH: join(directory, "link") }
        })
      ).rejects.toThrow("store-unavailable");
      await f.connect();
      await expect(
        createGranolaOAuthConnections({ ...f.config, encryptionKey: randomBytes(32) })
      ).rejects.toThrow("store-unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await f.manager.stop();
    }
  });
});
