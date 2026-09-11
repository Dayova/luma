import type { LumaDatabase } from "../persistence/db.js";
export async function migrateDecisionAuthority(database: LumaDatabase): Promise<void> {
  await database.exec(`CREATE TABLE IF NOT EXISTS decision_authority_snapshots (
    workspace_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL, audience_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL, audience_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id,snapshot_hash,audience_hash)
  )`);
}
