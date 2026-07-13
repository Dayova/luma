import { PGlite } from "@electric-sql/pglite";
import { mkdir } from "node:fs/promises";

export type LumaDatabase = PGlite;

export async function createPgliteDatabase(dataDir?: string): Promise<LumaDatabase> {
  if (dataDir && !dataDir.includes("://")) {
    await mkdir(dataDir, { recursive: true });
  }

  const database = new PGlite(dataDir);
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

    CREATE TABLE IF NOT EXISTS discord_meeting_threads (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      meeting_title TEXT NOT NULL,
      thread_name TEXT NOT NULL,
      language_mode TEXT NOT NULL,
      actor_discord_user_id TEXT NOT NULL,
      meeting_observed_at TEXT,
      thread_id TEXT,
      thread_url TEXT,
      start_message_sent_at TEXT,
      conclusion_message_sent_at TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id),
      UNIQUE (guild_id, thread_id)
    );

    CREATE INDEX IF NOT EXISTS discord_meeting_threads_active_channel_idx
      ON discord_meeting_threads (guild_id, parent_channel_id, ended_at);

    CREATE UNIQUE INDEX IF NOT EXISTS discord_active_meeting_per_parent_idx
      ON discord_meeting_threads (guild_id, parent_channel_id)
      WHERE ended_at IS NULL;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS meeting_title TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS thread_name TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS language_mode TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS actor_discord_user_id TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS meeting_observed_at TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS start_message_sent_at TEXT;

    ALTER TABLE discord_meeting_threads
      ADD COLUMN IF NOT EXISTS conclusion_message_sent_at TEXT;

    UPDATE discord_meeting_threads
       SET meeting_title = meeting_id
     WHERE meeting_title IS NULL;

    UPDATE discord_meeting_threads
       SET thread_name = meeting_id
     WHERE thread_name IS NULL;

    UPDATE discord_meeting_threads
       SET language_mode = 'multilingual'
     WHERE language_mode IS NULL;

    UPDATE discord_meeting_threads
       SET actor_discord_user_id = 'unknown'
     WHERE actor_discord_user_id IS NULL;

    UPDATE discord_meeting_threads
       SET meeting_observed_at = created_at
     WHERE meeting_observed_at IS NULL AND thread_id IS NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN meeting_title SET NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN thread_name SET NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN language_mode SET NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN actor_discord_user_id SET NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN thread_id DROP NOT NULL;

    ALTER TABLE discord_meeting_threads
      ALTER COLUMN thread_url DROP NOT NULL;
  `);
}
