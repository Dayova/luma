import { createHash } from "node:crypto";
import { z } from "zod";
import type { ImportedMeetingSource } from "../domain/model.js";
import {
  ImportedSourceUnavailableError,
  type ImportedSourceHistoryAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import type {
  NativeReviewAccess,
  NativeReviewInstruction
} from "../native-review/native-review-access.js";
import type { MeetingNoteEvidenceSource } from "../native-review/source-bound-native-review.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import { createGrantedImportedSourceAnalysisAccess } from "./granted-imported-source-analysis-access.js";
import type { ObservedSourceLedger } from "./observed-source-ledger.js";
import { observedMeetingNoteToObservation } from "./meeting-notes-ingestion.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";

const personId = z.enum(dayovaFounderPersonIds);
const instructionSchema = z
  .object({
    agentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    eventId: z.string().uuid(),
    sequence: z.number().int().positive(),
    createdAt: z.string().datetime(),
    originalText: z.string().min(1).max(2048),
    actor: z
      .object({
        identityProviderId: z.literal("notion"),
        providerUserId: z.string().uuid(),
        personId
      })
      .strict(),
    page: z
      .object({ providerId: z.literal("notion"), pageId: z.string().uuid() })
      .strict(),
    audience: z
      .object({ workspaceId: z.string(), personIds: z.array(personId).length(4) })
      .strict(),
    recipients: z
      .array(z.object({ personId, providerUserId: z.string().uuid() }).strict())
      .length(4)
  })
  .strict();
const payloadSchema = z
  .object({
    instruction: instructionSchema,
    source: z
      .object({
        source: z
          .object({
            providerId: z.literal("notion"),
            sourceKind: z.literal("meeting-note"),
            sourceObjectId: z.string().min(1),
            parentObjectId: z.string().uuid(),
            url: z.string().url()
          })
          .strict(),
        providerVersion: z.string().nullable(),
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
      })
      .strict()
  })
  .strict();

/** Historical ownership is independent of current feature/page configuration. A disabled native capability must deny, never re-grant through a generic reader. */
export async function hasNativeReviewSourceBinding(input: {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  source: ImportedMeetingSource;
}): Promise<boolean> {
  return (
    (
      await input.database.query(
        "SELECT 1 FROM native_review_instructions WHERE workspace_id=$1 AND source_provider_id=$2 AND source_object_id=$3 AND source_content_hash=$4 LIMIT 1",
        [
          input.workspaceId,
          input.source.providerId,
          input.source.sourceObjectId,
          input.source.contentHash
        ]
      )
    ).rows.length > 0
  );
}

export function createNativeReviewSourceAccess(input: {
  database: LumaDatabase;
  workspaceId: string;
  pageId: string;
  ledger: ObservedSourceLedger;
  access: NativeReviewAccess;
  evidenceSource: MeetingNoteEvidenceSource;
  authorizeSources(request: {
    audience: ContextAudience;
    pageId: string;
  }): Promise<boolean>;
}) {
  let stopped = false;
  const active = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new ImportedSourceUnavailableError());
    const run = operation();
    active.add(run);
    void run.finally(() => active.delete(run)).catch(() => undefined);
    return run;
  };
  const rows = (source: ImportedMeetingSource) =>
    input.database.query<{ payload_json: string; payload_hash: string }>(
      "SELECT payload_json,payload_hash FROM native_review_instructions WHERE workspace_id=$1 AND source_provider_id=$2 AND source_object_id=$3 AND source_content_hash=$4 ORDER BY instruction_id LIMIT 21",
      [input.workspaceId, source.providerId, source.sourceObjectId, source.contentHash]
    );
  const ownsSource = (source: ImportedMeetingSource): Promise<boolean> =>
    track(async () => {
      // A corrupt or revoked recorded binding remains owned and must deny here, never fall back to broader grants.
      return hasNativeReviewSourceBinding({
        database: input.database,
        workspaceId: input.workspaceId,
        source
      });
    });
  const authorize = async (request: {
    source: ImportedMeetingSource;
    audience: ContextAudience;
  }): Promise<boolean> => {
    try {
      if (
        request.audience.workspaceId !== input.workspaceId ||
        request.source.parentObjectId !== input.pageId ||
        !request.audience.personIds.length
      )
        return false;
      const original = await input.ledger.get({
        workspaceId: input.workspaceId,
        source: {
          providerId: request.source.providerId,
          sourceKind: "meeting-note",
          sourceObjectId: request.source.sourceObjectId
        },
        revision: request.source.sourceRevision
      });
      if (!original || original.contentHash !== request.source.contentHash) return false;
      const expected = observedMeetingNoteToObservation(
        {
          workspace: { workspaceId: input.workspaceId, timezone: "UTC" },
          source: { ...original, change: "unchanged" }
        },
        "linear"
      ).source;
      if (canonical(expected) !== canonical(request.source)) return false;
      const found = (await rows(request.source)).rows;
      if (!found.length || found.length > 20) return false;
      for (const row of found) {
        if (
          row.payload_hash !==
          createHash("sha256").update(JSON.stringify(row.payload_json)).digest("hex")
        )
          return false;
        const parsed = payloadSchema.parse(JSON.parse(row.payload_json) as unknown);
        if (
          parsed.source.contentHash !== request.source.contentHash ||
          canonical(parsed.source.source) !== canonical(original.source) ||
          parsed.instruction.audience.workspaceId !== input.workspaceId ||
          request.audience.personIds.some(
            (id) => !(parsed.instruction.audience.personIds as string[]).includes(id)
          )
        )
          return false;
        // Every retained authorizing event must still be valid. Never replace a revoked original with a later grant.
        await input.access.requireCurrent(
          parsed.instruction satisfies NativeReviewInstruction
        );
        if (
          !(await input.authorizeSources({
            audience: parsed.instruction.audience,
            pageId: input.pageId
          }))
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const granted = createGrantedImportedSourceAnalysisAccess({
    ledger: input.ledger,
    authorize,
    evidenceSource: (source) =>
      source.providerId === "notion" && source.parentObjectId === input.pageId
        ? input.evidenceSource
        : null
  });
  const sourceHistoryAccess: ImportedSourceHistoryAccess = {
    requireCurrent: (request) => track(() => granted.requireCurrent(request)),
    requireRetained: (request) => track(() => granted.requireRetained(request))
  };
  return {
    ownsSource,
    sourceHistoryAccess,
    async stop() {
      stopped = true;
      while (active.size) await Promise.allSettled([...active]);
    }
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
