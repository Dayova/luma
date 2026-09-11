import { createHash } from "node:crypto";
import type {
  EvidenceReference,
  ImportedMeetingSource,
  MeetingImportedFromSource,
  MeetingState
} from "../domain/model.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";

/** Owned read capability: current provider material AND explicit sharing authority. */
export interface ImportedSourceAnalysisAccess {
  requireCurrent(input: {
    source: ImportedMeetingSource;
    audience: ContextAudience;
  }): Promise<void>;
}
/** Historical read permission; it never authorizes execution against obsolete words. */
export interface ImportedSourceHistoryAccess extends ImportedSourceAnalysisAccess {
  requireRetained(input: {
    source: ImportedMeetingSource;
    audience: ContextAudience;
  }): Promise<void>;
}
export type ImportedSourceAnalysisConfiguration = {
  access: ImportedSourceAnalysisAccess;
  /** Actual recipients, never inferred from attendance or the service credential. */
  audience(workspaceId: string): Promise<ContextAudience | null>;
};
export class ImportedSourceUnavailableError extends Error {
  constructor() {
    super("Imported Meeting source access or currentness could not be verified.");
    this.name = "ImportedSourceUnavailableError";
  }
}
type DatabaseQuery = Pick<LumaDatabase, "query">;
const PREFIX = "imported-source-analysis:";
export type ImportedSourceAnalysisReceipt = {
  id: string;
  meetingId: string;
  audience: ContextAudience;
  source: ImportedMeetingSource;
  evidenceIds: string[];
};
export function isImportedSourceAnalysisReceipt(id: string): boolean {
  return id.startsWith(PREFIX);
}

export async function prepareImportedSourceAnalysisReceipt(
  config: ImportedSourceAnalysisConfiguration,
  observation: MeetingImportedFromSource
): Promise<ImportedSourceAnalysisReceipt> {
  const audience = await config.audience(observation.workspaceId);
  if (
    !audience ||
    audience.workspaceId !== observation.workspaceId ||
    !audience.personIds.length
  )
    throw new ImportedSourceUnavailableError();
  const boundAudience = {
    workspaceId: audience.workspaceId,
    personIds: [...new Set(audience.personIds)].sort()
  };
  const source = structuredClone(observation.source);
  await withImportedSourceDeadline(
    config.access.requireCurrent({
      source: structuredClone(source),
      audience: structuredClone(boundAudience)
    })
  );
  const value = {
    meetingId: observation.meetingId,
    audience: boundAudience,
    source,
    evidenceIds: observation.evidence.map((item) => item.evidenceId).sort()
  };
  return {
    id: `${PREFIX}${createHash("sha256").update(canonicalJson(value)).digest("hex")}`,
    ...value
  };
}
export async function retainImportedSourceAnalysisReceipt(
  database: DatabaseQuery,
  receipt: ImportedSourceAnalysisReceipt
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_imported_source_receipts (workspace_id,meeting_id,receipt_id,receipt_json) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [receipt.audience.workspaceId, receipt.meetingId, receipt.id, JSON.stringify(receipt)]
  );
}
export async function readImportedSourceAnalysisReceipt(
  database: DatabaseQuery,
  workspaceId: string,
  meetingId: string,
  id: string
): Promise<ImportedSourceAnalysisReceipt> {
  try {
    const rows = await database.query<{ receipt_json: string }>(
      `SELECT receipt_json FROM meeting_imported_source_receipts WHERE workspace_id=$1 AND meeting_id=$2 AND receipt_id=$3`,
      [workspaceId, meetingId, id]
    );
    if (!rows.rows[0]) throw new ImportedSourceUnavailableError();
    const receipt = JSON.parse(
      rows.rows[0].receipt_json
    ) as ImportedSourceAnalysisReceipt;
    const { id: retainedId, ...value } = receipt;
    if (
      retainedId !== id ||
      receipt.meetingId !== meetingId ||
      receipt.audience.workspaceId !== workspaceId ||
      `${PREFIX}${createHash("sha256").update(canonicalJson(value)).digest("hex")}` !== id
    )
      throw new ImportedSourceUnavailableError();
    return receipt;
  } catch {
    // Missing, corrupted or unreadable proof is an expected availability refusal,
    // never a new audience grant or a raw persistence diagnostic for callers.
    throw new ImportedSourceUnavailableError();
  }
}
export async function requireImportedSourceAnalysisReceiptCurrent(
  database: LumaDatabase,
  config: ImportedSourceAnalysisConfiguration | undefined,
  workspaceId: string,
  meetingId: string,
  id: string
): Promise<void> {
  if (!config) throw new ImportedSourceUnavailableError();
  const receipt = await readImportedSourceAnalysisReceipt(
    database,
    workspaceId,
    meetingId,
    id
  );
  const audience = await config.audience(workspaceId);
  if (
    !audience ||
    audience.workspaceId !== workspaceId ||
    JSON.stringify([...new Set(audience.personIds)].sort()) !==
      JSON.stringify(receipt.audience.personIds)
  )
    throw new ImportedSourceUnavailableError();
  await withImportedSourceDeadline(
    config.access.requireCurrent({
      source: structuredClone(receipt.source),
      audience: structuredClone(receipt.audience)
    })
  );
}
export function sameImportedSourceRevision(
  left: ImportedMeetingSource,
  right: ImportedMeetingSource
): boolean {
  return (
    left.providerId === right.providerId &&
    left.sourceObjectId === right.sourceObjectId &&
    left.sourceRevision === right.sourceRevision &&
    left.contentHash === right.contentHash
  );
}

