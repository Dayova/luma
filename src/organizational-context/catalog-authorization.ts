import type { ContextAudience } from "./interface.js";

/** An explicit Dayova sharing grant, separate from integration-token readability.
 * The host checks the actual recipient set and the credential's configured scope.
 */
export type ContextCatalogAuthorization = (input: {
  audience: ContextAudience;
  credentialScopeId: string;
  source:
    | { provider: "notion"; pageId: string }
    | { provider: "linear"; teamId: string; issueId?: string };
}) => Promise<boolean>;

export function validCatalogIdentity(value: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/u.test(value);
}

export function validCatalogAudience(
  audience: ContextAudience,
  workspaceId: string
): boolean {
  return (
    audience.workspaceId === workspaceId &&
    audience.personIds.length > 0 &&
    audience.personIds.length <= 100 &&
    audience.personIds.every((id) => typeof id === "string" && id.trim().length > 0)
  );
}
