import { z } from "zod";
import type { AutomaticDecisionIntelligence } from "../decision-intelligence/automatic-decisions.js";
import { decisionDigest } from "../decision-intelligence/persistence.js";
import { decisionSubjectSchema } from "../domain/decision-record-schemas.js";
import type { DecisionSubject } from "../domain/decision-records.js";
import type { AutomaticDecisionBatch } from "../domain/automatic-decisions.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { ProcessedConversationSourceEvent } from "../context-intelligence/processed-conversation-source.js";
import type { ProcessedMeetingSourceEvent } from "../knowledge/meeting-notes-ingestion.js";

const jobSchema = z
  .object({
    subject: decisionSubjectSchema,
    eventId: z.string().min(1).max(512),
    sourceRevision: z.number().int().positive(),
    contentHash: z.string().min(1).max(512)
  })
  .strict();
type Job = z.infer<typeof jobSchema>;
type Phase = "queued" | "processing" | "completed" | "unavailable" | "interrupted";
export type AutomaticDecisionProcessingStatus = {
  active: boolean;
  queued: number;
  processing: number;
  completed: number;
  unavailable: number;
  interrupted: number;
};

/** Accepted source notifications are durable before returning to ingestion/Ask.
 * Analysis runs independently and shares MI's budget and idempotent batch ledger.
 * An interrupted attempt is visible and is never silently charged again.
 */
