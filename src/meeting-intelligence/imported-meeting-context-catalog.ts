import { createHash } from "node:crypto";
import type { EvidenceReference, MeetingState, Provenance } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ContextAudience,
  ContextCatalog,
  ContextSource,
  ExternalContextReceiptVerifier,
  OrganizationalContextRequest
} from "../organizational-context/interface.js";
import {
  isImportedSourceAnalysisReceipt,
  readImportedSourceAnalysisReceipt,
  sameImportedSourceRevision,
  type ImportedSourceAnalysisAccess,
  type ImportedSourceAnalysisReceipt
} from "./imported-source-analysis.js";

type Item = {
  id: string;
  kind: string;
  text: string;
  detail: unknown;
  standing: ContextSource["standing"];
  provenance: Provenance;
};
type Leaf = {
  id: string;
  state: MeetingState;
  item: Item;
  receipts: ImportedSourceAnalysisReceipt[];
  externalReceipts: Array<{ id: string; request: OrganizationalContextRequest }>;
};
export const importedMeetingContextCatalogId = "luma-imported-meetings:v1";
const prefix = "imported-meeting-item:";
const limitation =
  "Recall scans at most 20 matching imported Meetings and 100 source-bound items per Meeting. Direct conversations, ungranted history, and claims with unprovable dependencies are excluded.";

