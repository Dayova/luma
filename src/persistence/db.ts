import { PGlite } from "@electric-sql/pglite";

export type LumaDatabase = PGlite;

export async function createPgliteDatabase(): Promise<LumaDatabase> {
  const database = new PGlite();
  await runMigrations(database);
  return database;
}

export async function runMigrations(database: LumaDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
    );

    CREATE TABLE IF NOT EXISTS meeting_observations (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      accepted_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, observation_id)
    );

    CREATE TABLE IF NOT EXISTS evidence (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_version TEXT,
      excerpt TEXT,
      active BOOLEAN NOT NULL,
      reference_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS utterance_versions (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      utterance_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      speaker_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      original_text TEXT NOT NULL,
      language TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      superseded_by_version INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id, utterance_id, version)
    );

    CREATE TABLE IF NOT EXISTS meeting_revisions (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id, revision)
    );

    CREATE TABLE IF NOT EXISTS conclusions (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      options_hash TEXT NOT NULL,
      conclusion_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id, revision, options_hash)
    );
  `);
}
