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
  /** Only each subject's latest notification can require present attention. */
  needsAttention: number;
};

/** Accepted source notifications are durable before returning to ingestion/Ask.
 * Analysis runs independently and shares MI's budget and idempotent batch ledger.
 * An interrupted attempt is visible and is never silently charged again.
 */
export async function createAutomaticDecisionProcessing(input: {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  meetingIntelligence: AutomaticDecisionIntelligence;
  now?: () => Date;
}) {
  const workspace = structuredClone(input.workspace),
    database = input.database;
  const now = input.now ?? (() => new Date());
  await database.exec(`CREATE TABLE IF NOT EXISTS automatic_decision_jobs (
    workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, subject_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','processing','completed','unavailable','interrupted')),
    batch_id TEXT, created_at BIGINT GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY(workspace_id,job_id)
  ); CREATE INDEX IF NOT EXISTS automatic_decision_jobs_queue
    ON automatic_decision_jobs(workspace_id,phase,created_at);
    ALTER TABLE automatic_decision_jobs ADD COLUMN IF NOT EXISTS retry_at BIGINT;`);
  await database.query(
    "UPDATE automatic_decision_jobs SET phase='interrupted' WHERE workspace_id=$1 AND phase='processing'",
    [workspace.workspaceId]
  );
  let active = false,
    closed = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  // Only a fresh process needs to inspect crash-interrupted jobs. This is a
  // read-only MI proof, never extraction or a provider dispatch.
  let interruptedCursor: number | null = 0;
  const manual = new Set<Promise<unknown>>();
  const schedule = (delayMs = 0) => {
    if (!active || closed) return;
    if (delayMs === 0) {
      wakePending = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    if (timer || running) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        wakePending = false;
        void drain();
      },
      Math.min(delayMs, 2_147_483_647)
    );
    timer.unref();
  };
  const drain = (): Promise<void> => {
    if (running) return running;
    if (!active || closed) return Promise.resolve();
    let nextRetryAt: number | undefined;
    running = (async () => {
      while (active && !closed && interruptedCursor !== null) {
        const recovered = await database.query<{
          job_id: string;
          payload_json: string;
          payload_hash: string;
          batch_id: string | null;
          created_at: number;
        }>(
          "SELECT job_id,payload_json,payload_hash,batch_id,created_at::float8 AS created_at FROM automatic_decision_jobs WHERE workspace_id=$1 AND phase='interrupted' AND created_at>$2 ORDER BY created_at LIMIT 100",
          [workspace.workspaceId, interruptedCursor]
        );
        for (const row of recovered.rows) {
          if (!active || closed) break;
          interruptedCursor = row.created_at;
          try {
            const payload: unknown = JSON.parse(row.payload_json);
            const job = jobSchema.parse(payload);
            if (
              decisionDigest(payload) !== row.payload_hash ||
              decisionDigest(job) !== row.job_id
            )
              throw new Error("Automatic source notification integrity failed");
            const batch = await input.meetingIntelligence.query({
              workspaceId: workspace.workspaceId,
              subject: job.subject,
              query: {
                type: "automatic-decision-candidates",
                ...(row.batch_id ? { batchId: row.batch_id } : {})
              }
            });
            const retry = batch.analysisRetry;
            if (
              retry?.canRetry &&
              retry.disposition === "not-dispatched" &&
              (retry.lastObservationId === `source-job:${row.job_id}` ||
                retry.lastObservationId ===
                  `source-job:${row.job_id}:retry:${retry.attempts - 1}`)
            )
              await saveOutcome(row.job_id, batch, "interrupted");
          } catch {
            // Missing, changed or unknown original proof remains interrupted.
          }
        }
        if (active && !closed && recovered.rows.length < 100) interruptedCursor = null;
      }
      while (active && !closed) {
        const rows = await database.query<{
          job_id: string;
          payload_json: string;
          payload_hash: string;
          batch_id: string | null;
        }>(
          `UPDATE automatic_decision_jobs SET phase='processing',retry_at=NULL
          WHERE workspace_id=$1 AND job_id=(SELECT job_id FROM automatic_decision_jobs
          WHERE workspace_id=$1 AND (phase='queued' OR (phase='unavailable' AND retry_at<=$2)) ORDER BY created_at LIMIT 1)
          AND (phase='queued' OR (phase='unavailable' AND retry_at<=$2)) RETURNING job_id,payload_json,payload_hash,batch_id`,
          [workspace.workspaceId, now().getTime()]
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
          const retained = row.batch_id
            ? await input.meetingIntelligence.query({
                workspaceId: workspace.workspaceId,
                subject: job.subject,
                query: { type: "automatic-decision-candidates", batchId: row.batch_id }
              })
            : null;
          const batch = await input.meetingIntelligence.observe({
            workspace,
            subject: job.subject,
            observations: [
              {
                type: "decision-source-processed",
                observationId: retained
                  ? `source-job:${row.job_id}:retry:${retained.analysisRetry?.attempts ?? 0}`
                  : `source-job:${row.job_id}`,
                ...(row.batch_id ? { retryBatchId: row.batch_id } : {})
              }
            ]
          });
          await saveOutcome(row.job_id, batch);
        } catch {
          await database.query(
            "UPDATE automatic_decision_jobs SET phase='unavailable',retry_at=NULL WHERE workspace_id=$1 AND job_id=$2 AND phase='processing'",
            [workspace.workspaceId, row.job_id]
          );
        }
      }
      if (active && !closed) {
        const due = await database.query<{ retry_at: number | null }>(
          "SELECT min(retry_at)::float8 AS retry_at FROM automatic_decision_jobs WHERE workspace_id=$1 AND phase='unavailable'",
          [workspace.workspaceId]
        );
        nextRetryAt = due.rows[0]?.retry_at ?? undefined;
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
        else if (nextRetryAt !== undefined)
          schedule(Math.max(0, nextRetryAt - now().getTime()));
      });
    return running;
  };
  const saveOutcome = async (
    jobId: string,
    batch: AutomaticDecisionBatch,
    expectedPhase?: Phase
  ) => {
    const retryAt =
      batch.analysisRetry?.canRetry && batch.analysisRetry.nextAttemptAt
        ? Date.parse(batch.analysisRetry.nextAttemptAt)
        : null;
    await database.query(
      "UPDATE automatic_decision_jobs SET phase=$3,batch_id=$4,retry_at=$5 WHERE workspace_id=$1 AND job_id=$2 AND ($6::text IS NULL OR phase=$6)",
      [
        workspace.workspaceId,
        jobId,
        batch.status === "completed" ? "completed" : "unavailable",
        batch.batchId,
        Number.isFinite(retryAt) ? retryAt : null,
        expectedPhase ?? null
      ]
    );
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
    return Promise.allSettled([...(running ? [running] : []), ...manual]).then(() => {});
  };
  const api = {
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
      const attention = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM
        (SELECT DISTINCT ON(subject_hash) phase FROM automatic_decision_jobs
         WHERE workspace_id=$1 ORDER BY subject_hash,created_at DESC) latest
        WHERE phase IN ('unavailable','interrupted')`,
        [workspace.workspaceId]
      );
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
        interrupted: 0,
        needsAttention: attention.rows[0]?.count ?? 0
      };
      for (const row of rows.rows) result[row.phase] = row.count;
      return result;
    },
    retry(subject: DecisionSubject, observationId: string): Promise<void> {
      if (closed || !active)
        return Promise.reject(new Error("Automatic Decision processing is paused"));
      if (!observationId.trim() || observationId.length > 512)
        return Promise.reject(new Error("A stable retry instruction is required"));
      subject = decisionSubjectSchema.parse(structuredClone(subject));
      const task = (async () => {
        const before = await api.review(subject);
        if (!before.batch?.analysisRetry?.canRetry) return;
        const rows = await database.query<{ job_id: string; batch_id: string | null }>(
          "SELECT job_id,batch_id FROM automatic_decision_jobs WHERE workspace_id=$1 AND subject_hash=$2 ORDER BY created_at DESC LIMIT 1",
          [workspace.workspaceId, decisionDigest(subject)]
        );
        const row = rows.rows[0];
        if (!row || (row.batch_id && row.batch_id !== before.batch.batchId))
          throw new Error("The retry notification changed");
        const batch = await input.meetingIntelligence.observe({
          workspace,
          subject,
          observations: [
            {
              type: "decision-source-processed",
              observationId,
              retryBatchId: before.batch.batchId,
              retryBeforeScheduled: true
            }
          ]
        });
        await saveOutcome(row.job_id, batch);
        schedule();
      })().finally(() => manual.delete(task));
      manual.add(task);
      return task;
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
  return api;
}
export type AutomaticDecisionProcessing = Awaited<
  ReturnType<typeof createAutomaticDecisionProcessing>
>;
