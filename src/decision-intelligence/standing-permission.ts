import { z } from "zod";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { DecisionStandingGrant } from "../domain/automatic-decisions.js";
import type {
  DecisionAudience,
  DecisionAuthoritySnapshot
} from "../domain/decision-records.js";
import { decisionAuthoritySnapshotSchema } from "../domain/decision-record-schemas.js";
import type { LumaDatabase } from "../persistence/db.js";
import { decisionStandingGrantSchema } from "./automatic-policy.js";
import { decisionDigest } from "./persistence.js";
import type { DecisionAuthority, DecisionStandingPolicy } from "./ports.js";
import { decisionScopeOwnership } from "./scope-ownership.js";

const id = z.string().min(1).max(512);
const snowflake = z.string().regex(/^[1-9]\d{16,19}$/u);
const permissionClass = z.enum(["new-decisions", "decisions-and-corrections"]);
export type DecisionPermissionClass = z.infer<typeof permissionClass>;
const commandSchema = z
  .object({
    interactionId: snowflake,
    guildId: snowflake,
    channelId: snowflake,
    actorDiscordUserId: snowflake,
    occurredAt: z.string().datetime({ offset: true }),
    scopeId: id,
    choice: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("enable"),
          permissionClass,
          sharing: z.literal("four-founders")
        })
        .strict(),
      z.object({ action: z.literal("status") }).strict(),
      z.object({ action: z.literal("disable") }).strict()
    ])
  })
  .strict();
/** Created only from authenticated native slash options, never from discussion text. */
export type DecisionPermissionCommand = z.infer<typeof commandSchema>;
const boundarySchema = z
  .object({
    guildId: snowflake,
    channelId: snowflake,
    kind: z.enum(["text-channel", "public-thread"]),
    parentChannelId: snowflake.nullable(),
    readers: z
      .array(z.object({ personId: id, providerUserId: snowflake }).strict())
      .length(4)
  })
  .strict();
export type DecisionPermissionBoundary = z.infer<typeof boundarySchema>;
export interface DecisionPermissionSourceAccess {
  capture(input: {
    audience: DecisionAudience;
    command: DecisionPermissionCommand;
  }): Promise<DecisionPermissionBoundary>;
  requireCurrent(input: {
    audience: DecisionAudience;
    boundary: DecisionPermissionBoundary;
  }): Promise<void>;
}
const retainedSchema = z
  .object({
    command: commandSchema,
    personId: id,
    boundary: boundarySchema,
    authority: decisionAuthoritySnapshotSchema.nullable(),
    grant: decisionStandingGrantSchema.nullable()
  })
  .strict();
type Retained = z.infer<typeof retainedSchema>;
type Row = { payload_json: string; payload_hash: string };
export type DecisionPermissionStatus = {
  scopeId: string;
  personId: string;
  state: "disabled" | "active" | "unavailable";
  grant: DecisionStandingGrant | null;
  permissionClass: DecisionPermissionClass | null;
  instructionId: string | null;
};
export type ManagedDecisionStandingPolicy = DecisionStandingPolicy & {
  command(input: DecisionPermissionCommand): Promise<DecisionPermissionStatus>;
  /** Drains admitted policy operations before the shared store closes. */
  stop(): Promise<void>;
};

export const decisionPermissionDescriptions: Record<DecisionPermissionClass, string> = {
  "new-decisions":
    "Record my final decisions and accepted proposals; create or link records, without changing existing records.",
  "decisions-and-corrections":
    "Record my final decisions and accepted proposals; also amend, supersede or reverse existing records when my original decision explicitly supports that action."
};

