import type { LumaDatabase } from "../persistence/db.js";

export async function migrateOrganizationalContext(
  database: LumaDatabase
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS organizational_context_snapshots (
      workspace_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      source_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, catalog_id, source_id, snapshot_id)
    );
    CREATE TABLE IF NOT EXISTS organizational_context_receipts (
      receipt_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      proof_json TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
