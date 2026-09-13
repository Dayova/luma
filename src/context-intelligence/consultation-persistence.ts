import type { LumaDatabase } from "../persistence/db.js";

export async function migrateConversationConsultations(
  database: LumaDatabase
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_consultations (
      workspace_id TEXT NOT NULL, subject_key TEXT NOT NULL, consultation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL, choice_key TEXT NOT NULL, plan_json TEXT NOT NULL, plan_digest TEXT NOT NULL,
      publication_json TEXT, publication_digest TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subject_key, consultation_id),
      UNIQUE (workspace_id, subject_key, choice_key)
    );
    CREATE TABLE IF NOT EXISTS conversation_consultation_operations (
      workspace_id TEXT NOT NULL, subject_key TEXT NOT NULL, intent_id TEXT NOT NULL,
      consultation_id TEXT NOT NULL, intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('approved','executing','succeeded','not-applied','unknown')),
      record_json TEXT, record_digest TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subject_key, intent_id),
      FOREIGN KEY (workspace_id, subject_key, consultation_id)
        REFERENCES conversation_consultations(workspace_id, subject_key, consultation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_consultation_events (
      workspace_id TEXT NOT NULL, subject_key TEXT NOT NULL, consultation_id TEXT NOT NULL,
      event_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subject_key, consultation_id, event_id),
      FOREIGN KEY (workspace_id, subject_key, consultation_id)
        REFERENCES conversation_consultations(workspace_id, subject_key, consultation_id)
    );
  `);
}
