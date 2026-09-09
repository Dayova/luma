import { describe, expect, it } from "vitest";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { MeetingObservation } from "../../src/domain/model.js";

describe("Meeting analysis availability", () => {
  it.each([
    { code: "budget-exhausted", retryable: false },
    { code: "provider-quota", retryable: false },
    { code: "rate-limited", retryable: true },
    { code: "timeout", retryable: true },
    { code: "not-configured", retryable: false },
    { code: "request-indeterminate", retryable: false }
  ] as const)(
    "preserves accepted Evidence and exposes $code without replaying analysis",
    async ({ code, retryable }) => {
      const database = await createPgliteDatabase();
      let modelCalls = 0;
      const resetAt = "2026-09-30T22:00:00.000Z";
      const intelligence = createMeetingIntelligence({
        database,
        reasoningModel: {
          generateStructured: () => {
            modelCalls += 1;
            return Promise.reject(
              new AiServiceError(code, "private provider diagnostic", {
                resetAt,
                retryAfterSeconds: 20
              })
            );
          }
        }
      });
      const observation: MeetingObservation = {
        type: "utterance-committed",
        observationId: "obs_budget_note",
        workspaceId: "workspace_luma",
        meetingId: "meeting_budget",
        occurredAt: "2026-09-08T19:00:00.000Z",
        observedAt: "2026-09-08T19:00:00.000Z",
        utteranceId: "utterance_budget",
        version: 1,
        speaker: {
          status: "attributed",
          personId: "person_jakob",
          confidence: "deterministic",
          basis: "provider-identity"
        },
        startedAt: "2026-09-08T19:00:00.000Z",
        endedAt: "2026-09-08T19:00:01.000Z",
        originalText: "Wir könnten das nächste Woche prüfen.",
        language: "de"
      };
      const request = {
        workspace: { workspaceId: "workspace_luma", timezone: "Europe/Berlin" },
        observations: [observation]
      };

      try {
        const update = await intelligence.observe(request);
        expect(update.acceptedObservationIds).toEqual([observation.observationId]);
        expect(update.analysisStatus).toBe("deferred");
        expect(update.errors).toEqual([
          { code: `analysis-${code}`, retryable, resetAt, retryAfterSeconds: 20 }
        ]);
        expect(JSON.stringify(update)).not.toContain("private provider diagnostic");

        const replay = await intelligence.observe(request);
        expect(replay.duplicateObservationIds).toEqual([observation.observationId]);
        expect(modelCalls).toBe(1);
        const persisted = await database.query<{ excerpt: string }>(
          "SELECT excerpt FROM evidence WHERE workspace_id = $1 AND meeting_id = $2",
          ["workspace_luma", "meeting_budget"]
        );
        expect(persisted.rows.map((row) => row.excerpt)).toContain(
          observation.originalText
        );
        const snapshot = await intelligence.query({
          workspaceId: "workspace_luma",
          meetingId: "meeting_budget",
          query: { type: "snapshot" }
        });
        expect(snapshot.type).toBe("snapshot");
      } finally {
        await database.close();
      }
    }
  );
});
