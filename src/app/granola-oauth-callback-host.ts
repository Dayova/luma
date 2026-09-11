import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  createGranolaOAuthConnections,
  GranolaOwnerActor
} from "../granola/oauth-connections.js";

type Connections = Pick<
  Awaited<ReturnType<typeof createGranolaOAuthConnections>>,
  "begin" | "complete"
>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A browser callback consumes the actor binding made by an authenticated founder command. */
export async function createGranolaOAuthCallbackHost(input: {
  database: LumaDatabase;
  workspaceId: string;
  redirectUri: string;
  connections: Connections;
  afterConnectionsChanged: () => Promise<void>;
  hostname?: string;
  port?: number;
}) {
  const redirect = new URL(input.redirectUri);
  if (
    !input.workspaceId.trim() ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(redirect.hostname)
      ))
  )
    throw new Error("Granola callback configuration is invalid");
  const port = input.port ?? 3002;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("Granola callback port is invalid");
  await input.database.exec(`CREATE TABLE IF NOT EXISTS granola_oauth_callback_bindings (
    workspace_id TEXT NOT NULL,state_hash TEXT NOT NULL,actor_json TEXT NOT NULL,
    connection_id TEXT NOT NULL,expires_at TEXT NOT NULL,binding_hash TEXT NOT NULL,
    phase TEXT NOT NULL,PRIMARY KEY(workspace_id,state_hash)
  )`);
  let listening = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let starting: Promise<{ port: number }> | undefined;
  const active = new Set<Promise<void>>();
  const beginnings = new Set<Promise<unknown>>();
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    if (stopped)
      return reply(
        response,
        503,
        "Luma is restarting. Check the connection status in Discord."
      );
    if (request.method !== "GET") {
      request.resume();
      return reply(
        response,
        405,
        "This address only accepts the Granola login callback."
      );
    }
    const raw = request.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > 14_000)
      return reply(response, 400, "The connection callback is invalid.");
    let callback: URL;
    try {
      callback = new URL(raw, redirect.origin);
    } catch {
      return reply(response, 400, "The connection callback is invalid.");
    }
    if (callback.pathname !== redirect.pathname)
      return reply(response, 404, "Not found.");
    if (active.size >= 4)
      return reply(
        response,
        429,
        "Luma is processing other connections. Check the connection status in Discord."
      );
    const pending = complete(callback)
      .then(
        () =>
          reply(
            response,
            200,
            "Granola login completed. Return to Discord to review the account and choose which meetings Luma may use. No meetings are shared until you confirm."
          ),
        () =>
          reply(
            response,
            400,
            "Luma could not complete this callback. Check the connection status in Discord; reconnect there if needed."
          )
      )
      .finally(() => active.delete(pending));
    active.add(pending);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  server.on("error", () => {
    listening = false;
  });

  async function complete(callback: URL): Promise<void> {
    const state = callback.searchParams.get("state");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      callback.searchParams.getAll("state").length !== 1
    )
      throw new Error("Invalid callback");
    const stateHash = hash(state);
    const binding = await input.database.transaction(async (transaction) => {
      const row = (
        await transaction.query<{
          actor_json: string;
          connection_id: string;
          expires_at: string;
          binding_hash: string;
          phase: string;
        }>(
          "SELECT actor_json,connection_id,expires_at,binding_hash,phase FROM granola_oauth_callback_bindings WHERE workspace_id=$1 AND state_hash=$2 FOR UPDATE",
          [input.workspaceId, stateHash]
        )
      ).rows[0];
      if (
        !row ||
        row.phase !== "pending" ||
        !Number.isFinite(Date.parse(row.expires_at)) ||
        Date.parse(row.expires_at) <= Date.now()
      )
        throw new Error("Invalid callback");
      const actor = JSON.parse(row.actor_json) as GranolaOwnerActor;
      if (
        hash([input.workspaceId, stateHash, actor, row.connection_id, row.expires_at]) !==
        row.binding_hash
      )
        throw new Error("Invalid callback binding");
      await transaction.query(
        "UPDATE granola_oauth_callback_bindings SET phase='processing' WHERE workspace_id=$1 AND state_hash=$2",
        [input.workspaceId, stateHash]
      );
      return { actor, connectionId: row.connection_id };
    });
    try {
      const result = await input.connections.complete({
        actor: binding.actor,
        callbackUrl: callback.href
      });
      if (result.connectionId !== binding.connectionId)
        throw new Error("Connection identity changed");
      await input.afterConnectionsChanged();
      await input.database.query(
        "UPDATE granola_oauth_callback_bindings SET phase='completed' WHERE workspace_id=$1 AND state_hash=$2 AND phase='processing'",
        [input.workspaceId, stateHash]
      );
    } catch {
      await input.database
        .query(
          "UPDATE granola_oauth_callback_bindings SET phase='failed' WHERE workspace_id=$1 AND state_hash=$2 AND phase='processing'",
          [input.workspaceId, stateHash]
        )
        .catch(() => undefined);
      throw new Error("Connection callback could not complete");
    }
  }

  async function begin(actor: GranolaOwnerActor) {
    const boundActor = structuredClone(actor);
    try {
      const result = await input.connections.begin({ actor: boundActor });
      const authorization = new URL(result.authorizationUrl);
      const state = authorization.searchParams.get("state");
      if (
        authorization.origin !== "https://mcp-auth.granola.ai" ||
        authorization.pathname !== "/oauth2/authorize" ||
        authorization.searchParams.get("redirect_uri") !== redirect.href ||
        !state ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error("Granola authorization identity is invalid");
      const stateHash = hash(state);
      await input.database.query(
        "INSERT INTO granola_oauth_callback_bindings(workspace_id,state_hash,actor_json,connection_id,expires_at,binding_hash,phase) VALUES($1,$2,$3,$4,$5,$6,'pending')",
        [
          input.workspaceId,
          stateHash,
          JSON.stringify(boundActor),
          result.connectionId,
          result.expiresAt,
          hash([
            input.workspaceId,
            stateHash,
            boundActor,
            result.connectionId,
            result.expiresAt
          ])
        ]
      );
      return result;
    } finally {
      // Reconnect retires the previous grant even if registration later fails.
      await input.afterConnectionsChanged();
    }
  }

  return {
    begin({ actor }: { actor: GranolaOwnerActor }) {
      if (stopped || !listening)
        return Promise.reject(new Error("Granola callback listener is unavailable"));
      const pending = begin(actor).finally(() => beginnings.delete(pending));
      beginnings.add(pending);
      return pending;
    },
    start() {
      if (stopped || starting)
        return Promise.reject(new Error("Granola callback listener cannot start"));
      starting = new Promise<{ port: number }>((resolve, reject) => {
        const failed = () =>
          reject(new Error("Granola callback listener could not start"));
        server.once("error", failed);
        server.listen(port, input.hostname ?? "127.0.0.1", () => {
          server.removeListener("error", failed);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Granola callback listener has no TCP address"));
            return;
          }
          listening = true;
          if (stopped) {
            reject(new Error("Granola callback listener stopped during startup"));
            return;
          }
          resolve({ port: address.port });
        });
      });
      return starting;
    },
    status: () => ({ listening, activeCallbacks: active.size }),
    stop() {
      stopped = true;
      stopping ??= (async () => {
        await starting?.catch(() => undefined);
        const closed = new Promise<void>((resolve, reject) => {
          if (!listening) {
            resolve();
            return;
          }
          server.close((error) =>
            error
              ? reject(new Error("Granola callback listener could not stop"))
              : resolve()
          );
          server.closeIdleConnections();
        });
        const drained = await Promise.allSettled([closed, ...active, ...beginnings]);
        listening = false;
        const failure = drained.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return stopping;
    }
  };
}

function reply(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(message);
}