export async function createAutomaticDecisionProcessing(input: {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  meetingIntelligence: AutomaticDecisionIntelligence;
}) {
  const workspace = structuredClone(input.workspace),
    database = input.database;
  await database.exec(`CREATE TABLE IF NOT EXISTS automatic_decision_jobs (
    workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, subject_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','processing','completed','unavailable','interrupted')),
    batch_id TEXT, created_at BIGINT GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY(workspace_id,job_id)
  ); CREATE INDEX IF NOT EXISTS automatic_decision_jobs_queue
    ON automatic_decision_jobs(workspace_id,phase,created_at);`);
  await database.query(
    "UPDATE automatic_decision_jobs SET phase='interrupted' WHERE workspace_id=$1 AND phase='processing'",
    [workspace.workspaceId]
  );
  let active = false,
    closed = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const schedule = () => {
    if (!active || closed) return;
    wakePending = true;
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      wakePending = false;
      void drain();
    }, 0);
    timer.unref();
  };
  const drain = (): Promise<void> => {
    if (running) return running;
    if (!active || closed) return Promise.resolve();
    running = (async () => {
      while (active && !closed) {
        const rows = await database.query<{
          job_id: string;
          payload_json: string;
          payload_hash: string;
        }>(
          `UPDATE automatic_decision_jobs SET phase='processing'
          WHERE workspace_id=$1 AND job_id=(SELECT job_id FROM automatic_decision_jobs
          WHERE workspace_id=$1 AND phase='queued' ORDER BY created_at LIMIT 1)
          AND phase='queued' RETURNING job_id,payload_json,payload_hash`,
          [workspace.workspaceId]
        );
        const row = rows.rows[0];
        if (!row) break;
        try {
          const payload: unknown = JSON.parse(row.payload_json);
          const job = jobSchema.parse(payload);
          if (
            decisionDigest(payload) !== row.payload_hash ||
            decisionDigest(job) !== row.job_id
          )
            throw new Error("Automatic source notification integrity failed");
          // Notifications signal fresh work for a subject. MI captures its current
          // accepted original source, and coalesces overlapping notifications by
          // that exact source revision, audience and authorization proof.
          const batch = await input.meetingIntelligence.observe({
            workspace,
            subject: job.subject,
            observations: [
              {
                type: "decision-source-processed",
                observationId: `source-job:${row.job_id}`
              }
            ]
          });
          await database.query(
            "UPDATE automatic_decision_jobs SET phase=$3,batch_id=$4 WHERE workspace_id=$1 AND job_id=$2 AND phase='processing'",
            [
              workspace.workspaceId,
              row.job_id,
              batch.status === "completed" ? "completed" : "unavailable",
              batch.batchId
            ]
          );
        } catch {
          await database.query(
            "UPDATE automatic_decision_jobs SET phase='unavailable' WHERE workspace_id=$1 AND job_id=$2 AND phase='processing'",
            [workspace.workspaceId, row.job_id]
          );
        }
      }
    })()
      .catch(() => {
        // A failed database drain cannot keep admitting background execution. The
        // claimed durable row remains processing and becomes interrupted at restart.
        active = false;
      })
      .finally(() => {
        running = undefined;
        if (wakePending) schedule();
      });
    return running;
  };
  const enqueue = async (workspaceId: string, raw: Job) => {
    if (closed) throw new Error("Automatic Decision processing is closed");
    if (workspaceId !== workspace.workspaceId)
      throw new Error("Automatic source workspace mismatch");
    const job = jobSchema.parse(structuredClone(raw));
    const digest = decisionDigest(job);
    await database.query(
      `INSERT INTO automatic_decision_jobs
      (workspace_id,job_id,subject_hash,payload_json,payload_hash,phase)
      VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(workspace_id,job_id) DO NOTHING`,
      [workspaceId, digest, decisionDigest(job.subject), JSON.stringify(job), digest]
    );
    schedule();
  };
  const pause = () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    return running ?? Promise.resolve();
  };
  return {
    conversation(this: void, event: ProcessedConversationSourceEvent) {
      return enqueue(event.workspaceId, {
        subject: event.subject,
        eventId: event.admissionId,
        sourceRevision: event.sourceRevision,
        contentHash: event.contentHash
      });
    },
    meeting(this: void, event: ProcessedMeetingSourceEvent) {
      return enqueue(event.workspaceId, {
        subject: { type: "meeting", meetingId: event.meetingId },
        eventId: event.observationId,
        sourceRevision: event.sourceRevision,
        contentHash: event.contentHash
      });
    },
    start() {
      if (closed) throw new Error("Automatic Decision processing is closed");
      active = true;
      schedule();
    },
    pause,
    async stop() {
      closed = true;
      await pause();
    },
    async status(): Promise<AutomaticDecisionProcessingStatus> {
      const rows = await database.query<{ phase: Phase; count: number }>(
        "SELECT phase,count(*)::int AS count FROM automatic_decision_jobs WHERE workspace_id=$1 GROUP BY phase",
        [workspace.workspaceId]
      );
      const result: AutomaticDecisionProcessingStatus = {
        active,
        queued: 0,
        processing: 0,
        completed: 0,
        unavailable: 0,
        interrupted: 0
      };
      for (const row of rows.rows) result[row.phase] = row.count;
      return result;
    },
    async review(
      subject: DecisionSubject
    ): Promise<{ batch: AutomaticDecisionBatch | null; status: Phase | "unseen" }> {
      subject = decisionSubjectSchema.parse(structuredClone(subject));
      const rows = await database.query<{ phase: Phase; batch_id: string | null }>(
        "SELECT phase,batch_id FROM automatic_decision_jobs WHERE workspace_id=$1 AND subject_hash=$2 ORDER BY created_at DESC LIMIT 1",
        [workspace.workspaceId, decisionDigest(subject)]
      );
      const latest = rows.rows[0];
      if (!latest) return { batch: null, status: "unseen" };
      if (latest.batch_id)
        return {
          status: latest.phase,
          batch: await input.meetingIntelligence.query({
            workspaceId: workspace.workspaceId,
            subject,
            query: { type: "automatic-decision-candidates", batchId: latest.batch_id }
          })
        };
      // A crash may have happened after MI retained its batch but before the job
      // receipt. Ask the owned MI query to recover its current retained review.
      try {
        const batch = await input.meetingIntelligence.query({
          workspaceId: workspace.workspaceId,
          subject,
          query: { type: "automatic-decision-candidates" }
        });
        return { batch, status: latest.phase };
      } catch {
        return { batch: null, status: latest.phase };
      }
    }
  };
}
export type AutomaticDecisionProcessing = Awaited<
  ReturnType<typeof createAutomaticDecisionProcessing>
>;