/** Native Human permission is retained independently from current decision-making authority. */
export async function createDecisionStandingPolicy(input: {
  database: LumaDatabase;
  workspaceId: string;
  audience: DecisionAudience;
  accessPolicy: WorkspaceAccessPolicy;
  authority: DecisionAuthority;
  sourceAccess: DecisionPermissionSourceAccess;
}): Promise<ManagedDecisionStandingPolicy> {
  const audience = {
    workspaceId: input.workspaceId,
    personIds: [...input.audience.personIds].sort()
  };
  if (
    input.audience.workspaceId !== input.workspaceId ||
    audience.personIds.length !== 4 ||
    new Set(audience.personIds).size !== 4
  )
    throw new Error(
      "Standing recording permission requires the exact four-founder audience"
    );
  await input.database.exec(`
    CREATE TABLE IF NOT EXISTS decision_standing_instructions (
      workspace_id TEXT NOT NULL, instruction_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      PRIMARY KEY(workspace_id, instruction_id)
    );
    CREATE TABLE IF NOT EXISTS decision_standing_heads (
      workspace_id TEXT NOT NULL, person_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      instruction_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id, person_id, scope_id),
      FOREIGN KEY(workspace_id, instruction_id)
        REFERENCES decision_standing_instructions(workspace_id, instruction_id)
    );
  `);
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (stopped)
      return Promise.reject(new Error("Standing permission service is stopped"));
    const promise = operation();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  }
  function requireAudience(requested: DecisionAudience) {
    if (
      decisionDigest({ ...requested, personIds: [...requested.personIds].sort() }) !==
      decisionDigest(audience)
    )
      throw new Error("The original standing permission audience is unavailable");
  }
  async function requireActor(command: DecisionPermissionCommand, expected?: string) {
    const person = await input.accessPolicy.authorize({
      workspaceId: input.workspaceId,
      providerId: "discord",
      providerUserId: command.actorDiscordUserId
    });
    if (
      !person ||
      !audience.personIds.includes(person.personId) ||
      (expected && expected !== person.personId)
    )
      throw new Error("The original founder identity is unavailable");
    return person.personId;
  }
  function requireOwner(
    authority: DecisionAuthoritySnapshot,
    personId: string,
    scopeId: string
  ) {
    const ownership = decisionScopeOwnership(authority, scopeId);
    if (typeof ownership === "string" || ownership.owner !== personId)
      throw new Error(
        "Current responsibility evidence must establish you as the accountable owner of this exact scope"
      );
  }
  function makeGrant(retained: Omit<Retained, "grant">): DecisionStandingGrant | null {
    const { command, personId } = retained;
    if (command.choice.action !== "enable") return null;
    if (!retained.authority) throw new Error("Original ownership evidence is missing");
    requireOwner(retained.authority, personId, command.scopeId);
    const revision = decisionDigest(retained);
    const source = {
      providerId: "discord",
      objectType: "other" as const,
      externalId: `interaction:${command.interactionId}`,
      // Discord has no durable message permalink for an ephemeral slash input.
      url: `https://discord.com/channels/${command.guildId}/${command.channelId}`,
      version: revision
    };
    const instruction = `/decision-record automatic action:enable scope:${command.scopeId} class:${command.choice.permissionClass} sharing:four-founders\n${decisionPermissionDescriptions[command.choice.permissionClass]} Share these records with the four Dayova founders. This permission grants no decision-making authority.`;
    const corrections = command.choice.permissionClass === "decisions-and-corrections";
    const grant = {
      id: `discord:${command.interactionId}:automatic-recording`,
      revision,
      contentHash: revision,
      source,
      audience,
      purpose: "automatic-decision-recording" as const,
      authorizedBy: personId,
      actor: { providerId: "discord", providerUserId: command.actorDiscordUserId },
      instruction,
      evidence: {
        evidenceId: `standing:${command.interactionId}`,
        source: "human-judgment" as const,
        sourceObjectId: source.externalId,
        participantId: personId,
        sourceVersion: revision,
        excerpt: instruction,
        externalReference: source
      },
      scopeId: command.scopeId,
      actions: corrections
        ? ["create", "link", "amend", "supersede", "reverse"]
        : ["create", "link"],
      modalities: corrections
        ? ["final-decision", "accepted-proposal", "reversal"]
        : ["final-decision", "accepted-proposal"],
      dispositions: ["adopt", "pause", "discard"],
      validFrom: command.occurredAt,
      validUntil: null
    };
    return decisionStandingGrantSchema.parse(grant);
  }
  function decode(row: Row): Retained {
    const raw: unknown = JSON.parse(row.payload_json);
    if (decisionDigest(raw) !== row.payload_hash)
      throw new Error("Standing permission integrity check failed");
    const retained = retainedSchema.parse(raw);
    if (
      !audience.personIds.includes(retained.personId) ||
      retained.command.guildId !== retained.boundary.guildId ||
      retained.command.channelId !== retained.boundary.channelId ||
      !retained.boundary.readers.some(
        (reader) =>
          reader.personId === retained.personId &&
          reader.providerUserId === retained.command.actorDiscordUserId
      )
    )
      throw new Error("Standing permission original identity does not match");
    const { grant, ...original } = retained;
    if (decisionDigest(grant) !== decisionDigest(makeGrant(original)))
      throw new Error("Standing permission original instruction does not match");
    return retained;
  }
  async function head(personId: string, scopeId: string): Promise<Retained | null> {
    const result = await input.database.query<Row>(
      `SELECT i.payload_json, i.payload_hash FROM decision_standing_heads h JOIN decision_standing_instructions i USING(workspace_id, instruction_id) WHERE h.workspace_id=$1 AND h.person_id=$2 AND h.scope_id=$3`,
      [input.workspaceId, personId, scopeId]
    );
    const value = result.rows[0] ? decode(result.rows[0]) : null;
    if (value && (value.personId !== personId || value.command.scopeId !== scopeId))
      throw new Error("Standing permission head does not match its original instruction");
    return value;
  }
  async function current(
    retained: Retained,
    pass?: {
      authority: DecisionAuthoritySnapshot;
      boundaries: Map<string, Promise<void>>;
    }
  ) {
    if (!retained.grant) throw new Error("Standing permission is disabled");
    await requireActor(retained.command, retained.personId);
    const authority = pass?.authority ?? (await input.authority.read({ audience }));
    requireOwner(authority, retained.personId, retained.command.scopeId);
    if (!pass) await input.authority.requireCurrent({ audience, snapshot: authority });
    const key = decisionDigest(retained.boundary);
    let proof = pass?.boundaries.get(key);
    if (!proof) {
      proof = input.sourceAccess.requireCurrent({
        audience,
        boundary: retained.boundary
      });
      pass?.boundaries.set(key, proof);
    }
    await proof;
    await requireActor(retained.command, retained.personId);
    const latest = await head(retained.personId, retained.command.scopeId);
    if (
      latest?.grant?.id !== retained.grant.id ||
      decisionDigest(latest) !== decisionDigest(retained)
    )
      throw new Error("Standing permission has been changed or revoked");
  }
  async function status(
    personId: string,
    scopeId: string
  ): Promise<DecisionPermissionStatus> {
    const retained = await head(personId, scopeId);
    let state: DecisionPermissionStatus["state"] = "disabled";
    if (retained?.grant) {
      try {
        await current(retained);
        state = "active";
      } catch {
        state = "unavailable";
      }
      const latest = await head(personId, scopeId);
      if (decisionDigest(latest) !== decisionDigest(retained))
        throw new Error(
          "Standing permission changed while reading status; request status again"
        );
    }
    return {
      scopeId,
      personId,
      state,
      grant: retained?.grant ?? null,
      permissionClass:
        retained?.command.choice.action === "enable"
          ? retained.command.choice.permissionClass
          : null,
      instructionId: retained?.command.interactionId ?? null
    };
  }
  return {
    command: (command) =>
      run(async () => {
        command = commandSchema.parse(command);
        const personId = await requireActor(command);
        const boundary = boundarySchema.parse(
          await input.sourceAccess.capture({ audience, command })
        );
        if (command.choice.action !== "status") {
          const existing = await input.database.query<Row>(
            "SELECT payload_json,payload_hash FROM decision_standing_instructions WHERE workspace_id=$1 AND instruction_id=$2",
            [input.workspaceId, command.interactionId]
          );
          if (existing.rows[0]) {
            if (
              decisionDigest(decode(existing.rows[0]).command) !== decisionDigest(command)
            )
              throw new Error(
                "This native interaction already has different permission options"
              );
          } else {
            const authority =
              command.choice.action === "enable"
                ? await input.authority.read({ audience })
                : null;
            if (authority) {
              requireOwner(authority, personId, command.scopeId);
              await input.authority.requireCurrent({ audience, snapshot: authority });
            }
            const original = { command, personId, boundary, authority };
            const retained: Retained = { ...original, grant: makeGrant(original) };
            await input.sourceAccess.requireCurrent({ audience, boundary });
            await requireActor(command, personId);
            await input.database.transaction(async (tx) => {
              const duplicate = await tx.query<Row>(
                "SELECT payload_json,payload_hash FROM decision_standing_instructions WHERE workspace_id=$1 AND instruction_id=$2",
                [input.workspaceId, command.interactionId]
              );
              if (duplicate.rows[0]) {
                if (
                  decisionDigest(decode(duplicate.rows[0]).command) !==
                  decisionDigest(command)
                )
                  throw new Error(
                    "This native interaction already has different permission options"
                  );
                return;
              }
              const previous = await tx.query<{ instruction_id: string }>(
                "SELECT instruction_id FROM decision_standing_heads WHERE workspace_id=$1 AND person_id=$2 AND scope_id=$3",
                [input.workspaceId, personId, command.scopeId]
              );
              const previousId = previous.rows[0]?.instruction_id;
              // Native Discord snowflakes encode issuance order; a delayed old enable cannot undo a later disable.
              const advances =
                !previousId || BigInt(command.interactionId) > BigInt(previousId);
              if (advances && retained.grant) {
                const active = await tx.query<{ count: number }>(
                  `SELECT COUNT(*)::int AS count FROM decision_standing_heads h JOIN decision_standing_instructions i USING(workspace_id,instruction_id) WHERE h.workspace_id=$1 AND NOT(h.person_id=$2 AND h.scope_id=$3) AND i.payload_json::jsonb->'grant' <> 'null'::jsonb`,
                  [input.workspaceId, personId, command.scopeId]
                );
                if ((active.rows[0]?.count ?? 20) >= 20)
                  throw new Error(
                    "At most 20 active recording permissions are supported; disable an unused scope first"
                  );
              }
              await tx.query(
                "INSERT INTO decision_standing_instructions VALUES($1,$2,$3,$4)",
                [
                  input.workspaceId,
                  command.interactionId,
                  JSON.stringify(retained),
                  decisionDigest(retained)
                ]
              );
              if (advances)
                await tx.query(
                  "INSERT INTO decision_standing_heads VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,person_id,scope_id) DO UPDATE SET instruction_id=EXCLUDED.instruction_id",
                  [input.workspaceId, personId, command.scopeId, command.interactionId]
                );
            });
          }
        }
        const result = await status(personId, command.scopeId);
        await input.sourceAccess.requireCurrent({ audience, boundary });
        await requireActor(command, personId);
        const finalHead = await head(personId, command.scopeId);
        if (
          (finalHead?.command.interactionId ?? null) !== result.instructionId ||
          decisionDigest(finalHead?.grant ?? null) !== decisionDigest(result.grant)
        )
          throw new Error("Standing permission changed before the result was delivered");
        return result;
      }),
    read: (requested) =>
      run(async () => {
        requireAudience(requested.audience);
        const rows = await input.database.query<Row>(
          `SELECT i.payload_json,i.payload_hash FROM decision_standing_heads h JOIN decision_standing_instructions i USING(workspace_id,instruction_id) WHERE h.workspace_id=$1 AND i.payload_json::jsonb->'grant' <> 'null'::jsonb ORDER BY h.person_id,h.scope_id LIMIT 21`,
          [input.workspaceId]
        );
        const retained = rows.rows.map(decode).filter((value) => value.grant);
        if (retained.length > 20)
          throw new Error("Standing permission catalog exceeds its supported bound");
        if (!retained.length) return [];
        const authority = await input.authority.read({ audience });
        const pass = { authority, boundaries: new Map<string, Promise<void>>() };
        const grants: DecisionStandingGrant[] = [];
        for (const value of retained) {
          try {
            await current(value, pass);
            grants.push(value.grant!);
          } catch {
            /* A dormant grant never authorizes a write. */
          }
        }
        await input.authority.requireCurrent({ audience, snapshot: authority });
        // A revocation during another grant's proof must fence the complete result too.
        const finalPass = { authority, boundaries: new Map<string, Promise<void>>() };
        const valid: DecisionStandingGrant[] = [];
        for (const value of retained.filter((item) =>
          grants.some((grant) => grant.id === item.grant?.id)
        )) {
          try {
            await current(value, finalPass);
            valid.push(value.grant!);
          } catch {
            /* Fresh complete-pass source/grant withdrawal withholds this permission. */
          }
        }
        // Later boundary checks may themselves admit a concurrent disable.
        const currentGrants: DecisionStandingGrant[] = [];
        for (const grant of valid)
          if (
            decisionDigest((await head(grant.authorizedBy, grant.scopeId))?.grant) ===
            decisionDigest(grant)
          )
            currentGrants.push(grant);
        return currentGrants;
      }),
    requireCurrent: (requested) =>
      run(async () => {
        requireAudience(requested.audience);
        const grant = decisionStandingGrantSchema.parse(requested.grant);
        const retained = await head(grant.authorizedBy, grant.scopeId);
        if (!retained || decisionDigest(retained.grant) !== decisionDigest(grant))
          throw new Error("Standing permission has been changed or revoked");
        await current(retained);
      }),
    async stop() {
      stopped = true;
      await Promise.allSettled([...pending]);
    }
  };
}
