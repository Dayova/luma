import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { LumaDatabase } from "../persistence/db.js";
import { granolaPolicySchema } from "./policy.js";
import { GranolaOAuthError } from "./oauth-http.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";

export const granolaOAuthStateSchema = z
  .object({
    ownerPersonId: z.enum(dayovaFounderPersonIds),
    connectionId: z.string().min(1),
    phase: z.enum([
      "registering",
      "awaiting-authorization",
      "exchanging",
      "connected",
      "refreshing",
      "reconnect-required",
      "disconnected"
    ]),
    clientId: z.string().nullable(),
    attempt: z
      .object({ state: z.string(), verifier: z.string(), expiresAt: z.string() })
      .nullable(),
    tokens: z
      .object({
        accessToken: z.string(),
        refreshToken: z.string(),
        expiresAt: z.string()
      })
      .nullable(),
    policy: granolaPolicySchema.shape.connections.element.nullable(),
    lastFailure: z
      .enum(["authorization-incomplete", "exchange-unproven", "refresh-unproven"])
      .nullable()
  })
  .strict();
export type GranolaOAuthState = z.infer<typeof granolaOAuthStateSchema>;
/** Credential ciphertext uses the existing owned transactional store; the key is separate. */
export async function createGranolaOAuthStore(input: {
  database: LumaDatabase;
  workspaceId: string;
  encryptionKey: Uint8Array;
}) {
  if (input.encryptionKey.length !== 32 || !input.workspaceId.trim())
    throw new GranolaOAuthError("store-unavailable");
  const key = Buffer.from(input.encryptionKey);
  await input.database.exec(
    "CREATE TABLE IF NOT EXISTS granola_oauth_connections(workspace_id TEXT NOT NULL,owner_person_id TEXT NOT NULL,ciphertext TEXT NOT NULL,PRIMARY KEY(workspace_id,owner_person_id))"
  );
  const aad = (owner: string) =>
    Buffer.from(JSON.stringify(["luma-granola-oauth-v1", input.workspaceId, owner]));
  const seal = (owner: string, state: GranolaOAuthState) => {
    if (
      state.ownerPersonId !== owner ||
      (state.policy &&
        (state.policy.ownerPersonId !== owner ||
          state.policy.connectionId !== state.connectionId))
    )
      throw new GranolaOAuthError("store-unavailable");
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(owner));
    const text = JSON.stringify(granolaOAuthStateSchema.parse(state));
    return encrypt(text);
    function encrypt(value: string) {
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    }
  };
  const decode = (owner: string, ciphertext: string) => {
    try {
      const bytes = Buffer.from(ciphertext, "base64");
      if (bytes.length < 29 || bytes.length > 250_000) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(aad(owner));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const state = granolaOAuthStateSchema.parse(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(
            "utf8"
          )
        )
      );
      if (
        state.ownerPersonId !== owner ||
        (state.policy &&
          (state.policy.ownerPersonId !== owner ||
            state.policy.connectionId !== state.connectionId))
      )
        throw new Error();
      return state;
    } catch {
      throw new GranolaOAuthError("store-unavailable");
    }
  };
  const read = async (owner: string): Promise<GranolaOAuthState | null> => {
    const rows = await input.database.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM granola_oauth_connections WHERE workspace_id=$1 AND owner_person_id=$2",
      [input.workspaceId, owner]
    );
    return rows.rows[0] ? decode(owner, rows.rows[0].ciphertext) : null;
  };
  return {
    read,
    async list() {
      const rows = await input.database.query<{
        owner_person_id: string;
        ciphertext: string;
      }>(
        "SELECT owner_person_id,ciphertext FROM granola_oauth_connections WHERE workspace_id=$1 ORDER BY owner_person_id",
        [input.workspaceId]
      );
      if (rows.rows.length > 4) throw new GranolaOAuthError("store-unavailable");
      return rows.rows.map((row) => decode(row.owner_person_id, row.ciphertext));
    },
    async update(
      owner: string,
      change: (state: GranolaOAuthState | null) => GranolaOAuthState
    ) {
      return input.database.transaction(async (tx) => {
        const rows = await tx.query<{ ciphertext: string }>(
          "SELECT ciphertext FROM granola_oauth_connections WHERE workspace_id=$1 AND owner_person_id=$2 FOR UPDATE",
          [input.workspaceId, owner]
        );
        const state = change(
          rows.rows[0] ? decode(owner, rows.rows[0].ciphertext) : null
        );
        if (state.ownerPersonId !== owner)
          throw new GranolaOAuthError("store-unavailable");
        await tx.query(
          "INSERT INTO granola_oauth_connections(workspace_id,owner_person_id,ciphertext) VALUES($1,$2,$3) ON CONFLICT(workspace_id,owner_person_id) DO UPDATE SET ciphertext=excluded.ciphertext",
          [input.workspaceId, owner, seal(owner, state)]
        );
        return structuredClone(state);
      });
    }
  };
}
