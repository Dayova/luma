import type { LumaDatabase } from "../persistence/db.js";

export async function migrateContextRetrieval(database: LumaDatabase): Promise<void> {
  await database.exec(`
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_request_json TEXT;
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_receipt_id TEXT;
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS context_binding_hash TEXT;
    -- A completed paid result can be retained without ever becoming deliverable.
    ALTER TABLE context_inquiries ADD COLUMN IF NOT EXISTS result_is_deliverable BOOLEAN NOT NULL DEFAULT TRUE;
  `);
}
