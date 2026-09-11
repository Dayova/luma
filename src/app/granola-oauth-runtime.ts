import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { LumaDatabase } from "../persistence/db.js";
import {
  createGranolaOAuthConnections,
  type GranolaOwnerActor
} from "../granola/oauth-connections.js";
import { GranolaOAuthError } from "../granola/oauth-http.js";

/** Startup composition only. No OAuth request, consent or personal source read occurs here. */
export async function granolaOAuthConnectionsFromEnv(input: {
  database: LumaDatabase;
  workspaceId: string;
  env: NodeJS.ProcessEnv;
  authorizeOwner: (actor: GranolaOwnerActor) => Promise<string | null>;
  fetch?: typeof fetch;
}) {
  const enabled = input.env["LUMA_GRANOLA_OAUTH_ENABLED"];
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") throw new GranolaOAuthError("unavailable");
  const path = input.env["LUMA_GRANOLA_CREDENTIAL_KEY_PATH"],
    redirectUri = input.env["LUMA_GRANOLA_OAUTH_REDIRECT_URI"];
  if (!path || !isAbsolute(path) || !redirectUri)
    throw new GranolaOAuthError("store-unavailable");
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
