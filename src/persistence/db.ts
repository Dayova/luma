import { migrateConversationConsultations } from "../context-intelligence/consultation-persistence.js";
import { migrateDecisionIntelligence } from "../decision-intelligence/persistence.js";
import { migrateOrganizationalContext } from "../organizational-context/persistence.js";
import { migrateContextRetrieval } from "../context-intelligence/persistence.js";
import { migrateMeetingContext } from "../meeting-intelligence/context-guard.js";
import { PGlite } from "@electric-sql/pglite";
import { openOwnedPgliteDatabase } from "./store-ownership.js";
import { migrateAiAccountingRecovery } from "./ai-accounting-migration.js";

export type LumaDatabase = PGlite;

export async function createPgliteDatabase(dataDir?: string): Promise<LumaDatabase> {
  if (dataDir?.includes("://") && dataDir !== "memory://") {
    throw new Error(
      "Durable stores require a local filesystem path for exclusive ownership"
    );
  }
  const database =
    dataDir && dataDir !== "memory://"
      ? await openOwnedPgliteDatabase(dataDir, "runtime")
      : new PGlite(dataDir);
  try {
    await runMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function runMigrations(database: LumaDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_locks (
      workspace_id TEXT PRIMARY KEY,
      accounting_blocked BOOLEAN NOT NULL DEFAULT FALSE
    );

    -- Operational accounting only: no prompt, output, source text or provider secrets.
    CREATE TABLE IF NOT EXISTS ai_usage_requests (
      reservation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      model TEXT NOT NULL,
      price_version TEXT NOT NULL,
      month TEXT NOT NULL,
      day TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','unknown','settled')),
      reserved_nanos BIGINT NOT NULL CHECK (reserved_nanos >= 0),
      input_token_upper_bound INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      charged_nanos BIGINT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      response_facts_json TEXT
    );

    CREATE INDEX IF NOT EXISTS ai_usage_month_idx
      ON ai_usage_requests (workspace_id, month);
    CREATE INDEX IF NOT EXISTS ai_usage_workflow_idx
      ON ai_usage_requests (workspace_id, workflow_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Establishes one immutable workspace configuration before concurrent
    -- first deliveries can interpret source-derived deadlines differently.
    CREATE TABLE IF NOT EXISTS workspace_config_locks (
      workspace_id TEXT PRIMARY KEY
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

    -- A durable per-Meeting mutex lets transactions serialize even before the
    -- first accepted Observation creates its Meeting state row.
    CREATE TABLE IF NOT EXISTS meeting_state_locks (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id)
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
      -- Legacy provider participant storage. New records use the explicit
      -- attribution JSON below; old non-null values are never upgraded to
      -- certainty automatically.
      speaker_id TEXT,
      speaker_attribution_json TEXT,
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

    CREATE TABLE IF NOT EXISTS follow_up_executions (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key)
    );

    -- A source-bound reconciliation settlement is a two-stage saga: work
    -- resolution may succeed before Luma can safely publish the compact
    -- Notion Operational Outcome. Keep immutable intent-derived plans and
    -- stage receipts separate from the outer Follow-up Execution receipt so
    -- recovery never creates Linear work a second time.
    CREATE TABLE IF NOT EXISTS operational_outcome_settlements (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      candidate_lineage_key TEXT NOT NULL,
      source_provider_id TEXT NOT NULL,
      source_document_id TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      source_content_hash TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, meeting_id, intent_id),
      UNIQUE (workspace_id, meeting_id, review_id)
    );

    CREATE INDEX IF NOT EXISTS operational_outcome_settlements_source_idx
      ON operational_outcome_settlements (source_provider_id, source_document_id);

    CREATE TABLE IF NOT EXISTS operational_outcome_settlement_stages (
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('work', 'outcome')),
      status TEXT NOT NULL CHECK (
        status IN (
          'not-required', 'pending', 'executing', 'succeeded',
          'unresolved', 'requires-manual-recovery'
        )
      ),
      idempotency_key TEXT NOT NULL UNIQUE,
      reference_json TEXT,
      -- The exact aggregate Luma intends to publish is stored before the
      -- provider call. A crash can therefore only complete a positively
      -- re-read identical write; it can never reconstruct and overwrite a
      -- newer aggregate optimistically.
      prepared_outcome_json TEXT,
      prepared_operation_token TEXT,
      payload_digest TEXT,
      content_digest TEXT,
      operation_digest TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      execution_lease_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (workspace_id, meeting_id, intent_id, stage),
      FOREIGN KEY (workspace_id, meeting_id, intent_id)
        REFERENCES operational_outcome_settlements (workspace_id, meeting_id, intent_id)
    );

    -- A durable ownership record makes the one Luma-owned outcome section on
    -- a source page serializable across executions. A future adapter may add
    -- provider-specific recovery while retaining this opaque boundary.
    CREATE TABLE IF NOT EXISTS operational_outcome_page_leases (
      source_provider_id TEXT NOT NULL,
      source_document_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      execution_lease_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_provider_id, source_document_id)
    );

    -- One physical document has one Luma-owned Operational Outcome section.
    -- Do not let two opaque workspaces take turns replacing that section just
    -- because their provider-local page IDs collide.
    CREATE TABLE IF NOT EXISTS operational_outcome_pages (
      source_provider_id TEXT NOT NULL,
      source_document_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_provider_id, source_document_id)
    );

    CREATE TABLE IF NOT EXISTS observed_sources (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      parent_object_id TEXT,
      source_reference_json TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 0,
      current_content_hash TEXT,
      current_observation_generation INTEGER NOT NULL DEFAULT 0,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      last_provider_version TEXT,
      PRIMARY KEY (workspace_id, provider_id, source_kind, source_object_id)
    );

    CREATE TABLE IF NOT EXISTS observed_source_snapshots (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      content_hash TEXT NOT NULL,
      provider_version TEXT,
      source_reference_json TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (
        workspace_id,
        provider_id,
        source_kind,
        source_object_id,
        source_revision
      ),
      FOREIGN KEY (workspace_id, provider_id, source_kind, source_object_id)
        REFERENCES observed_sources (workspace_id, provider_id, source_kind, source_object_id)
    );

    CREATE INDEX IF NOT EXISTS observed_source_snapshots_hash_idx
      ON observed_source_snapshots (
        workspace_id,
        provider_id,
        source_kind,
        source_object_id,
        content_hash
      );

    -- Context Ask is read-only, but its answer must remain reproducible from
    -- the immutable conversation revision it used. The interaction ID is the
    -- public idempotency boundary: a retry returns the original answer, while
    -- a mismatched request is rejected by Context Intelligence.
    CREATE TABLE IF NOT EXISTS context_inquiries (
      workspace_id TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      source_provider_id TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      source_content_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, inquiry_id)
    );

    -- A pre-release Context Ask table may exist without this corruption-detecting
    -- binding. Such legacy rows remain fail-closed until explicitly recreated.
    ALTER TABLE context_inquiries
      ADD COLUMN IF NOT EXISTS result_content_hash TEXT;

    CREATE INDEX IF NOT EXISTS context_inquiries_source_revision_idx
      ON context_inquiries (
        workspace_id,
        source_provider_id,
        source_object_id,
        source_revision
      );

    -- Native Notion review is read-only, but its result must remain bound to
    -- the authenticated native actor, exact requested page, and immutable
    -- source revision that supplied reconciliation evidence. The native run
    -- ID is the public idempotency boundary: a retry returns the original
    -- receipt, while a changed request fails closed before another capture.
    CREATE TABLE IF NOT EXISTS source_bound_native_reviews (
      workspace_id TEXT NOT NULL,
      native_run_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      actor_identity_provider_id TEXT NOT NULL,
      actor_provider_user_id TEXT NOT NULL,
      actor_person_id TEXT,
      page_provider_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      source_provider_id TEXT,
      source_object_id TEXT,
      source_revision INTEGER CHECK (source_revision > 0),
      source_content_hash TEXT,
      capability_version TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      receipt_content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        (source_provider_id IS NULL AND source_object_id IS NULL AND
         source_revision IS NULL AND source_content_hash IS NULL) OR
        (source_provider_id IS NOT NULL AND source_object_id IS NOT NULL AND
         source_revision IS NOT NULL AND source_content_hash IS NOT NULL)
      ),
      PRIMARY KEY (workspace_id, native_run_id)
    );

    -- A source-revision receipt reader never needs clarification receipts,
    -- which have no immutable source identity to invalidate or replay.
    CREATE INDEX IF NOT EXISTS source_bound_native_reviews_source_revision_idx
      ON source_bound_native_reviews (
        workspace_id,
        source_provider_id,
        source_object_id,
        source_revision
      )
      WHERE source_provider_id IS NOT NULL;

    -- An in-flight source-bound provider mutation holds this fence after it
    -- has atomically proved the exact ledger head it will act on. Source
    -- ingestion must not advance that root (or infer its removal) until the
    -- execution records a canonical terminal receipt and releases the fence.
    CREATE TABLE IF NOT EXISTS observed_source_execution_fences (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      source_content_hash TEXT NOT NULL,
      -- A later source scan may prove this held head is no longer safe to
      -- mutate externally. Preserve that proof here without promoting the
      -- newer material to the mutable source head until release.
      supersession_kind TEXT CHECK (supersession_kind IN ('changed', 'removed')),
      superseding_content_hash TEXT,
      superseded_at TEXT,
      meeting_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      execution_lease_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, provider_id, source_kind, source_object_id),
      FOREIGN KEY (workspace_id, provider_id, source_kind, source_object_id)
        REFERENCES observed_sources (workspace_id, provider_id, source_kind, source_object_id)
    );

    CREATE INDEX IF NOT EXISTS observed_source_execution_fences_owner_idx
      ON observed_source_execution_fences (
        workspace_id, meeting_id, intent_id, execution_lease_id
      );

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

    ALTER TABLE observed_sources
      ADD COLUMN IF NOT EXISTS current_observation_generation INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE observed_source_execution_fences
      ADD COLUMN IF NOT EXISTS supersession_kind TEXT;

    ALTER TABLE observed_source_execution_fences
      ADD COLUMN IF NOT EXISTS superseding_content_hash TEXT;

    ALTER TABLE observed_source_execution_fences
      ADD COLUMN IF NOT EXISTS superseded_at TEXT;

    ALTER TABLE operational_outcome_settlements
      ADD COLUMN IF NOT EXISTS source_object_id TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS payload_digest TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS prepared_outcome_json TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS prepared_operation_token TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS content_digest TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS operation_digest TEXT;

    ALTER TABLE operational_outcome_settlement_stages
      ADD COLUMN IF NOT EXISTS prepared_patch_json TEXT;
    ALTER TABLE operational_outcome_settlement_stages
      DROP CONSTRAINT IF EXISTS operational_outcome_settlement_stages_stage_check;
    ALTER TABLE operational_outcome_settlement_stages
      ADD CONSTRAINT operational_outcome_settlement_stages_stage_check
      CHECK (stage IN ('work', 'knowledge', 'outcome'));

    CREATE INDEX IF NOT EXISTS operational_outcome_settlements_source_root_idx
      ON operational_outcome_settlements (
        source_provider_id, source_document_id, source_object_id
      );

    -- Logical Meetings are Luma-owned, provider-neutral bindings over
    -- independently archived captures. They intentionally sit beside the
    -- source-specific observed-source ledger: they retain only normalized
    -- identity/capability metadata and immutable source pointers, never raw
    -- Meeting Note or transcript content.
    CREATE TABLE IF NOT EXISTS logical_meeting_workspace_locks (
      workspace_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS logical_meetings (
      workspace_id TEXT NOT NULL,
      logical_meeting_id TEXT NOT NULL,
      -- LUM-35 will deliberately select an anchor. LUM-33 must leave this
      -- null rather than implicitly promoting a provider capture to canonical.
      canonical_anchor_ref_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, logical_meeting_id)
    );

    CREATE TABLE IF NOT EXISTS meeting_captures (
      workspace_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      -- Opaque per-user/per-workspace source scope; never a credential.
      provider_connection_id TEXT NOT NULL,
      external_capture_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, capture_id),
      UNIQUE (
        workspace_id,
        provider_id,
        provider_connection_id,
        external_capture_id,
        source_kind
      )
    );

    CREATE TABLE IF NOT EXISTS meeting_capture_revisions (
      workspace_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      content_hash TEXT NOT NULL,
      provider_version TEXT,
      captured_at TEXT NOT NULL,
      eligibility_json TEXT NOT NULL,
      availability TEXT NOT NULL CHECK (
        availability IN ('complete', 'partial', 'not-ready', 'failed', 'removed')
      ),
      capabilities_json TEXT NOT NULL,
      identity_facts_json TEXT NOT NULL,
      materials_json TEXT NOT NULL,
      external_reference_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, capture_id, source_revision),
      FOREIGN KEY (workspace_id, capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id)
    );

    CREATE INDEX IF NOT EXISTS meeting_capture_revisions_latest_idx
      ON meeting_capture_revisions (workspace_id, capture_id, source_revision DESC);

    -- An importable withheld revision records only its opaque provider address,
    -- immutable revision/hash, and eligibility decision. It deliberately
    -- stores no source descriptors or matching facts; private/policy decisions
    -- instead receive the stronger append-only terminal fence below.
    CREATE TABLE IF NOT EXISTS meeting_capture_eligibility_watermarks (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_connection_id TEXT NOT NULL,
      external_capture_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      content_hash TEXT NOT NULL,
      eligibility_state TEXT NOT NULL CHECK (
        eligibility_state IN ('excluded', 'requires-human-import')
      ),
      eligibility_reason TEXT,
      captured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (
        workspace_id, provider_id, provider_connection_id,
        external_capture_id, source_kind, source_revision
      )
    );

    CREATE INDEX IF NOT EXISTS meeting_capture_eligibility_watermarks_latest_idx
      ON meeting_capture_eligibility_watermarks (
        workspace_id, provider_id, provider_connection_id,
        external_capture_id, source_kind, source_revision DESC
      );

    -- A terminal privacy/policy withdrawal is a separate append-only fact.
    -- It must be able to fence a previously importable revision without
    -- rewriting that prior decision or its Human import audit record. Like the
    -- ordinary watermark, it retains no provider descriptors or source text.
    CREATE TABLE IF NOT EXISTS meeting_capture_terminal_eligibility_withdrawals (
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_connection_id TEXT NOT NULL,
      external_capture_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      content_hash TEXT NOT NULL,
      eligibility_reason TEXT NOT NULL CHECK (
        eligibility_reason IN ('private', 'policy')
      ),
      captured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (
        workspace_id, provider_id, provider_connection_id,
        external_capture_id, source_kind, source_revision,
        content_hash, eligibility_reason
      )
    );

    CREATE INDEX IF NOT EXISTS meeting_capture_terminal_eligibility_withdrawals_latest_idx
      ON meeting_capture_terminal_eligibility_withdrawals (
        workspace_id, provider_id, provider_connection_id,
        external_capture_id, source_kind, source_revision DESC, recorded_at DESC
      );

    -- An explicit Human import can admit only a matching withheld revision.
    -- The original provider eligibility remains immutable on the revision;
    -- this separate append-only record is the authorization that makes it
    -- available to the organizational binding layer.
    CREATE TABLE IF NOT EXISTS logical_meeting_capture_import_judgments (
      workspace_id TEXT NOT NULL,
      judgment_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_connection_id TEXT NOT NULL,
      external_capture_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      content_hash TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      actor_person_id TEXT NOT NULL,
      reason TEXT,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, judgment_id),
      UNIQUE (
        workspace_id, provider_id, provider_connection_id,
        external_capture_id, source_kind, source_revision
      )
    );

    -- Binding history is append-only. The separate head table makes the
    -- normal caller cheap while preserving Human correction provenance.
    CREATE TABLE IF NOT EXISTS logical_meeting_capture_binding_history (
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      logical_meeting_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'bound-high-confidence', 'candidate-match', 'ambiguous',
          'separate', 'human-bound'
        )
      ),
      origin TEXT NOT NULL CHECK (origin IN ('automatic', 'human')),
      match_evidence_json TEXT NOT NULL,
      -- Digest of normalized matching facts, never raw content or names.
      match_facts_digest TEXT,
      policy_version TEXT NOT NULL,
      supersedes_binding_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, binding_id),
      FOREIGN KEY (workspace_id, capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id),
      FOREIGN KEY (workspace_id, logical_meeting_id)
        REFERENCES logical_meetings (workspace_id, logical_meeting_id),
      FOREIGN KEY (workspace_id, supersedes_binding_id)
        REFERENCES logical_meeting_capture_binding_history (workspace_id, binding_id)
    );

    CREATE TABLE IF NOT EXISTS logical_meeting_capture_binding_heads (
      workspace_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, capture_id),
      FOREIGN KEY (workspace_id, capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id),
      FOREIGN KEY (workspace_id, binding_id)
        REFERENCES logical_meeting_capture_binding_history (workspace_id, binding_id)
    );

    CREATE INDEX IF NOT EXISTS logical_meeting_capture_binding_heads_meeting_idx
      ON logical_meeting_capture_binding_history (
        workspace_id, logical_meeting_id, created_at
      );

    -- Candidate assessments are durable audit material. A candidate is not
    -- membership and it cannot trigger an execution path in LUM-33.
    CREATE TABLE IF NOT EXISTS logical_meeting_match_assessments (
      workspace_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision > 0),
      candidate_logical_meeting_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('high-confidence', 'candidate')),
      evidence_json TEXT NOT NULL,
      match_facts_digest TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (
        workspace_id,
        capture_id,
        source_revision,
        candidate_logical_meeting_id
      ),
      FOREIGN KEY (workspace_id, capture_id, source_revision)
        REFERENCES meeting_capture_revisions (workspace_id, capture_id, source_revision),
      FOREIGN KEY (workspace_id, candidate_logical_meeting_id)
        REFERENCES logical_meetings (workspace_id, logical_meeting_id)
    );

    -- A Human separation has pairwise scope, so a later automatic matcher
    -- cannot recreate exactly the relation that was deliberately rejected.
    CREATE TABLE IF NOT EXISTS logical_meeting_capture_exclusions (
      workspace_id TEXT NOT NULL,
      left_capture_id TEXT NOT NULL,
      right_capture_id TEXT NOT NULL,
      human_judgment_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, left_capture_id, right_capture_id),
      CHECK (left_capture_id < right_capture_id),
      FOREIGN KEY (workspace_id, left_capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id),
      FOREIGN KEY (workspace_id, right_capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id)
    );

    CREATE TABLE IF NOT EXISTS logical_meeting_capture_binding_judgments (
      workspace_id TEXT NOT NULL,
      judgment_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      actor_person_id TEXT NOT NULL,
      judgment_type TEXT NOT NULL CHECK (
        judgment_type IN ('bind', 'make-separate')
      ),
      requested_logical_meeting_id TEXT NOT NULL,
      reason TEXT,
      observed_at TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, judgment_id),
      FOREIGN KEY (workspace_id, capture_id)
        REFERENCES meeting_captures (workspace_id, capture_id),
      FOREIGN KEY (workspace_id, requested_logical_meeting_id)
        REFERENCES logical_meetings (workspace_id, logical_meeting_id),
      FOREIGN KEY (workspace_id, binding_id)
        REFERENCES logical_meeting_capture_binding_history (workspace_id, binding_id)
    );

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

    ALTER TABLE follow_up_executions
      ADD COLUMN IF NOT EXISTS execution_lease_id TEXT;

    ALTER TABLE utterance_versions
      ADD COLUMN IF NOT EXISTS speaker_attribution_json TEXT;

    ALTER TABLE utterance_versions
      ALTER COLUMN speaker_id DROP NOT NULL;
  `);
  await migrateOrganizationalContext(database);
  await migrateAiAccountingRecovery(database);
  await migrateContextRetrieval(database);
  await migrateConversationConsultations(database);
  await migrateDecisionIntelligence(database);
  await migrateMeetingContext(database);
}
