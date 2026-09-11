import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { LumaDatabase } from "../persistence/db.js";
import {
  createGranolaOAuthConnections,
  type GranolaOwnerActor
} from "../granola/oauth-connections.js";
import { GranolaOAuthError } from "../granola/oauth-http.js";

/** No credentials or network are touched by deployment preflight. */
export function granolaOAuthRuntimeConfig(env: NodeJS.ProcessEnv) {
  const enabled = env["LUMA_GRANOLA_OAUTH_ENABLED"];
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") throw new GranolaOAuthError("unavailable");
  const keyPath = env["LUMA_GRANOLA_CREDENTIAL_KEY_PATH"];
  const redirectUri = env["LUMA_GRANOLA_OAUTH_REDIRECT_URI"];
  const hostname = env["LUMA_GRANOLA_OAUTH_HTTP_HOST"] ?? "127.0.0.1";
  const configuredPort = env["LUMA_GRANOLA_OAUTH_HTTP_PORT"] ?? "3002";
  if (
    !keyPath ||
    !isAbsolute(keyPath) ||
    !redirectUri ||
    !["127.0.0.1", "::1"].includes(hostname) ||
    !/^\d{1,5}$/u.test(configuredPort)
  )
    throw new GranolaOAuthError("store-unavailable");
  const port = Number(configuredPort);
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new GranolaOAuthError("unavailable");
  }
  if (
    port < 1 ||
    port > 65535 ||
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
    throw new GranolaOAuthError("unavailable");
  return { keyPath, redirectUri: redirect.href, hostname, port };
}

/** Startup composition only. No OAuth request, consent or personal source read occurs here. */
export async function granolaOAuthConnectionsFromEnv(input: {
  database: LumaDatabase;
  workspaceId: string;
  env: NodeJS.ProcessEnv;
  authorizeOwner: (actor: GranolaOwnerActor) => Promise<string | null>;
  fetch?: typeof fetch;
}) {
  const config = granolaOAuthRuntimeConfig(input.env);
  if (!config) return null;
  const { keyPath: path, redirectUri } = config;
  let key: Buffer | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== 32 ||
        (stat.mode & 0o077) !== 0 ||
        (stat.uid !== 0 && stat.uid !== process.geteuid?.())
      )
        throw new GranolaOAuthError("store-unavailable");
      key = await file.readFile();
    } finally {
      await file.close();
    }
    return await createGranolaOAuthConnections({
      ...input,
      encryptionKey: key,
      redirectUri
    });
  } catch {
    throw new GranolaOAuthError("store-unavailable");
  } finally {
    key?.fill(0);
  }
}
