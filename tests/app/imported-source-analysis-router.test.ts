import { describe, expect, it, vi } from "vitest";
import { createImportedSourceAnalysisRouter } from "../../src/app/imported-source-analysis-router.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  evidence,
  people,
  workspace
} from "../native-review/native-notion-review-fixtures.js";

for (const nativeEnabled of [false, true]) {
  describe(`source provenance routing with native ${nativeEnabled ? "enabled" : "disabled"}`, () => {
    it.each(["requireCurrent", "requireRetained"] as const)(
      "withholds %s when a native binding appears during generic verification",
      async (method) => {
        const database = await createPgliteDatabase();
        const ledger = createObservedSourceLedger({ database });
        const recorded = await ledger.record({
          workspaceId: workspace.workspaceId,
          ...evidence()
        });
        const source = observedMeetingNoteToObservation(
          { workspace, source: recorded },
          "linear"
        ).source;
        const audience = {
          workspaceId: workspace.workspaceId,
          personIds: people.map((p) => p.personId)
        };
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const genericProof = async () => {
          entered();
          await hold;
        };
        const nativeProof = vi.fn(() => Promise.resolve());
        const router = createImportedSourceAnalysisRouter({
          database,
          workspaceId: workspace.workspaceId,
          audience: () => Promise.resolve(audience),
          generic: {
            audience: () => Promise.resolve(audience),
            access: { requireCurrent: genericProof, requireRetained: genericProof }
          },
          ...(nativeEnabled
            ? {
                native: {
                  sourceHistoryAccess: {
                    requireCurrent: nativeProof,
                    requireRetained: nativeProof
                  }
                }
              }
            : {})
        });
        try {
          const proof = router.configuration!.access[method]({ source, audience });
          const outcome = expect(proof).rejects.toThrow("could not be verified");
          await ready;
          // Even damaged retained instruction material owns its original source; it cannot fall through to broader grants.
          await database.query(
            "INSERT INTO native_review_instructions (workspace_id,instruction_id,payload_json,payload_hash,source_provider_id,source_object_id,source_content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              workspace.workspaceId,
              "retained-native-request",
              "damaged",
              "damaged",
              source.providerId,
              source.sourceObjectId,
              source.contentHash
            ]
          );
          release();
          await outcome;
          expect(nativeProof).not.toHaveBeenCalled();
        } finally {
          release?.();
          await router.stop();
          await database.close();
        }
      }
    );
  });
}
