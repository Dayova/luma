import type { WorkCatalog, WorkQuery } from "../work/interface.js";

export type CreateWorkspaceBoundWorkCatalogInput = {
  /** The logical Luma workspace accepted from Meeting Intelligence. */
  workspaceId: string;
  /** An opaque provider-owned scope used only by the delegated catalog. */
  providerScopeId: string;
  /** A read-only catalog; writer capabilities never enter the returned Interface. */
  workCatalog: WorkCatalog;
};

const directWriterMethodNames = [
  "createWorkItem",
  "findCreatedWorkItemByIdempotencyKey",
  "updateWorkItem",
  "updateWorkItemIfCurrent",
  "addComment"
] as const;

export class WorkspaceBoundWorkCatalogError extends Error {
  constructor(
    readonly code:
      | "workspace-bound-work-catalog-config-invalid"
      | "workspace-bound-work-catalog-workspace-mismatch"
      | "workspace-bound-work-catalog-writer-capability",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceBoundWorkCatalogError";
  }
}

/**
 * Binds Luma's logical workspace identifier to one opaque provider scope.
 * Callers retain the ordinary read-only WorkCatalog Interface; this module
 * owns the check and translation needed before provider delegation.
 */
export function createWorkspaceBoundWorkCatalog(
  input: CreateWorkspaceBoundWorkCatalogInput
): WorkCatalog {
  const workspaceId = requireNonBlank(input.workspaceId, "workspaceId");
  const providerScopeId = requireNonBlank(input.providerScopeId, "providerScopeId");
  const delegatedCatalog = input.workCatalog;

  rejectDirectWriterMethods(delegatedCatalog);

  return {
    providerId: delegatedCatalog.providerId,
    ...(delegatedCatalog.identityProviderId === undefined
      ? {}
      : { identityProviderId: delegatedCatalog.identityProviderId }),
    ...(delegatedCatalog.supportsConditionalUpdates === undefined
      ? {}
      : { supportsConditionalUpdates: delegatedCatalog.supportsConditionalUpdates }),
    async searchWorkItems(query) {
      assertLogicalWorkspace(query, workspaceId);

      return delegatedCatalog.searchWorkItems({
        ...query,
        workspaceId: providerScopeId
      });
    },
    getWorkItem: (id) => delegatedCatalog.getWorkItem(id)
  };
}

function assertLogicalWorkspace(query: WorkQuery, workspaceId: string): void {
  if (query.workspaceId !== workspaceId) {
    throw new WorkspaceBoundWorkCatalogError(
      "workspace-bound-work-catalog-workspace-mismatch",
      "Work Catalog search requires the configured logical Luma workspace"
    );
  }
}

function requireNonBlank(value: string, name: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new WorkspaceBoundWorkCatalogError(
      "workspace-bound-work-catalog-config-invalid",
      `${name} is required for a workspace-bound Work Catalog`
    );
  }

  return normalized;
}

function rejectDirectWriterMethods(catalog: WorkCatalog): void {
  // A deliberately narrowed catalog has no direct writer members. This does
  // not inspect closures such as toWorkCatalog; only visible capabilities are
  // part of this application's composition seam.
  if (directWriterMethodNames.some((method) => method in catalog)) {
    throw new WorkspaceBoundWorkCatalogError(
      "workspace-bound-work-catalog-writer-capability",
      "Workspace-bound Work Catalog does not accept direct writer methods"
    );
  }
}
