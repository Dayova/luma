import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type { KnowledgeProvider } from "../../src/knowledge/interface.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createFullStoreBackup,
  restoreFullStoreBackup,
  verifyFullStoreBackup,
  verifyIsolatedRestoredStore
} from "../../src/persistence/full-store-backup.js";
import {
  CLEAN_CLOSE_FILE,
  openOwnedPgliteDatabase
} from "../../src/persistence/store-ownership.js";

const roots: string[] = [];
const revision = "a".repeat(40);
const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const now = () => new Date("2026-09-09T10:00:00.000Z");
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function paths() {
  const root = await mkdtemp(join(tmpdir(), "luma-cold-restore-"));
  roots.push(root);
  return {
    root,
    dataDir: join(root, "original"),
    backupDir: join(root, "backup"),
    restoreDir: join(root, "rehearsal"),
    applicationRevision: revision
  };
}

class ProposalModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidenceId = request.evidence[0]?.evidenceId;
    if (!evidenceId) throw new Error("Expected retained Evidence");
    const value: MeetingAnalysisProposalBatch = {
      actionItems: [],
      decisions: [
        {
          stableKey: "retention",
          statement: "Delete after 90 days",
          rationale: [],
          status: "candidate",
          supportingParticipantIds: [],
          objectingParticipantIds: [],
          relatedTopicIds: [],
          evidenceIds: [evidenceId],
          confidence: "medium"
        }
      ],
      openQuestions: [],
      risks: [],
      followUpIntentions: [
        {
          id: `record-${request.meetingId}`,
          type: "record-meeting",
          title: "Internal Meeting",
          relatedMeetingItemIds: [],
          evidenceIds: [evidenceId],
          confidence: "high"
        }
      ]
    };
    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "deterministic-test",
        model: "programmable",
        promptVersion: request.promptVersion
      }
    });
  }
}

function note(text: string): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Retention",
    lifecycle: "ready",
    calendar: null,
    recording: null,
    sections: {
      summary: { state: "available", sourceBlockId: "summary", text, blocks: [] },
      actionItemsAndNotes: {
        state: "available",
        sourceBlockId: "actions",
        text: "",
        blocks: []
      },
      transcript: { state: "available", sourceBlockId: "speech", text, blocks: [] }
    },
    markdown: { content: text, truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
}

/** Capture all rows dynamically, so unknown/future tables cannot silently disappear. */
async function allRows(database: LumaDatabase): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const { rows } = await database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  );
  for (const { tablename } of rows) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const table = await database.query<{ row: string }>(
      `SELECT to_jsonb(t)::text AS row FROM ${quoted} t ORDER BY to_jsonb(t)::text`
    );
    result[tablename] = table.rows.map((row) => row.row);
  }
  return result;
}