/** A persistence-owned leaf projection. It never calls MI.query or another prior-Meeting catalog. */
export function createImportedMeetingContextCatalog(input: {
  database: LumaDatabase;
  sourceAccess: ImportedSourceAnalysisAccess;
  externalContext?: ExternalContextReceiptVerifier;
}): ContextCatalog {
  const { database, sourceAccess } = input;
  const load = async (workspaceId: string, meetingId: string) => {
    const rows = await database.query<{ state_json: string }>(
      "SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
      [workspaceId, meetingId]
    );
    return rows.rows[0] ? (JSON.parse(rows.rows[0].state_json) as MeetingState) : null;
  };
  const leaves = async (
    state: MeetingState,
    audience: ContextAudience
  ): Promise<Leaf[]> => {
    const ids = state.importedSourceAnalysisReceiptIds;
    if (!ids?.length || state.workspaceId !== audience.workspaceId) return [];
    const result: Leaf[] = [];
    const receipts = new Map<string, ImportedSourceAnalysisReceipt>();
    for (const id of ids.slice(-20)) {
      const receipt = await readImportedSourceAnalysisReceipt(
        database,
        state.workspaceId,
        state.meetingId,
        id
      );
      if (
        receipt.audience.workspaceId === audience.workspaceId &&
        audience.personIds.every((person) =>
          receipt.audience.personIds.includes(person)
        ) &&
        state.importedSources.some((source) =>
          sameImportedSourceRevision(source, receipt.source)
        )
      )
        receipts.set(id, receipt);
    }
    const evidenceRows = await database.query<{ reference_json: string }>(
      "SELECT reference_json FROM evidence WHERE workspace_id=$1 AND meeting_id=$2 AND active=TRUE",
      [state.workspaceId, state.meetingId]
    );
    const canonical = new Map(
      evidenceRows.rows.map((row) => {
        const evidence = JSON.parse(row.reference_json) as EvidenceReference;
        return [evidence.evidenceId, evidence];
      })
    );
    for (const item of items(state).slice(0, 100)) {
      const dependencies = [...new Set(item.provenance.contextReceiptIds ?? [])].sort();
      const importedIds = dependencies.filter(isImportedSourceAnalysisReceipt);
      const externalIds = dependencies.filter(
        (id) => !isImportedSourceAnalysisReceipt(id)
      );
      if (
        !importedIds.length ||
        importedIds.some((id) => !receipts.has(id)) ||
        externalIds.length > 20 ||
        (externalIds.length && !input.externalContext)
      )
        continue;
      const externalReceipts: Leaf["externalReceipts"] = [];
      for (const id of externalIds) {
        const saved = await database.query<{ request_json: string }>(
          "SELECT request_json FROM meeting_context_receipts WHERE workspace_id=$1 AND meeting_id=$2 AND receipt_id=$3",
          [state.workspaceId, state.meetingId, id]
        );
        if (!saved.rows[0]) continue;
        const request = JSON.parse(
          saved.rows[0].request_json
        ) as OrganizationalContextRequest;
        if (
          request.audience.workspaceId !== state.workspaceId ||
          request.subject.type !== "meeting" ||
          request.subject.id !== state.meetingId ||
          audience.personIds.some(
            (person) => !request.audience.personIds.includes(person)
          )
        )
          continue;
        externalReceipts.push({ id, request });
      }
      if (externalReceipts.length !== externalIds.length) continue;
      const admitted = importedIds.map((id) => receipts.get(id)!);
      const grantedEvidence = new Set(admitted.flatMap((receipt) => receipt.evidenceIds));
      // A Human overlay may confirm an admitted item. New standalone Human text has
      // no original audience and must acquire its own grant before cross-Meeting use.
      if (
        !item.provenance.evidence.some((evidence) =>
          grantedEvidence.has(evidence.evidenceId)
        ) ||
        item.provenance.evidence.some((evidence) => {
          if (
            externalReceipts.some((receipt) =>
              evidence.evidenceId.startsWith(`organizational-context:${receipt.id}:`)
            )
          )
            return false;
          if (
            canonicalJson(canonical.get(evidence.evidenceId)) !== canonicalJson(evidence)
          )
            return true;
          if (grantedEvidence.has(evidence.evidenceId)) return false;
          return (
            evidence.source !== "human-judgment" ||
            !state.humanJudgmentItemIds.includes(item.id) ||
            item.provenance.analysisVersion !== "human-judgment"
          );
        })
      )
        continue;
      result.push({
        id: encode(state.meetingId, item, dependencies),
        state,
        item,
        receipts: admitted,
        externalReceipts
      });
    }
    return result;
  };
  const prove = async (leaf: Leaf, audience: ContextAudience) => {
    for (const receipt of leaf.receipts)
      await sourceAccess.requireCurrent({
        source: structuredClone(receipt.source),
        audience: structuredClone(audience)
      });
    const externalEvidence = new Map<string, EvidenceReference>();
    for (const receipt of leaf.externalReceipts) {
      if (!input.externalContext) throw unavailable();
      const proof = await input.externalContext.requireCurrent({
        originalRequest: receipt.request,
        receiptId: receipt.id,
        audience
      });
      for (const source of proof.sources) {
        const evidence: EvidenceReference = {
          evidenceId: `organizational-context:${receipt.id}:${source.snapshotId}`,
          source:
            source.kind === "knowledge-document"
              ? "knowledge"
              : source.kind === "work-item"
                ? "work"
                : source.kind === "code-change"
                  ? "code"
                  : "previous-meeting",
          sourceObjectId: source.id,
          sourceVersion: source.version,
          excerpt: source.content,
          externalReference: source.externalReference
        };
        externalEvidence.set(evidence.evidenceId, evidence);
      }
    }
    if (
      leaf.item.provenance.evidence.some(
        (evidence) =>
          evidence.evidenceId.startsWith("organizational-context:") &&
          canonicalJson(externalEvidence.get(evidence.evidenceId)) !==
            canonicalJson(evidence)
      )
    )
      throw unavailable();
    // Human rejection/correction or a new capture during the external proof must
    // invalidate the exact persisted projection before it can leave the catalog.
    const current = await load(audience.workspaceId, leaf.state.meetingId);
    return current?.revision === leaf.state.revision;
  };
  return {
    id: importedMeetingContextCatalogId,
    dependencyKind: "meeting",
    async search({ audience, concepts, limit, subject }) {
      audience = structuredClone(audience);
      concepts = [...concepts];
      subject = subject ? structuredClone(subject) : undefined;
      if (
        !validAudience(audience) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw unavailable();
      const terms = [
        ...new Set(concepts.map((term) => term.trim().toLowerCase()).filter(Boolean))
      ].slice(0, 8);
      if (!terms.length || terms.some((term) => term.length > 80))
        return { sourceIds: [], complete: false, warnings: [limitation] };
      const rows = await database.query<{ state_json: string }>(
        `SELECT state_json FROM meetings WHERE workspace_id=$1
         AND EXISTS (SELECT 1 FROM meeting_imported_source_receipts receipt WHERE receipt.workspace_id=meetings.workspace_id AND receipt.meeting_id=meetings.meeting_id)
         AND EXISTS (SELECT 1 FROM unnest($2::text[]) term WHERE position(term in lower(state_json))>0)
         ORDER BY created_at,meeting_id LIMIT 20`,
        [audience.workspaceId, terms]
      );
      const selected: Leaf[] = [];
      for (const row of rows.rows) {
        const state = JSON.parse(row.state_json) as MeetingState;
        if (excluded(state.meetingId, subject)) continue;
        for (const leaf of await leaves(state, audience)) {
          if (selected.length >= limit) break;
          if (!terms.some((term) => leaf.item.text.toLowerCase().includes(term)))
            continue;
          selected.push(leaf);
        }
      }
      const sourceIds: string[] = [];
      for (const leaf of selected) {
        try {
          if (await prove(leaf, audience)) sourceIds.push(leaf.id);
        } catch {
          /* Never disclose an unverifiable discovery. */
        }
      }
      return { sourceIds, complete: false, warnings: [limitation] };
    },
    async read({ audience, sourceId, subject }) {
      audience = structuredClone(audience);
      subject = subject ? structuredClone(subject) : undefined;
      if (!validAudience(audience)) return null;
      const identity = decode(sourceId);
      if (!identity || excluded(identity.meetingId, subject)) return null;
      const state = await load(audience.workspaceId, identity.meetingId);
      if (!state) return null;
      const leaf = (await leaves(state, audience)).find((item) => item.id === sourceId);
      if (!leaf) return null;
      const evidence = leaf.item.provenance.evidence.filter((entry) =>
        leaf.receipts.some((receipt) => receipt.evidenceIds.includes(entry.evidenceId))
      );
      const supportingReceipts = leaf.receipts.filter((receipt) =>
        evidence.some((entry) => receipt.evidenceIds.includes(entry.evidenceId))
      );
      const human =
        state.humanJudgmentItemIds.includes(leaf.item.id) &&
        leaf.item.provenance.analysisVersion === "human-judgment";
      // Source time, never retrieval/replay time. A regenerated inference does not
      // make old speech newer or independently corroborated.
      const judgmentRevision = human
        ? await database.query<{ created_at: string }>(
            "SELECT created_at FROM meeting_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3",
            [state.workspaceId, state.meetingId, leaf.item.provenance.producedAtRevision]
          )
        : null;
      if (human && !judgmentRevision?.rows[0]) return null;
      try {
        if (!(await prove(leaf, audience))) return null;
      } catch {
        throw unavailable();
      }
      const updatedAt =
        judgmentRevision?.rows[0]?.created_at ??
        supportingReceipts
          .map((receipt) => receipt.source.capturedAt)
          .sort()
          .at(-1)!;
      const content = JSON.stringify({
        kind: leaf.item.kind,
        statement: leaf.item.text,
        detail: leaf.item.detail,
        confidence: leaf.item.provenance.confidence,
        evidence: leaf.item.provenance.evidence.filter(
          (entry) => entry.source !== "human-judgment"
        ),
        interpretation:
          "Persisted Meeting understanding, not a canonical Decision Record or executed work. Original wording and qualification remain in the evidence. Human confirmation is an explicit overlay; source speaker names alone do not confirm ownership."
      });
      if (content.length > 100_000) throw unavailable();
      return {
        id: sourceId,
        kind: "previous-meeting-item",
        title: `Meeting ${leaf.item.kind}: ${leaf.item.text.slice(0, 160)}`,
        content,
        version: digest(
          canonicalJson({
            content,
            standing: leaf.item.standing,
            human,
            dependencies: leaf.receipts.map((receipt) => receipt.id)
          })
        ),
        updatedAt,
        equivalenceKey: `imported-meeting-content:${digest(canonicalJson({ kind: leaf.item.kind, statement: leaf.item.text, detail: leaf.item.detail, confidence: leaf.item.provenance.confidence, originalEvidence: leaf.item.provenance.evidence.filter((entry) => entry.source !== "human-judgment").map((entry) => ({ source: entry.source, excerpt: entry.excerpt })) }))}`,
        externalReference: { ...supportingReceipts[0]!.source.externalReference },
        standing: leaf.item.standing,
        authority: human ? "human-confirmed" : "ai-inference"
      } satisfies ContextSource;
    }
  };
}

function items(state: MeetingState): Item[] {
  return [
    ...state.decisions
      .filter((item) => item.status !== "rejected")
      .map((item) => ({
        id: item.id,
        kind: "decision",
        text: item.statement,
        detail: { status: item.status, rationale: item.rationale },
        standing:
          item.status === "superseded" || item.supersededByDecisionId
            ? ("superseded" as const)
            : item.objectingParticipantIds.length
              ? ("disputed" as const)
              : item.status === "candidate"
                ? ("proposed" as const)
                : ("current" as const),
        provenance: item.provenance
      })),
    ...state.actionItems
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        id: item.id,
        kind: "action-item",
        text: item.description,
        detail: {
          status: item.status,
          ownership: item.ownership ?? { status: "unresolved" },
          dueDate: item.dueDate,
          dueDateConfidence: item.dueDateConfidence
        },
        standing:
          item.status === "completed"
            ? ("historical" as const)
            : item.status === "candidate"
              ? ("proposed" as const)
              : ("current" as const),
        provenance: item.provenance
      })),
    ...state.openQuestions
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        id: item.id,
        kind: "open-question",
        text: item.question,
        detail: { status: item.status, possibleAnswers: item.possibleAnswers },
        standing:
          item.status === "answered" ? ("historical" as const) : ("current" as const),
        provenance: item.provenance
      })),
    ...state.risks.map((item) => ({
      id: item.id,
      kind: "risk",
      text: item.statement,
      detail: { severity: item.severity, mitigation: item.mitigation },
      standing: "current" as const,
      provenance: item.provenance
    }))
  ];
}
function excluded(
  meetingId: string,
  subject: OrganizationalContextRequest["subject"] | undefined
) {
  return subject?.type === "meeting" && subject.id === meetingId;
}
function validAudience(audience: ContextAudience) {
  return (
    !!audience.workspaceId.trim() &&
    audience.personIds.length > 0 &&
    audience.personIds.every((person) => !!person.trim()) &&
    new Set(audience.personIds).size === audience.personIds.length
  );
}
function encode(meetingId: string, item: Item, dependencies: string[]) {
  return `${prefix}${Buffer.from(JSON.stringify({ meetingId, kind: item.kind, itemId: item.id, grant: digest(JSON.stringify(dependencies)) })).toString("base64url")}`;
}
function decode(id: string): { meetingId: string } | null {
  if (
    !id.startsWith(prefix) ||
    id.length > 4000 ||
    !/^[\w-]+$/u.test(id.slice(prefix.length))
  )
    return null;
  try {
    const value = JSON.parse(
      Buffer.from(id.slice(prefix.length), "base64url").toString("utf8")
    ) as Record<string, unknown>;
    return typeof value["meetingId"] === "string"
      ? { meetingId: value["meetingId"] }
      : null;
  } catch {
    return null;
  }
}
function unavailable() {
  return new Error("Imported Meeting recall is unavailable.");
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
