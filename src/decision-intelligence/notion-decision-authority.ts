import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DecisionAudience,
  DecisionAuthoritySnapshot
} from "../domain/decision-records.js";
import {
  decisionAudienceSchema,
  decisionAuthoritySnapshotSchema
} from "../domain/decision-record-schemas.js";
import {
  isIssuedNotionKnowledgeCatalog,
  type NotionKnowledgeCatalog
} from "../knowledge/notion-read-only-knowledge-catalog.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { DecisionAuthority } from "./ports.js";
import { decisionDigest } from "./persistence.js";
import { NOTION_OPERATION_TIMEOUT_MS } from "../knowledge/notion-request-scheduler.js";

const id = z.string().trim().min(1).max(512);
const grantSchema = z
  .object({
    id,
    personId: id,
    scopeId: id,
    kind: z.enum([
      "project-ownership",
      "delegation",
      "confirmed-scope",
      "provisional-role"
    ]),
    standing: z.enum(["current", "provisional", "superseded"]),
    excerpt: z.string().min(1).max(8000),
    delegatedBy: id.nullable(),
    consultedPersonIds: z.array(id).max(100)
  })
  .strict();
const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: id,
    documentId: z.string().uuid(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    grants: z.array(grantSchema).min(1).max(100)
  })
  .strict()
  .refine(
    (value) => new Set(value.grants.map((grant) => grant.id)).size === value.grants.length
  );
