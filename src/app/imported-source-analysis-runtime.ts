import type {
  ImportedSourceAnalysisConfiguration,
  ImportedSourceHistoryAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import { createGrantedImportedSourceAnalysisAccess } from "../knowledge/granted-imported-source-analysis-access.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import { createNotionObjectScopedMeetingNoteEvidenceReader } from "../knowledge/notion-object-scoped-meeting-note-evidence-reader.js";
import { createNotionObjectScopedMeetingNoteEvidenceSource } from "../knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import type { OperationalOutcomeMarkerVerifier } from "../knowledge/operational-outcome-writer.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";
import { organizationalContextRuntimeConfig } from "./organizational-context-runtime.js";
import { dayovaFounderPersonIds } from "./founder-access.js";

/** Reuses explicit source grants and separately issued read-only Notion credentials. */
export function importedSourceAnalysisFromEnv(input: {
  workspaceId: string;
  env: NodeJS.ProcessEnv;
  ledger: ObservedSourceLedger;
  operationalOutcomeMarkerVerifier: OperationalOutcomeMarkerVerifier;
}):
  | (ImportedSourceAnalysisConfiguration & { access: ImportedSourceHistoryAccess })
  | undefined {
  const config = organizationalContextRuntimeConfig(input.env);
  if (!config?.providers.includes("notion")) return undefined;
  const token = input.env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"]!.trim();
  const providerId = input.env["LUMA_NOTION_PROVIDER_ID"]?.trim() || "notion";
  const credentialScopeId = input.env["LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID"]!.trim();
  const pages = new Set(
    input.env["LUMA_CONTEXT_NOTION_PAGE_IDS"]!.split(",").map((value) =>
      canonicalNotionObjectId(value.trim())
    )
  );
  if (!pages.size || pages.has(null))
    throw new Error("Imported Meeting analysis requires exact Notion page UUIDs.");
  const policy = createContextSharingPolicy({
    path: config.policyPath,
    workspaceId: input.workspaceId
  });
  return {
    audience: (workspaceId) =>
      Promise.resolve(
        workspaceId === input.workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      ),
    access: createGrantedImportedSourceAnalysisAccess({
      ledger: input.ledger,
      authorize: ({ source, audience }) => {
        const pageId = canonicalNotionObjectId(source.parentObjectId);
        return source.providerId === providerId && pageId && pages.has(pageId)
          ? policy.authorize({
              audience,
              provider: "notion",
              credentialScopeId,
              resource: pageId
            })
          : Promise.resolve(false);
      },
      evidenceSource: (source) => {
        const pageId = canonicalNotionObjectId(source.parentObjectId);
        if (source.providerId !== providerId || !pageId || !pages.has(pageId))
          return null;
        return createNotionObjectScopedMeetingNoteEvidenceSource({
          workspaceId: input.workspaceId,
          providerId,
          pageId,
          reader: createNotionObjectScopedMeetingNoteEvidenceReader({
            pageId,
            readOnlyApiToken: token
          }),
          operationalOutcomeMarkerVerifier: input.operationalOutcomeMarkerVerifier
        });
      }
    })
  };
}
