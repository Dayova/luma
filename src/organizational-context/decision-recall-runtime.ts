import { createHash } from "node:crypto";
import { z } from "zod";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  DecisionRecordCatalog,
  DecisionRecordHistoricalRevision
} from "../knowledge/decision-record-catalog.js";
import type {
  DecisionAudience,
  CanonicalDecisionRecord
} from "../domain/decision-records.js";
import {
  canonicalDecisionRecordSchema,
  decisionAudienceSchema,
  decisionExternalReferenceSchema
} from "../domain/decision-record-schemas.js";
import type { ContextCatalog } from "./interface.js";
import { createDecisionContextCatalog } from "./decision-context-catalog.js";

const revisionHintSchema = z
  .object({
    reference: decisionExternalReferenceSchema,
    revisionId: z.string().regex(/^[a-f0-9]{64}$/u),
    ordinal: z.number().int().min(1).max(100),
    recordedAt: z.string().datetime({ offset: true }).nullable(),
    terms: z.array(z.string().min(1).max(80)).max(64),
    active: z.boolean()
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    catalogId: z.string().min(1),
    audience: decisionAudienceSchema,
    observedAt: z.string().datetime(),
    providerSnapshotId: z.string().min(1),
    providerRevision: z.string().min(1),
    historicalRevisions: z.array(revisionHintSchema).max(1000).optional(),
    historyComplete: z.boolean().optional(),
    entries: z
      .array(
        z
          .object({
            reference: decisionExternalReferenceSchema,
            terms: z.array(z.string().min(1).max(80)).max(256),
            active: z.boolean()
          })
          .strict()
      )
      .max(100)
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
type Stored = {
  manifest_json: string | null;
  manifest_hash: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  state: "refreshing" | "ready" | "partial" | "unavailable";
};
export type DecisionRecallStatus = {
  active: boolean;
  scheduled: boolean;
  state: "not-ready" | "ready" | "stale" | "partial" | "unavailable" | "stopped";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  indexedCount: number;
  /** Background discovery never proves that no newer provider record exists. */
  coverage: "partial";
};

/** Background discovery owns only candidate hints. The Context catalog always reads each source live. */
export async function createDecisionRecallRuntime(input: {
  database: LumaDatabase;
  workspaceId: string;
  catalogId: string;
  records: DecisionRecordCatalog;
  audience(): Promise<DecisionAudience | null>;
  intervalMs?: number;
  maxAgeMs?: number;
  candidateLimit?: number;
  now?: () => Date;
}) {
  const intervalMs = input.intervalMs ?? 300_000;
  const maxAgeMs = input.maxAgeMs ?? 900_000;
  const candidateLimit = input.candidateLimit ?? 3;
  if (
    !input.workspaceId.trim() ||
    !input.catalogId.trim() ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 3_600_000 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < intervalMs ||
    maxAgeMs > 86_400_000 ||
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 10
  )
    throw new Error(
      "Decision recall requires bounded workspace, interval and candidate configuration"
    );
  await input.database.exec(`CREATE TABLE IF NOT EXISTS decision_recall_indexes (
    workspace_id TEXT NOT NULL,
    catalog_id TEXT NOT NULL,
    manifest_json TEXT,
    manifest_hash TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('refreshing','ready','partial','unavailable')),
    PRIMARY KEY (workspace_id,catalog_id)
  )`);
  const now = input.now ?? (() => new Date());
  let stopped = false;
  const lifetime = new AbortController();
  const queries = new Set<Promise<unknown>>();
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve()
      .then(work)
      .finally(() => queries.delete(pending));
    queries.add(pending);
    return pending;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<DecisionRecallStatus> | undefined;
  let controller: AbortController | undefined;
  const currentAudience = async () => {
    const value = await input.audience();
    if (!value) return null;
    const parsed = decisionAudienceSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId !== input.workspaceId) return null;
    return { ...parsed.data, personIds: [...parsed.data.personIds].sort() };
  };
  const read = async (): Promise<{ row: Stored | null; manifest: Manifest | null }> => {
    const result = await input.database.query<Stored>(
      "SELECT manifest_json,manifest_hash,last_attempt_at,last_success_at,state FROM decision_recall_indexes WHERE workspace_id=$1 AND catalog_id=$2",
      [input.workspaceId, input.catalogId]
    );
    const row = result.rows[0] ?? null;
    if (!row?.manifest_json) return { row, manifest: null };
    try {
      if (hash(row.manifest_json) !== row.manifest_hash) throw new Error("Invalid index");
      const manifest = manifestSchema.parse(JSON.parse(row.manifest_json));
      if (
        manifest.workspaceId !== input.workspaceId ||
        manifest.catalogId !== input.catalogId ||
        manifest.audience.workspaceId !== input.workspaceId
      )
        throw new Error("Invalid index");
      return { row, manifest };
    } catch {
      return { row, manifest: null };
    }
  };
  const status = async (): Promise<DecisionRecallStatus> => {
    const { row, manifest } = await read();
    const state: DecisionRecallStatus["state"] = stopped
      ? "stopped"
      : !manifest
        ? "not-ready"
        : now().getTime() - Date.parse(manifest.observedAt) >= maxAgeMs
          ? "stale"
          : row?.state === "ready" || (row?.state === "refreshing" && Boolean(running))
            ? "ready"
            : row?.state === "partial"
              ? "partial"
              : "unavailable";
    return {
      active: Boolean(running),
      scheduled: Boolean(timer),
      state,
      lastAttemptAt: row?.last_attempt_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      indexedCount: manifest?.entries.length ?? 0,
      coverage: "partial"
    };
  };
  const storeState = async (state: Stored["state"], at: string, manifest?: Manifest) => {
    if (manifest) {
      const json = JSON.stringify(manifestSchema.parse(manifest));
      await input.database.query(
        `INSERT INTO decision_recall_indexes (workspace_id,catalog_id,manifest_json,manifest_hash,last_attempt_at,last_success_at,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,catalog_id) DO UPDATE SET
         manifest_json=excluded.manifest_json,manifest_hash=excluded.manifest_hash,last_attempt_at=excluded.last_attempt_at,
         last_success_at=excluded.last_success_at,state=excluded.state`,
        [
          input.workspaceId,
          input.catalogId,
          json,
          hash(json),
          at,
          manifest.observedAt,
          state
        ]
      );
    } else
      await input.database.query(
        `INSERT INTO decision_recall_indexes (workspace_id,catalog_id,last_attempt_at,state) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id,catalog_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,state=excluded.state`,
        [input.workspaceId, input.catalogId, at, state]
      );
  };
  const syncOnce = (): Promise<DecisionRecallStatus> => {
    if (stopped) return Promise.reject(new Error("Decision recall is stopped"));
    if (running) return running;
    const owned = new AbortController();
    controller = owned;
    const deadline = setTimeout(() => owned.abort(), 240_000);
    const check = () => {
      if (owned.signal.aborted || stopped)
        throw new Error("Decision recall was cancelled");
    };
    running = (async () => {
      const at = now().toISOString();
      await storeState("refreshing", at);
      try {
        check();
        const audience = await cancellable(owned.signal, currentAudience);
        if (!audience) throw new Error("Decision audience is unavailable");
        const discovery = await cancellable(owned.signal, async () => {
          const request = {
            audience,
            limit: 100,
            signal: owned.signal,
            priority: "background" as const
          };
          return input.records.history
            ? input.records.history.discover({ ...request, historyLimit: 1000 })
            : {
                current: await input.records.discover(request),
                revisions: [],
                complete: false
              };
        });
        const snapshot = discovery.current;
        check();
        if (!snapshot.complete) {
          await storeState("partial", at);
          return { ...(await status()), active: false };
        }
        const records = snapshot.records.map((record) =>
          canonicalDecisionRecordSchema.parse(record)
        );
        if (
          records.length > 100 ||
          new Set(records.map((record) => record.content.id)).size !== records.length ||
          new Set(
            records.map((record) =>
              JSON.stringify([record.reference.providerId, record.reference.externalId])
            )
          ).size !== records.length
        )
          throw new Error("Decision candidate discovery is ambiguous or unbounded");
        const finalAudience = await cancellable(owned.signal, currentAudience);
        if (JSON.stringify(finalAudience) !== JSON.stringify(audience))
          throw new Error("Decision audience changed");
        check();
        await storeState("ready", at, {
          version: 1,
          workspaceId: input.workspaceId,
          catalogId: input.catalogId,
          audience,
          observedAt: now().toISOString(),
          providerSnapshotId: snapshot.id,
          providerRevision: snapshot.revision,
          entries: records.map(candidate),
          historicalRevisions: discovery.revisions.map(revisionHint),
          historyComplete: discovery.complete
        });
      } catch {
        await storeState("unavailable", at);
      }
      return { ...(await status()), active: false };
    })().finally(() => {
      clearTimeout(deadline);
      owned.abort();
      controller = undefined;
      running = undefined;
    });
    return running;
  };
  const projection = createDecisionContextCatalog({
    id: input.catalogId,
    records: input.records,
    signal: lifetime.signal,
    candidates: {
      async search(request) {
        if (
          stopped ||
          !Number.isSafeInteger(request.limit) ||
          request.limit < 1 ||
          request.limit > 100
        )
          return {
            references: [],
            complete: false,
            warnings: ["Decision candidate discovery is unavailable."]
          };
        const audience = await cancellable(lifetime.signal, currentAudience);
        const requested = decisionAudienceSchema.safeParse(request.audience);
        const { row, manifest } = await read();
        if (
          !manifest ||
          !audience ||
          !requested.success ||
          requested.data.workspaceId !== input.workspaceId ||
          !requested.data.personIds.every(
            (person) =>
              audience.personIds.includes(person) &&
              manifest.audience.personIds.includes(person)
          )
        )
          return {
            references: [],
            complete: false,
            warnings: ["Decision candidate discovery is not ready for these recipients."]
          };
        const wanted = new Set(terms(request.concepts.join(" ")));
        const isHistory =
          request.time?.mode === "history" && Boolean(input.records.history);
        let entries: Array<
          Manifest["entries"][number] | z.infer<typeof revisionHintSchema>
        > = isHistory ? (manifest.historicalRevisions ?? []) : manifest.entries;
        if (isHistory && request.time?.mode === "history" && request.time.asOf) {
          const byPage = new Map<string, z.infer<typeof revisionHintSchema>>();
          for (const entry of manifest.historicalRevisions ?? []) {
            if (
              entry.recordedAt === null ||
              Date.parse(entry.recordedAt) > Date.parse(request.time.asOf)
            )
              continue;
            const key = JSON.stringify([
              entry.reference.providerId,
              entry.reference.externalId
            ]);
            const prior = byPage.get(key);
            if (!prior || entry.ordinal > prior.ordinal) byPage.set(key, entry);
          }
          entries = [...byPage.values()].filter(
            (entry) =>
              !(manifest.historicalRevisions ?? []).some(
                (later) =>
                  later.reference.providerId === entry.reference.providerId &&
                  later.reference.externalId === entry.reference.externalId &&
                  later.ordinal > entry.ordinal &&
                  later.recordedAt === null
              )
          );
        }
        const matches = entries
          .map((entry) => ({
            entry,
            score: entry.terms.reduce(
              (count, term) => count + Number(wanted.has(term)),
              0
            )
          }))
          .filter((entry) => entry.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score ||
              ("recordedAt" in right.entry && "recordedAt" in left.entry
                ? Date.parse(right.entry.recordedAt ?? "1970-01-01T00:00:00Z") -
                    Date.parse(left.entry.recordedAt ?? "1970-01-01T00:00:00Z") ||
                  right.entry.ordinal - left.entry.ordinal
                : Number(right.entry.active) - Number(left.entry.active)) ||
              left.entry.reference.externalId.localeCompare(
                right.entry.reference.externalId
              )
          );
        const warnings = [
          "Decision candidates come from bounded background discovery; current completeness is not guaranteed."
        ];
        if (
          isHistory &&
          manifest.historicalRevisions?.some((entry) => entry.recordedAt === null)
        )
          warnings.push(
            "Some legacy Decision revisions have no recorded revision time; as-of ordering may be unavailable."
          );
        if (isHistory && !manifest.historyComplete)
          warnings.push(
            "Canonical Decision archive discovery is incomplete or has not run; only explicitly discovered revisions are available."
          );
        if (row?.state !== "ready" && !(row?.state === "refreshing" && running))
          warnings.push(
            "The last Decision refresh was incomplete, interrupted or unavailable."
          );
        if (now().getTime() - Date.parse(manifest.observedAt) >= maxAgeMs)
          warnings.push(
            "The Decision candidate index is stale; only fresh verified source reads may be used."
          );
        if (matches.length > Math.min(candidateLimit, request.limit))
          warnings.push("Decision candidates exceeded this request's live-read bound.");
        return {
          references: matches
            .slice(0, Math.min(candidateLimit, request.limit))
            .map(({ entry }) => ({
              reference: structuredClone(entry.reference),
              ...("revisionId" in entry ? { revisionId: entry.revisionId } : {})
            })),
          complete: false,
          warnings
        };
      }
    }
  });
  const catalog: ContextCatalog = Object.freeze({
    id: projection.id,
    search: (request: Parameters<ContextCatalog["search"]>[0]) =>
      stopped
        ? Promise.resolve({
            sourceIds: [],
            complete: false,
            warnings: ["Decision candidate discovery is stopped."]
          })
        : track(() => projection.search(request)),
    read: (request: Parameters<ContextCatalog["read"]>[0]) =>
      stopped ? Promise.resolve(null) : track(() => projection.read(request))
  });
  return {
    catalog,
    status,
    syncOnce,
    start() {
      if (stopped) throw new Error("Decision recall is stopped");
      if (timer) return;
      const tick = () => {
        void syncOnce().catch(() => undefined);
      };
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
      lifetime.abort();
      await Promise.allSettled([running, ...queries]);
    }
  };
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function terms(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu) ?? []
    )
  ]
    .filter((term) => term.length >= 2 && term.length <= 80)
    .slice(0, 256);
}
function candidate(record: CanonicalDecisionRecord): Manifest["entries"][number] {
  const value = record.content.candidate;
  return {
    reference: structuredClone(record.reference),
    active: record.content.status === "active",
    terms: terms(
      [
        "decision decisions Entscheidung Entscheidungen",
        value.scopeId ?? "",
        value.statement.text,
        value.context?.text ?? "",
        ...value.rationale.map((claim) => claim.text),
        ...value.consequences.map((claim) => claim.text)
      ].join(" ")
    )
  };
}
function cancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Decision recall was cancelled"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error("Decision recall was cancelled");
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function revisionHint(
  revision: DecisionRecordHistoricalRevision
): z.infer<typeof revisionHintSchema> {
  const record = canonicalDecisionRecordSchema.parse(revision.record);
  const current = candidate(record);
  return revisionHintSchema.parse({
    ...current,
    terms: current.terms.slice(0, 64),
    revisionId: revision.revisionId,
    ordinal: revision.ordinal,
    recordedAt: revision.recordedAt
  });
}