export type NotionDecisionAuthorityPolicy = z.infer<typeof policySchema>;
export type SourceBackedDecisionAuthority = DecisionAuthority & {
  /** Read/projection only; never substitute this for exact execution currentness. */
  authorizeRetainedAuthority(input: {
    audience: DecisionAudience;
    snapshot: DecisionAuthoritySnapshot;
    signal?: AbortSignal;
  }): Promise<boolean>;
};
export function decisionAuthorityContentHash(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
const unavailable = () =>
  new Error(
    "Decision authority could not be verified from its current protected mapping and governed responsibility source."
  );
async function readPolicy(
  path: string,
  workspaceId: string
): Promise<NotionDecisionAuthorityPolicy> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      ![0, process.geteuid?.()].includes(before.uid) ||
      before.size < 1 ||
      before.size > 65536
    )
      throw unavailable();
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      bytesRead > 65536 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      throw unavailable();
    const policy = policySchema.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown
    );
    if (policy.workspaceId !== workspaceId) throw unavailable();
    return policy;
  } finally {
    await file.close();
  }
}
export function createNotionDecisionAuthority(input: {
  database: LumaDatabase;
  workspaceId: string;
  policyPath: string;
  knowledge: NotionKnowledgeCatalog;
  recipientPersonIds: readonly string[];
}): SourceBackedDecisionAuthority {
  if (
    !isIssuedNotionKnowledgeCatalog(input.knowledge) ||
    !input.workspaceId.trim() ||
    !isAbsolute(input.policyPath) ||
    !input.recipientPersonIds.length ||
    new Set(input.recipientPersonIds).size !== input.recipientPersonIds.length
  )
    throw unavailable();
  const recipients = [...input.recipientPersonIds];
  const audience = (value: DecisionAudience) => {
    const parsed = decisionAudienceSchema.parse(value);
    if (
      parsed.workspaceId !== input.workspaceId ||
      !parsed.personIds.every((person) => recipients.includes(person))
    )
      throw unavailable();
    return { ...parsed, personIds: [...parsed.personIds].sort() };
  };
  const read: DecisionAuthority["read"] = (request) =>
    bounded(async (check, signal) => {
      const bound = audience(request.audience),
        policy = await readPolicy(input.policyPath, input.workspaceId);
      if (
        policy.grants.some(
          (grant) =>
            !recipients.includes(grant.personId) ||
            (grant.delegatedBy !== null && !recipients.includes(grant.delegatedBy)) ||
            grant.consultedPersonIds.some((person) => !recipients.includes(person))
        )
      )
        throw unavailable();
      check();
      const document = await input.knowledge.readDocument({
        audience: bound,
        signal,
        documentId: policy.documentId
      });
      if (
        !document ||
        document.id !== policy.documentId ||
        document.externalReference.providerId !== "notion" ||
        document.externalReference.externalId !== policy.documentId ||
        decisionAuthorityContentHash(document.contentMarkdown) !== policy.contentHash
      )
        throw unavailable();
      check();
      for (const grant of policy.grants) {
        const first = document.contentMarkdown.indexOf(grant.excerpt);
        if (
          first < 0 ||
          document.contentMarkdown.indexOf(grant.excerpt, first + 1) !== -1
        )
          throw unavailable();
      }
      const source = { ...document.externalReference, version: document.version };
      const snapshot = decisionAuthoritySnapshotSchema.parse({
        id: `notion-authority:${input.workspaceId}:${policy.documentId}`,
        revision: decisionDigest({ policy, version: document.version }),
        source,
        contentHash: policy.contentHash,
        grants: policy.grants.map((grant) => ({
          id: grant.id,
          personId: grant.personId,
          scopeId: grant.scopeId,
          kind: grant.kind,
          standing: grant.standing,
          delegatedBy: grant.delegatedBy,
          consultedPersonIds: grant.consultedPersonIds,
          evidence: [
            {
              evidenceId: `authority:${grant.id}:${document.version}`,
              source: "knowledge",
              sourceObjectId: policy.documentId,
              sourceVersion: document.version,
              excerpt: grant.excerpt,
              externalReference: source
            }
          ]
        }))
      });
      check();
      const current = await input.knowledge.readDocument({
        audience: bound,
        signal,
        documentId: policy.documentId
      });
      check();
      const currentPolicy = await readPolicy(input.policyPath, input.workspaceId);
      if (
        !current ||
        decisionDigest(current) !== decisionDigest(document) ||
        decisionDigest(currentPolicy) !== decisionDigest(policy)
      )
        throw unavailable();
      check();
      await input.database.query(
        `INSERT INTO decision_authority_snapshots(workspace_id,snapshot_hash,audience_hash,snapshot_json,audience_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
          input.workspaceId,
          decisionDigest(snapshot),
          decisionDigest(bound),
          JSON.stringify(snapshot),
          JSON.stringify(bound)
        ]
      );
      check();
      const finalDocument = await input.knowledge.readDocument({
        audience: bound,
        signal,
        documentId: policy.documentId
      });
      check();
      const finalPolicy = await readPolicy(input.policyPath, input.workspaceId);
      check();
      if (
        !finalDocument ||
        decisionDigest(finalDocument) !== decisionDigest(document) ||
        decisionDigest(finalPolicy) !== decisionDigest(policy)
      )
        throw unavailable();
      return snapshot;
    }).catch(() => {
      throw unavailable();
    });
  const retained = (request: {
    audience: DecisionAudience;
    snapshot: DecisionAuthoritySnapshot;
    signal?: AbortSignal;
  }): Promise<boolean> =>
    bounded(async (check, signal) => {
      try {
        const bound = audience(request.audience),
          snapshot = decisionAuthoritySnapshotSchema.parse(
            structuredClone(request.snapshot)
          );
        if (
          snapshot.source.providerId !== "notion" ||
          snapshot.source.objectType !== "document"
        )
          return false;
        const records = await input.database.query<{
          snapshot_json: string;
          audience_json: string;
          audience_hash: string;
        }>(
          `SELECT snapshot_json,audience_json,audience_hash FROM decision_authority_snapshots WHERE workspace_id=$1 AND snapshot_hash=$2`,
          [input.workspaceId, decisionDigest(snapshot)]
        );
        check();
        const original = records.rows.some((row) => {
          const originalAudience = decisionAudienceSchema.parse(
            JSON.parse(row.audience_json) as unknown
          );
          return (
            decisionDigest(JSON.parse(row.snapshot_json) as unknown) ===
              decisionDigest(snapshot) &&
            decisionDigest(originalAudience) === row.audience_hash &&
            originalAudience.workspaceId === bound.workspaceId &&
            bound.personIds.every((person) => originalAudience.personIds.includes(person))
          );
        });
        if (!original) return false;
        const document = await input.knowledge.readDocument({
          audience: bound,
          signal,
          documentId: snapshot.source.externalId
        });
        check();
        return (
          !!document &&
          document.id === snapshot.source.externalId &&
          document.externalReference.providerId === "notion" &&
          document.externalReference.externalId === snapshot.source.externalId
        );
      } catch {
        return false;
      }
    }, request.signal).catch(() => false);
  return {
    read,
    requireCurrent: async (request) => {
      const snapshot = structuredClone(request.snapshot);
      const current = await read({ audience: request.audience });
      if (decisionDigest(snapshot) !== decisionDigest(current)) throw unavailable();
    },
    authorizeRetainedAuthority: retained
  };
}

function bounded<T>(
  operation: (check: () => void, signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outer?.aborted) abort();
  else outer?.addEventListener("abort", abort, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(unavailable());
    else
      controller.signal.addEventListener("abort", () => reject(unavailable()), {
        once: true
      });
  });
  const timer = setTimeout(abort, NOTION_OPERATION_TIMEOUT_MS);
  return Promise.race([
    operation(() => {
      if (controller.signal.aborted) throw unavailable();
    }, controller.signal),
    timeout
  ]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  });
}
