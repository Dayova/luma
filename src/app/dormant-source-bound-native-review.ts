import type { ReasoningModel } from "../ai/reasoning-model.js";
import { createWorkspaceBoundWorkCatalog } from "./workspace-bound-work-catalog.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { IdentityDirectory } from "../identity/interface.js";
import { createLedgerBackedImportedSourceVerifier } from "../knowledge/ledger-backed-imported-source-verifier.js";
import { createMeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import {
  createNotionObjectScopedMeetingNoteEvidenceSource,
  type NotionObjectScopedMeetingNoteEvidenceReader
} from "../knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import { createObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import type { OperationalOutcomeMarkerVerifier } from "../knowledge/operational-outcome-writer.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import {
  createSourceBoundNativeReview,
  type ExactMeetingNotePage,
  type SourceBoundNativeReview
} from "../native-review/source-bound-native-review.js";
import type { LumaDatabase } from "../persistence/db.js";
import {
  isIssuedLinearReadOnlyWorkCatalog,
  type LinearReadOnlyWorkCatalog
} from "../work/linear-read-only-work-catalog.js";

export type CreateDormantSourceBoundNativeReviewInput = {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  identityDirectory: IdentityDirectory;
  reasoningModel: ReasoningModel;
  /** A reader restricted to one configured Notion page; never a scan/search adapter. */
  reader: NotionObjectScopedMeetingNoteEvidenceReader;
  /**
   * Verifies that a marker on the configured source belongs to a completed
   * Luma settlement. The native ingress supplies its durable verifier rather
   * than allowing the source adapter to infer marker ownership structurally.
   */
  operationalOutcomeMarkerVerifier: OperationalOutcomeMarkerVerifier;
  /** Fixed provider/page binding for this dormant native-review surface. */
  page: ExactMeetingNotePage;
  /** Must come from LUM-19's nominal read-only catalog factories. */
  readOnlyWorkCatalog: LinearReadOnlyWorkCatalog;
  now?: () => Date;
};

export class DormantSourceBoundNativeReviewCompositionError extends Error {
  constructor(
    readonly code: "native-review-read-only-catalog-invalid",
    message: string
  ) {
    super(message);
    this.name = "DormantSourceBoundNativeReviewCompositionError";
  }
}

/**
 * Builds the future native Notion review as one deep, dormant Module. Its
 * returned Interface is deliberately only `review(...)`: callers cannot
 * choose a source root, catalog operation, Linear scope, or provider write.
 *
 * This is composition only. It does not read environment variables, start a
 * server, register an ingress, acquire credentials, or activate a provider.
 */
export function createDormantSourceBoundNativeReview(
  input: CreateDormantSourceBoundNativeReviewInput
): SourceBoundNativeReview {
  if (!isIssuedLinearReadOnlyWorkCatalog(input.readOnlyWorkCatalog)) {
    throw new DormantSourceBoundNativeReviewCompositionError(
      "native-review-read-only-catalog-invalid",
      "Dormant native review requires a catalog created by the dedicated Linear read-only factory"
    );
  }

  const ledger = createObservedSourceLedger({ database: input.database });
  const workCatalog = createWorkspaceBoundWorkCatalog({
    workspaceId: input.workspace.workspaceId,
    providerScopeId: input.readOnlyWorkCatalog.providerScopeId,
    workCatalog: input.readOnlyWorkCatalog
  });
  const meetingIntelligence = createMeetingIntelligence({
    database: input.database,
    reasoningModel: input.reasoningModel,
    workCatalogs: [workCatalog],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: workCatalog.providerId
    }),
    ...(input.now ? { now: input.now } : {})
  });
  const meetingNotesIngestion = createMeetingNotesIngestion({
    meetingIntelligence,
    workItemProviderId: workCatalog.providerId
  });
  const meetingNoteEvidenceSource = createNotionObjectScopedMeetingNoteEvidenceSource({
    workspaceId: input.workspace.workspaceId,
    providerId: input.page.providerId,
    pageId: input.page.pageId,
    reader: input.reader,
    operationalOutcomeMarkerVerifier: input.operationalOutcomeMarkerVerifier,
    ...(input.now ? { now: input.now } : {})
  });

  return createSourceBoundNativeReview({
    database: input.database,
    workspace: input.workspace,
    ledger,
    meetingIntelligence,
    meetingNotesIngestion,
    meetingNoteEvidenceSource,
    identityDirectory: input.identityDirectory,
    ...(input.now ? { now: input.now } : {})
  });
}