describe("full-store cold backup and isolated restore", () => {
  it("retains source revisions, Human Judgment, completed and prepared execution, and billing without replaying a write", async () => {
    const locations = await paths();
    const database = await createPgliteDatabase(locations.dataDir);
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProposalModel(),
      now
    });
    const writes: string[] = [];
    const knowledgeProvider: KnowledgeProvider = {
      providerId: "notion",
      search: () => Promise.resolve([]),
      getDocument: () => Promise.reject(new Error("No live reads in rehearsal")),
      updateDocument: () => Promise.reject(new Error("No live updates in rehearsal")),
      listChanges: () => Promise.resolve({ changes: [], nextCursor: null }),
      createDocument: (input) => {
        writes.push(input.idempotencyKey);
        return Promise.resolve({
          providerId: "notion",
          objectType: "document",
          externalId: "created-once",
          url: "https://example.test/receipt"
        });
      }
    };
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now
    });
    for (const meetingId of ["completed", "prepared"]) {
      const base = {
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: now().toISOString(),
        observedAt: now().toISOString()
      };
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...base,
            type: "meeting-started",
            observationId: `${meetingId}-start`,
            title: "Retention",
            startedAt: now().toISOString(),
            languageMode: "multilingual",
            participantIds: ["person_jakob"]
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...base,
            type: "utterance-committed",
            observationId: `${meetingId}-speech-1`,
            utteranceId: `${meetingId}-speech`,
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: now().toISOString(),
            endedAt: now().toISOString(),
            originalText: "Vielleicht 90 Tage?",
            language: "de"
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...base,
            type: "utterance-revised",
            observationId: `${meetingId}-speech-2`,
            utteranceId: `${meetingId}-speech`,
            replacesVersion: 1,
            version: 2,
            originalText: "Keep and rank knowledge; nicht löschen.",
            language: "mixed"
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...base,
            type: "human-judgment-recorded",
            observationId: `${meetingId}-judgment`,
            participantId: "person_jakob",
            judgment: {
              kind: "correct",
              meetingItemId: "decision:retention",
              correction: { statement: "Retain and rank knowledge", status: "confirmed" }
            }
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...base,
            type: "follow-up-intent-approved",
            observationId: `${meetingId}-approval`,
            intentId: `record-${meetingId}`,
            approvedBy: "person_jakob"
          }
        ]
      });
    }
    const completed = await execution.execute({
      workspace,
      meetingId: "completed",
      intentId: "record-completed"
    });
    expect(completed.observation.outcome.status).toBe("succeeded");
    expect(writes).toHaveLength(1);
    // Model a process interrupted after its durable reservation, before it could
    // record a provider outcome. Recovery must preserve this uncertainty.
    const pendingKey = `${workspace.workspaceId}:prepared:record-prepared:execute`;
    await database.query(
      `INSERT INTO follow_up_executions
      (workspace_id,meeting_id,intent_id,operation,idempotency_key,status,attempts,result_json,execution_lease_id,created_at,updated_at)
      VALUES ($1,'prepared','record-prepared','execute',$2,'executing',1,NULL,'prepared-lease',$3,$3)`,
      [workspace.workspaceId, pendingKey, now().toISOString()]
    );
    // Opaque prepared-payload fixture is deliberately persistence-level: a full
    // backup must preserve stage bytes and digests without interpreting them.
    await database.query(
      `INSERT INTO operational_outcome_settlements
      (workspace_id,meeting_id,intent_id,review_id,candidate_id,candidate_lineage_key,source_provider_id,
       source_document_id,source_object_id,source_revision,source_content_hash,plan_json,created_at,updated_at)
      VALUES ($1,'prepared','record-prepared','review','candidate','lineage','notion','page','block',2,'hash','{}',$2,$2)`,
      [workspace.workspaceId, now().toISOString()]
    );
    await database.query(
      `INSERT INTO operational_outcome_settlement_stages
      (workspace_id,meeting_id,intent_id,stage,status,idempotency_key,prepared_outcome_json,prepared_operation_token,
       payload_digest,content_digest,operation_digest,execution_lease_id,created_at,updated_at)
      VALUES ($1,'prepared','record-prepared','outcome','executing','stage-key',$2,'operation-token','payload','content','operation','prepared-lease',$3,$3)`,
      [
        workspace.workspaceId,
        JSON.stringify({ text: "Exact prepared outcome — nicht überschreiben" }),
        now().toISOString()
      ]
    );
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "block",
      parentObjectId: "page",
      url: "https://example.test/page"
    };
    const ledger = createObservedSourceLedger({ database });
    const revisions = [];
    for (const text of ["Maybe purge?", "Keep and rank — final correction"]) {
      revisions.push(
        await ledger.record({
          workspaceId: workspace.workspaceId,
          source,
          providerVersion: null,
          snapshot: note(text),
          observedAt: now().toISOString()
        })
      );
    }
    const budget = createAiUsageBudget({ database, now });
    const reservation = {
      workspaceId: workspace.workspaceId,
      capability: "context-ask",
      model: "gpt-5.6-luna",
      inputTokenUpperBound: 1000,
      maxOutputTokens: 200
    };
    const paid = await budget.reserve({ ...reservation, workflowId: "settled" });
    await budget.settle(paid.reservationId, {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0
    });
    const unknown = await budget.reserve({ ...reservation, workflowId: "unknown" });
    await budget.markUnknown(unknown.reservationId);
    const budgetBefore = await budget.getStatus(workspace.workspaceId);
    await database.exec(
      "CREATE TABLE future_capability (id TEXT PRIMARY KEY, retained TEXT); INSERT INTO future_capability VALUES ('future', 'Unknown tables retained too')"
    );
    const snapshotBefore = await meetingIntelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: "completed",
      query: { type: "snapshot" }
    });
    const rowsBefore = await allRows(database);
    await database.close();

    const manifest = await createFullStoreBackup(locations);
    expect(manifest.files.length).toBeGreaterThan(10);
    await restoreFullStoreBackup(locations);
    await expect(createPgliteDatabase(locations.restoreDir)).rejects.toThrow(
      "quarantined"
    );
    const report = await verifyIsolatedRestoredStore(locations.restoreDir);
    expect(report.tables).toContainEqual({ table: "future_capability", rows: "1" });
    const restored = await openOwnedPgliteDatabase(
      locations.restoreDir,
      "isolated-restore-verification"
    );
    try {
      expect(await allRows(restored)).toEqual(rowsBefore);
      const restoredIntelligence = createMeetingIntelligence({
        database: restored,
        reasoningModel: {
          generateStructured: () =>
            Promise.reject(new Error("No model calls during restore verification"))
        },
        now
      });
      expect(
        await restoredIntelligence.query({
          workspaceId: workspace.workspaceId,
          meetingId: "completed",
          query: { type: "snapshot" }
        })
      ).toEqual(snapshotBefore);
      expect(snapshotBefore).toMatchObject({
        state: {
          decisions: [
            expect.objectContaining({
              statement: "Retain and rank knowledge",
              status: "confirmed"
            })
          ]
        }
      });
      const restoredLedger = createObservedSourceLedger({ database: restored });
      for (const captured of revisions) {
        expect(
          await restoredLedger.get({
            workspaceId: workspace.workspaceId,
            source,
            revision: captured.revision
          })
        ).toMatchObject({
          contentHash: captured.contentHash,
          snapshot: captured.snapshot
        });
      }
      expect(
        await createAiUsageBudget({ database: restored, now }).getStatus(
          workspace.workspaceId
        )
      ).toEqual(budgetBefore);
      const restoredExecution = createFollowUpExecution({
        database: restored,
        meetingIntelligence: restoredIntelligence,
        knowledgeProvider: {
          ...knowledgeProvider,
          createDocument: () =>
            Promise.reject(
              new Error("Restore tried to duplicate a completed provider write")
            )
        },
        now
      });
      const replay = await restoredExecution.execute({
        workspace,
        meetingId: "completed",
        intentId: "record-completed"
      });
      expect(replay.observation.outcome).toEqual(completed.observation.outcome);
      await expect(
        restoredExecution.execute({
          workspace,
          meetingId: "prepared",
          intentId: "record-prepared"
        })
      ).rejects.toThrow("in progress");
      expect(writes).toHaveLength(1);
    } finally {
      await restored.close();
    }
    // Rehearsal never changes the archived artifact; hashes still match.
    await expect(verifyFullStoreBackup(locations.backupDir)).resolves.toMatchObject({
      backupId: manifest.backupId
    });
  }, 60_000);

  it("refuses active owners, alias paths, stale leases and stores without a clean-close receipt", async () => {
    const locations = await paths();
    const database = await createPgliteDatabase(locations.dataDir);
    try {
      await expect(createPgliteDatabase(locations.dataDir)).rejects.toThrow("owned");
      await expect(createFullStoreBackup(locations)).rejects.toThrow("owned");
      await symlink(locations.root, join(locations.root, "alias"));
      await expect(
        createPgliteDatabase(join(locations.root, "alias", "original"))
      ).rejects.toThrow("owned");
    } finally {
      await database.close();
    }
    await mkdir(`${locations.dataDir}.luma-owner`);
    await expect(createFullStoreBackup(locations)).rejects.toThrow("owned");
    await rm(`${locations.dataDir}.luma-owner`, { recursive: true }); // Test-owned crash fixture only.
    await rm(join(locations.dataDir, CLEAN_CLOSE_FILE));
    await expect(createFullStoreBackup(locations)).rejects.toThrow();
    await expect(createPgliteDatabase(`file://${locations.dataDir}`)).rejects.toThrow(
      "local filesystem path"
    );
  }, 30_000);

  it("detects changed, missing and extra data and modified manifests before creating a restore", async () => {
    const locations = await paths();
    const database = await createPgliteDatabase(locations.dataDir);
    await database.close();
    await createFullStoreBackup(locations);
    const versionFile = join(locations.backupDir, "store", "PG_VERSION");
    const original = await readFile(versionFile);
    await appendFile(versionFile, "corruption");
    await expect(restoreFullStoreBackup(locations)).rejects.toThrow("integrity");
    await writeFile(versionFile, original);
    await rm(versionFile);
    await expect(verifyFullStoreBackup(locations.backupDir)).rejects.toThrow("integrity");
    await writeFile(versionFile, original);
    await writeFile(join(locations.backupDir, "store", "extra"), "unmanifested");
    await expect(verifyFullStoreBackup(locations.backupDir)).rejects.toThrow("integrity");
    await rm(join(locations.backupDir, "store", "extra"));
    await appendFile(join(locations.backupDir, "manifest.json"), " ");
    await expect(verifyFullStoreBackup(locations.backupDir)).rejects.toThrow(
      "manifest integrity"
    );
  }, 30_000);

  it("refuses existing or nested destinations and shared/symlinked stores without overwriting data", async () => {
    const locations = await paths();
    const database = await createPgliteDatabase(locations.dataDir);
    await database.close();
    await expect(
      createFullStoreBackup({
        ...locations,
        backupDir: join(locations.dataDir, "..nested")
      })
    ).rejects.toThrow("separate");
    await createFullStoreBackup(locations);
    await expect(createFullStoreBackup(locations)).rejects.toThrow();
    await mkdir(locations.restoreDir);
    await writeFile(join(locations.restoreDir, "sentinel"), "preserve");
    await expect(restoreFullStoreBackup(locations)).rejects.toThrow();
    expect(await readFile(join(locations.restoreDir, "sentinel"), "utf8")).toBe(
      "preserve"
    );
    await expect(
      restoreFullStoreBackup({
        ...locations,
        restoreDir: join(locations.dataDir, "nested")
      })
    ).rejects.toThrow("separate");
    await symlink(
      join(locations.dataDir, "PG_VERSION"),
      join(locations.dataDir, "shared-file")
    );
    await expect(
      createFullStoreBackup({ ...locations, backupDir: join(locations.root, "other") })
    ).rejects.toThrow("Symlinks");
  }, 30_000);
});
