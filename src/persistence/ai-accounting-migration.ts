import type { LumaDatabase } from "./db.js";

export async function migrateAiAccountingRecovery(database: LumaDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS ai_accounting_migrations (id TEXT PRIMARY KEY);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM ai_accounting_migrations WHERE id = 'lum-52-v1') THEN
        ALTER TABLE ai_usage_requests ADD COLUMN IF NOT EXISTS accounting_blocker BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE ai_usage_requests ADD COLUMN IF NOT EXISTS reconciliation_id TEXT;
        ALTER TABLE ai_usage_locks ADD COLUMN IF NOT EXISTS accounting_revision BIGINT NOT NULL DEFAULT 0;
        -- Older releases recorded the workspace hold without individual blockers.
        -- Conservatively require review of every unresolved request in that workspace.
        UPDATE ai_usage_requests SET accounting_blocker = TRUE
          WHERE state IN ('reserved','unknown') AND workspace_id IN
            (SELECT workspace_id FROM ai_usage_locks WHERE accounting_blocked = TRUE);
        INSERT INTO ai_accounting_migrations VALUES ('lum-52-v1');
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS ai_accounting_preparations (
      preparation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      preparation_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_accounting_audit (
      audit_id TEXT PRIMARY KEY,
      preparation_id TEXT NOT NULL UNIQUE REFERENCES ai_accounting_preparations(preparation_id),
      workspace_id TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE OR REPLACE FUNCTION reject_ai_accounting_audit_change() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'AI accounting records are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ai_accounting_preparation_immutable ON ai_accounting_preparations;
    CREATE TRIGGER ai_accounting_preparation_immutable BEFORE UPDATE OR DELETE ON ai_accounting_preparations
      FOR EACH ROW EXECUTE FUNCTION reject_ai_accounting_audit_change();
    DROP TRIGGER IF EXISTS ai_accounting_audit_immutable ON ai_accounting_audit;
    CREATE TRIGGER ai_accounting_audit_immutable BEFORE UPDATE OR DELETE ON ai_accounting_audit
      FOR EACH ROW EXECUTE FUNCTION reject_ai_accounting_audit_change();
  `);
}
