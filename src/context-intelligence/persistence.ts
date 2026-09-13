import type { LumaDatabase } from "../persistence/db.js";

export async function migrateContextRetrieval(database: LumaDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS processed_conversation_admissions (
      workspace_id TEXT NOT NULL, admission_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, anchor_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      PRIMARY KEY(workspace_id,admission_id)
    );
    CREATE INDEX IF NOT EXISTS processed_conversation_admissions_subject_idx
      ON processed_conversation_admissions(workspace_id,provider_id,conversation_id,anchor_id,source_revision);

    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_request_json TEXT;
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_receipt_id TEXT;
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_binding_hash TEXT;
    -- A completed paid result can be retained without ever becoming deliverable.
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS result_is_deliverable BOOLEAN NOT NULL DEFAULT TRUE;
    -- A crash or rejected paid output must not silently dispatch this inquiry again.
    CREATE TABLE IF NOT EXISTS context_answer_attempts (
      workspace_id TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, inquiry_id)
    );
  `);
}