/** A read projection; immutable source snapshots and Human history are untouched. */
export async function projectImportedSourceMaterial(
  database: LumaDatabase,
  state: MeetingState,
  eligibleIds: Set<string>
): Promise<MeetingState> {
  if (state.importedSourceAnalysisReceiptIds === undefined) return state;
  const ids = state.importedSourceAnalysisReceiptIds.filter((id) => eligibleIds.has(id));
  const receipts = await Promise.all(
    ids.map((id) =>
      readImportedSourceAnalysisReceipt(database, state.workspaceId, state.meetingId, id)
    )
  );
  const allowedSource = (source: ImportedMeetingSource) =>
    receipts.some((receipt) => sameImportedSourceRevision(source, receipt.source));
  const sources = state.importedSources.filter(allowedSource);
  const candidates = state.importedActionItemCandidates.filter((item) =>
    allowedSource(item.source.source)
  );
  const candidateIds = new Set(candidates.map((item) => item.id));
  const reviews = state.actionItemReconciliationReviews.filter((item) =>
    candidateIds.has(item.candidateId)
  );
  const reviewIds = new Set(reviews.map((item) => item.id));
  return {
    ...state,
    title:
      state.lifecycle === "imported"
        ? (sources[0]?.title ?? "Imported Meeting unavailable")
        : state.title,
    importedSourceAnalysisReceiptIds: ids,
    importedSources: sources,
    importedActionItemCandidates: candidates,
    currentImportedActionItemCandidateIds:
      state.currentImportedActionItemCandidateIds.filter((id) => candidateIds.has(id)),
    actionItemReconciliationReviews: reviews,
    actionItemReconciliationHumanResolutions:
      state.actionItemReconciliationHumanResolutions.filter((item) =>
        reviewIds.has(item.reviewId)
      ),
    actionItemOwnershipHumanResolutions: state.actionItemOwnershipHumanResolutions.filter(
      (item) => candidateIds.has(item.candidateId)
    ),
    actionItemReconciliationCreatedWorkMappings:
      state.actionItemReconciliationCreatedWorkMappings.filter((item) =>
        candidateIds.has(item.candidateId)
      )
  };
}
export async function filterImportedSourceEvidence(
  database: LumaDatabase,
  state: MeetingState,
  evidence: EvidenceReference[]
): Promise<EvidenceReference[]> {
  if (state.importedSourceAnalysisReceiptIds === undefined) return evidence;
  const receipts = await Promise.all(
    state.importedSourceAnalysisReceiptIds.map((id) =>
      readImportedSourceAnalysisReceipt(database, state.workspaceId, state.meetingId, id)
    )
  );
  const allowed = new Set(receipts.flatMap((receipt) => receipt.evidenceIds));
  return evidence.filter(
    (item) =>
      !item.evidenceId.startsWith("evidence:meeting-note:") ||
      allowed.has(item.evidenceId)
  );
}

export async function currentImportedSourceReceiptIds(
  database: LumaDatabase,
  state: MeetingState,
  required = false
): Promise<string[]> {
  if (state.importedSourceAnalysisReceiptIds === undefined) {
    if (required && state.importedSources.length)
      throw new ImportedSourceUnavailableError();
    return [];
  }
  const latest = new Map<string, ImportedMeetingSource>();
  for (const source of state.importedSources) {
    const key = JSON.stringify([source.providerId, source.sourceObjectId]);
    if ((latest.get(key)?.sourceRevision ?? 0) < source.sourceRevision)
      latest.set(key, source);
  }
  const receipts = await Promise.all(
    state.importedSourceAnalysisReceiptIds.map((id) =>
      readImportedSourceAnalysisReceipt(database, state.workspaceId, state.meetingId, id)
    )
  );
  return [...latest.values()].map((source) => {
    const receipt = receipts.find((item) =>
      sameImportedSourceRevision(item.source, source)
    );
    if (!receipt) throw new ImportedSourceUnavailableError();
    return receipt.id;
  });
}
async function withImportedSourceDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ImportedSourceUnavailableError()), 15_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
