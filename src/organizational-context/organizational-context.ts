import { createHash, randomUUID } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ContextCatalog,
  ContextSource,
  OrganizationalContext,
  OrganizationalContextRequest,
  RetrievedContextSource
} from "./interface.js";

type Proof = { catalogId: string; sourceId: string; snapshotId: string };
type SearchProof = {
  catalogId: string;
  limit: number;
  sourceIds: string[];
  complete: boolean;
  failed: boolean;
};
type ReadOutcome = {
  catalogId: string;
  sourceId: string;
  status: "ineligible" | "unavailable";
};
type ReceiptProof = {
  catalogIds: string[];
  unavailableReads: ReadOutcome[];
  sources: Proof[];
  searches: SearchProof[];
  validUntil: string | null;
};
type Candidate = {
  source: ContextSource;
  catalogId: string;
  snapshotId: string;
  head: Proof;
};
const MAX_CANDIDATES = 100;
const MAX_SOURCE_CHARACTERS = 100_000;

export class OrganizationalContextUnavailableError extends Error {
  constructor() {
    super(
      "Organizational context changed or is no longer authorized; retrieve it again."
    );
    this.name = "OrganizationalContextUnavailableError";
  }
}

export function createOrganizationalContext(input: {
  database: LumaDatabase;
  catalogs: readonly ContextCatalog[];
  now?: () => Date;
  timeoutMs?: number;
}): OrganizationalContext {
  const catalogs = new Map(input.catalogs.map((catalog) => [catalog.id, catalog]));
  if (
    catalogs.size !== input.catalogs.length ||
    [...catalogs.keys()].some((id) => !id.trim())
  ) {
    throw new Error("Organizational context requires unique catalog identities");
  }
  const now = input.now ?? (() => new Date());
  const read = async (
    catalog: ContextCatalog,
    request: OrganizationalContextRequest,
    sourceId: string,
    deadlineAt = Number.POSITIVE_INFINITY
  ) => {
    if (Date.now() >= deadlineAt) throw new OrganizationalContextUnavailableError();
    const source = await deadline(
      catalog.read({ audience: request.audience, sourceId }),
      Math.min(input.timeoutMs ?? 5_000, deadlineAt - Date.now())
    );
    if (source) validateSource(source, sourceId);
    return source;
  };
  return {
    async retrieve(request) {
      validateRequest(request);
      const warnings: string[] = [];
      const candidates: Candidate[] = [];
      const searches: SearchProof[] = [];
      const unavailableReads: ReadOutcome[] = [];
      if (!catalogs.size)
        warnings.push("No organizational context sources are configured.");
      let remaining = MAX_CANDIDATES;
      let remainingHistory = MAX_CANDIDATES;
      const readDeadline = Date.now() + 15_000;
      for (const catalog of catalogs.values()) {
        if (remaining <= 0 || Date.now() >= readDeadline) {
          warnings.push("The source scan reached its configured bound.");
          break;
        }
        const searchLimit = remaining;
        try {
          const search = await deadline(
            catalog.search({
              audience: request.audience,
              concepts: request.concepts,
              limit: remaining
            }),
            input.timeoutMs ?? 5_000
          );
          if (!search.complete)
            warnings.push(`Catalog ${catalog.id} returned partial coverage.`);
          // Provider diagnostics can contain private source text or secrets.
          if (search.warnings.length)
            warnings.push(`Catalog ${catalog.id} reported a coverage limitation.`);
          searches.push({
            catalogId: catalog.id,
            limit: remaining,
            sourceIds: [...new Set(search.sourceIds)].sort(),
            complete: search.complete,
            failed: false
          });
          const retained = await input.database.query<{ source_id: string }>(
            `SELECT DISTINCT source_id FROM organizational_context_snapshots
             WHERE workspace_id=$1 AND catalog_id=$2
               AND EXISTS (SELECT 1 FROM unnest($3::text[]) token WHERE position(token in lower(source_json)) > 0)
             ORDER BY source_id LIMIT $4`,
            [
              request.audience.workspaceId,
              catalog.id,
              searchTokens(request.concepts),
              MAX_CANDIDATES + 1
            ]
          );
          const ids = [
            ...new Set([
              ...search.sourceIds,
              ...retained.rows.map((row) => row.source_id)
            ])
          ];
          if (ids.length > remaining)
            warnings.push(`Catalog ${catalog.id} exceeded the source scan bound.`);
          const boundedIds = ids.slice(0, remaining);
          remaining -= boundedIds.length;
          for (const sourceId of boundedIds) {
            if (Date.now() >= readDeadline) {
              warnings.push("The context read deadline was reached.");
              break;
            }
            try {
              const source = await read(catalog, request, sourceId, readDeadline);
              if (!source) {
                unavailableReads.push({
                  catalogId: catalog.id,
                  sourceId,
                  status: "ineligible"
                });
                warnings.push(
                  "A discovered source was unavailable or outside the requested audience."
                );
                continue;
              }
              const snapshotId = digest(source);
              const head = { catalogId: catalog.id, sourceId, snapshotId };
              await input.database.query(
                `INSERT INTO organizational_context_snapshots
                 (workspace_id, catalog_id, source_id, snapshot_id, source_json, observed_at)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                [
                  request.audience.workspaceId,
                  catalog.id,
                  source.id,
                  snapshotId,
                  JSON.stringify(source),
                  now().toISOString()
                ]
              );
              const audience = [...new Set(request.audience.personIds)].sort();
              await input.database.query(
                `INSERT INTO organizational_context_snapshot_grants
                 (workspace_id,catalog_id,source_id,snapshot_id,audience_hash,audience_json,observed_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
                [
                  request.audience.workspaceId,
                  catalog.id,
                  source.id,
                  snapshotId,
                  digest(audience),
                  JSON.stringify(audience),
                  now().toISOString()
                ]
              );
              candidates.push({ source, catalogId: catalog.id, snapshotId, head });
              if (request.time.mode === "history") {
                const history = await input.database.query<{
                  source_json: string;
                  snapshot_id: string;
                }>(
                  `SELECT s.source_json, s.snapshot_id FROM organizational_context_snapshots s
                   WHERE s.workspace_id=$1 AND s.catalog_id=$2 AND s.source_id=$3 AND s.snapshot_id<>$4
                   AND EXISTS (SELECT 1 FROM organizational_context_snapshot_grants g
                     WHERE g.workspace_id=s.workspace_id AND g.catalog_id=s.catalog_id
                       AND g.source_id=s.source_id AND g.snapshot_id=s.snapshot_id
                       AND g.audience_json::jsonb @> $6::jsonb)
                   ORDER BY s.observed_at DESC, s.snapshot_id LIMIT $5`,
                  [
                    request.audience.workspaceId,
                    catalog.id,
                    source.id,
                    snapshotId,
                    remainingHistory + 1,
                    JSON.stringify(audience)
                  ]
                );
                if (history.rows.length > remainingHistory)
                  warnings.push("Retained history exceeded the retrieval bound.");
                const historicalRows = history.rows.slice(0, remainingHistory);
                remainingHistory -= historicalRows.length;
                for (const row of historicalRows) {
                  const historical = JSON.parse(row.source_json) as ContextSource;
                  candidates.push({
                    source: { ...historical, standing: "historical" },
                    catalogId: catalog.id,
                    snapshotId: row.snapshot_id,
                    head
                  });
                }
              }
            } catch {
              unavailableReads.push({
                catalogId: catalog.id,
                sourceId,
                status: "unavailable"
              });
              warnings.push(`A source in catalog ${catalog.id} could not be verified.`);
            }
          }
        } catch {
          if (!searches.some((search) => search.catalogId === catalog.id))
            searches.push({
              catalogId: catalog.id,
              limit: searchLimit,
              sourceIds: [],
              complete: false,
              failed: true
            });
          warnings.push(
            `Catalog ${catalog.id} is unavailable; no cached source was substituted.`
          );
        }
      }
      const superseded = new Set(
        candidates.flatMap(({ source, catalogId }) =>
          source.standing === "current" &&
          source.authority === "human-confirmed" &&
          (!source.effectiveAt || Date.parse(source.effectiveAt) <= now().getTime())
            ? (source.supersedes ?? []).map((id) => `${catalogId}\0${id}`)
            : []
        )
      );
      const eligible = candidates
        .filter(({ source, catalogId }) => {
          if (request.time.mode === "history") {
            return (
              !request.time.asOf ||
              Date.parse(source.effectiveAt ?? source.updatedAt) <=
                Date.parse(request.time.asOf)
            );
          }
          return (
            source.standing !== "historical" &&
            source.standing !== "superseded" &&
            !superseded.has(`${catalogId}\0${source.id}`) &&
            (!source.effectiveAt || Date.parse(source.effectiveAt) <= now().getTime())
          );
        })
        .map((candidate) => ({
          candidate,
          relevance: relevance(candidate.source, request.concepts)
        }))
        .filter(({ relevance }) => relevance > 0)
        .sort(
          (a, b) =>
            rank(b.candidate.source) - rank(a.candidate.source) ||
            b.relevance - a.relevance ||
            b.candidate.source.updatedAt.localeCompare(a.candidate.source.updatedAt) ||
            a.candidate.snapshotId.localeCompare(b.candidate.snapshotId)
        );
      const decisions = new Map<string, Set<string>>();
      for (const {
        candidate: { source }
      } of eligible) {
        if (source.decisionKey && ["current", "disputed"].includes(source.standing)) {
          const statements = decisions.get(source.decisionKey) ?? new Set<string>();
          statements.add(normalizedContent(source.content));
          decisions.set(source.decisionKey, statements);
        }
      }
      if ([...decisions.values()].some((statements) => statements.size > 1)) {
        warnings.push(
          "Conflicting statements exist for an explicit decision lineage; Human Judgment is required."
        );
      }
      const sources: RetrievedContextSource[] = [];
      const proofs: Proof[] = candidates.map((candidate) => candidate.head);
      const deduplicated = new Map<string, RetrievedContextSource>();
      let characters = 0;
      for (const { candidate } of eligible) {
        const { source } = candidate;
        const duplicateKey = digest([
          normalizedContent(source.content),
          source.standing,
          source.authority
        ]);
        const duplicate = deduplicated.get(duplicateKey);
        if (duplicate) {
          duplicate.duplicates.push({
            catalogId: candidate.catalogId,
            sourceId: source.id,
            externalReference: source.externalReference
          });
          proofs.push(candidate.head);
          continue;
        }
        if (sources.length >= request.limit || characters >= request.maxCharacters) {
          warnings.push("Relevant context was omitted to fit the retrieval budget.");
          continue;
        }
        const content = source.content.slice(0, request.maxCharacters - characters);
        const excerptTruncated = content.length < source.content.length;
        if (excerptTruncated)
          warnings.push("A source excerpt was truncated to fit the retrieval budget.");
        const selected: RetrievedContextSource = {
          ...source,
          content,
          catalogId: candidate.catalogId,
          snapshotId: candidate.snapshotId,
          excerptTruncated,
          duplicates: []
        };
        sources.push(selected);
        deduplicated.set(duplicateKey, selected);
        proofs.push(candidate.head);
        characters += content.length;
      }
      const bundle = {
        receiptId: randomUUID(),
        sources,
        retrieval: {
          complete: warnings.length === 0,
          warnings: [...new Set(warnings)],
          considered: candidates.length,
          selected: sources.length,
          characters
        }
      };
      await input.database.query(
        `INSERT INTO organizational_context_receipts (receipt_id,workspace_id,request_hash,proof_json,bundle_json,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          bundle.receiptId,
          request.audience.workspaceId,
          requestDigest(request),
          JSON.stringify({
            catalogIds: [...catalogs.keys()].sort(),
            unavailableReads,
            sources: uniqueProofs(proofs),
            searches,
            validUntil:
              candidates
                .map(({ source }) => source.effectiveAt)
                .filter(
                  (date): date is string => !!date && Date.parse(date) > now().getTime()
                )
                .sort()[0] ?? null
          } satisfies ReceiptProof),
          JSON.stringify(bundle),
          now().toISOString()
        ]
      );
      return bundle;
    },
    async requireCurrent(request, receiptId) {
      validateRequest(request);
      const readDeadline = Date.now() + 15_000;
      const result = await input.database.query<{
        request_hash: string;
        proof_json: string;
      }>(
        "SELECT request_hash, proof_json FROM organizational_context_receipts WHERE receipt_id=$1 AND workspace_id=$2",
        [receiptId, request.audience.workspaceId]
      );
      const row = result.rows[0];
      if (!row || row.request_hash !== requestDigest(request))
        throw new OrganizationalContextUnavailableError();
      const receipt = JSON.parse(row.proof_json) as ReceiptProof;
      if (digest(receipt.catalogIds) !== digest([...catalogs.keys()].sort()))
        throw new OrganizationalContextUnavailableError();
      if (receipt.validUntil && now().getTime() >= Date.parse(receipt.validUntil))
        throw new OrganizationalContextUnavailableError();
      for (const search of receipt.searches) {
        if (Date.now() >= readDeadline) throw new OrganizationalContextUnavailableError();
        const catalog = catalogs.get(search.catalogId);
        if (!catalog) throw new OrganizationalContextUnavailableError();
        let current: Awaited<ReturnType<ContextCatalog["search"]>>;
        try {
          current = await deadline(
            catalog.search({
              audience: request.audience,
              concepts: request.concepts,
              limit: search.limit
            }),
            Math.min(input.timeoutMs ?? 5_000, readDeadline - Date.now())
          );
        } catch {
          if (search.failed) continue;
          throw new OrganizationalContextUnavailableError();
        }
        if (
          search.failed ||
          current.complete !== search.complete ||
          digest([...new Set(current.sourceIds)].sort()) !== digest(search.sourceIds)
        )
          throw new OrganizationalContextUnavailableError();
      }
      for (const outcome of receipt.unavailableReads) {
        if (Date.now() >= readDeadline) throw new OrganizationalContextUnavailableError();
        const catalog = catalogs.get(outcome.catalogId);
        if (!catalog) throw new OrganizationalContextUnavailableError();
        let current: ContextSource | null;
        try {
          current = await read(catalog, request, outcome.sourceId, readDeadline);
        } catch {
          if (outcome.status === "unavailable") continue;
          throw new OrganizationalContextUnavailableError();
        }
        if (current || outcome.status !== "ineligible")
          throw new OrganizationalContextUnavailableError();
      }
      for (const proof of receipt.sources) {
        const catalog = catalogs.get(proof.catalogId);
        if (!catalog) throw new OrganizationalContextUnavailableError();
        try {
          const current = await read(catalog, request, proof.sourceId, readDeadline);
          if (!current || digest(current) !== proof.snapshotId)
            throw new OrganizationalContextUnavailableError();
        } catch {
          throw new OrganizationalContextUnavailableError();
        }
      }
    }
  };
}
function rank(source: ContextSource): number {
  return (
    { current: 4, disputed: 3, proposed: 2, historical: 1, superseded: 0 }[
      source.standing
    ] *
      10 +
    { "human-confirmed": 3, source: 2, "ai-inference": 1 }[source.authority]
  );
}
function relevance(source: ContextSource, concepts: string[]): number {
  const text = normalizedContent(`${source.title} ${source.content}`);
  return searchTokens(concepts).reduce(
    (score, token) => score + (text.includes(token) ? 1 : 0),
    0
  );
}
function searchTokens(concepts: string[]): string[] {
  return [
    ...new Set(
      concepts.flatMap(
        (concept) => normalizedContent(concept).match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
      )
    )
  ];
}
function normalizedContent(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function requestDigest(request: OrganizationalContextRequest): string {
  return digest({
    ...request,
    audience: {
      ...request.audience,
      personIds: [...new Set(request.audience.personIds)].sort()
    }
  });
}
function uniqueProofs(proofs: Proof[]): Proof[] {
  return [...new Map(proofs.map((proof) => [digest(proof), proof])).values()];
}
function validateRequest(request: OrganizationalContextRequest): void {
  if (
    !request.audience.workspaceId.trim() ||
    !request.audience.personIds.length ||
    request.audience.personIds.some((id) => !id.trim()) ||
    !request.subject.id.trim() ||
    !request.concepts.length ||
    request.concepts.length > 20 ||
    request.concepts.some((value) => !value.trim() || value.length > 2_000) ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 50 ||
    !Number.isSafeInteger(request.maxCharacters) ||
    request.maxCharacters < 1 ||
    request.maxCharacters > 64_000 ||
    (request.time.mode === "history" &&
      request.time.asOf !== undefined &&
      !validTime(request.time.asOf))
  ) {
    throw new Error("Invalid bounded organizational context request");
  }
}
function validateSource(source: ContextSource, id: string): void {
  if (
    source.id !== id ||
    !source.version.trim() ||
    !source.title.trim() ||
    !source.content.trim() ||
    source.content.length > MAX_SOURCE_CHARACTERS ||
    !validTime(source.updatedAt) ||
    (source.effectiveAt !== undefined && !validTime(source.effectiveAt)) ||
    !["current", "proposed", "disputed", "superseded", "historical"].includes(
      source.standing
    ) ||
    !["human-confirmed", "source", "ai-inference"].includes(source.authority) ||
    !["https:", "http:"].includes(new URL(source.externalReference.url).protocol)
  ) {
    throw new Error("Invalid organizational context source");
  }
}
function validTime(value: string): boolean {
  return /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
async function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Context read timed out")),
          milliseconds
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}
