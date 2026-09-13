import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGranolaOAuthCallbackHost } from "../../src/app/granola-oauth-callback-host.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { GranolaOwnerActor } from "../../src/granola/oauth-connections.js";

const actor = { providerId: "discord", providerUserId: "jakob" };
const redirectUri = "https://luma.example/granola/callback";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    beforeBegin?: () => Promise<void>;
    beforeComplete?: () => Promise<void>;
    failComplete?: boolean;
    start?: boolean;
  } = {}
) {
  const database = await createPgliteDatabase();
  const state = randomBytes(32).toString("base64url");
  const completed: { actor: GranolaOwnerActor; callbackUrl: string }[] = [];
  let changes = 0;
  const host = await createGranolaOAuthCallbackHost({
    database,
    workspaceId: "dayova",
    redirectUri,
    port: 0,
    connections: {
      async begin() {
        await options.beforeBegin?.();
        const authorization = new URL("https://mcp-auth.granola.ai/oauth2/authorize");
        authorization.searchParams.set("state", state);
        authorization.searchParams.set("redirect_uri", redirectUri);
        return {
          connectionId: "connection",
          authorizationUrl: authorization.href,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      },
      async complete(input) {
        completed.push(input);
        await options.beforeComplete?.();
        if (options.failComplete) throw new Error("sensitive-provider-token");
        return {
          connectionId: "connection",
          status: "awaiting-owner-attestation" as const
        };
      }
    },
    afterConnectionsChanged() {
      changes++;
      return Promise.resolve();
    }
  });
  const address = options.start === false ? null : await host.start();
  return {
    database,
    host,
    state,
    completed,
    changes: () => changes,
    callback: `http://127.0.0.1:${address?.port ?? 0}/granola/callback?state=${state}&code=private-code`,
    async close() {
      await host.stop();
      await database.close();
    }
  };
}

describe("founder-bound Granola browser callback host", () => {
  it("binds the browser to the authenticated initiator, ignores Host, stores no raw state/code and never exchanges a replay", async () => {
    const f = await fixture();
    try {
      const initiated = { ...actor };
      await f.host.begin({ actor: initiated });
      initiated.providerUserId = "different-founder";
      const response = await fetch(f.callback, { headers: { Host: "attacker.example" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("No meetings are shared until you confirm");
      expect(f.completed).toEqual([
        { actor, callbackUrl: `${redirectUri}?state=${f.state}&code=private-code` }
      ]);
      expect(f.changes()).toBe(2);
      const rows = await f.database.query(
        "SELECT * FROM granola_oauth_callback_bindings"
      );
      expect(JSON.stringify(rows.rows)).not.toContain(f.state);
      expect(JSON.stringify(rows.rows)).not.toContain("private-code");
      const replay = await fetch(f.callback);
      expect(replay.status).toBe(400);
      expect(f.completed).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("rejects unknown, altered, expired and corrupt bindings before token exchange", async () => {
    const f = await fixture();
    try {
      expect((await fetch(f.callback)).status).toBe(400);
      await f.host.begin({ actor });
      expect((await fetch(`${f.callback}&state=${f.state}`)).status).toBe(400);
      expect(
        (await fetch(f.callback.replace("/granola/callback", "/elsewhere"))).status
      ).toBe(404);
      expect(
        (await fetch(f.callback, { method: "POST", body: "private-code" })).status
      ).toBe(405);
      await f.database.query("UPDATE granola_oauth_callback_bindings SET actor_json=$1", [
        JSON.stringify({ ...actor, providerUserId: "different-founder" })
      ]);
      expect((await fetch(f.callback)).status).toBe(400);
      await f.database.query(
        "UPDATE granola_oauth_callback_bindings SET actor_json=$1,expires_at=$2",
        [JSON.stringify(actor), "2000-01-01T00:00:00.000Z"]
      );
      expect((await fetch(f.callback)).status).toBe(400);
      expect(f.completed).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("claims concurrent callbacks once and drains the admitted exchange during shutdown", async () => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture({
      beforeComplete: async () => {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      await f.host.begin({ actor });
      const first = fetch(f.callback);
      await entered.promise;
      expect((await fetch(f.callback)).status).toBe(400);
      let stopped = false;
      const stop = f.host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(f.host.begin({ actor })).rejects.toThrow("unavailable");
      release.resolve();
      expect((await first).status).toBe(200);
      await stop;
      expect(f.host.status().listening).toBe(false);
      expect(f.completed).toHaveLength(1);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("sanitizes provider errors and does not resend a failed exchange", async () => {
    const f = await fixture({ failComplete: true });
    try {
      await f.host.begin({ actor });
      const response = await fetch(f.callback);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/private-code|sensitive-provider-token/);
      expect((await fetch(f.callback)).status).toBe(400);
      expect(f.completed).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("drains an admitted reconnect and its registry refresh before closing", async () => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture({
      beforeBegin: async () => {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      const begin = f.host.begin({ actor });
      await entered.promise;
      let stopped = false;
      const stop = f.host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await begin;
      await stop;
      expect(f.changes()).toBe(1);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("closes a listener when shutdown races startup and refuses a second start", async () => {
    const f = await fixture({ start: false });
    try {
      await expect(f.host.begin({ actor })).rejects.toThrow("unavailable");
      const starting = f.host.start();
      const rejection = expect(starting).rejects.toThrow("stopped during startup");
      const stopping = f.host.stop();
      await rejection;
      await stopping;
      expect(f.host.status().listening).toBe(false);
      await expect(f.host.start()).rejects.toThrow("cannot start");
    } finally {
      await f.close();
    }
  });
});
