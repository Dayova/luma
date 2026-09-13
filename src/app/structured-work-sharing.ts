import { createContextSharingPolicy } from "./context-sharing-policy.js";
import type { StructuredWorkConfiguration } from "../structured-work/structured-work.js";

/** Explicit protected team sharing, separate from the Linear service token's broad access. */
export async function createStructuredWorkSharingAccess(input: {
  workspaceId: string;
  policyPath: string;
  credentialScopeId: string;
  teamId: string;
}): Promise<StructuredWorkConfiguration["workAuthorization"]> {
  if (!input.credentialScopeId.trim() || !input.teamId.trim())
    throw new Error("Configure the exact work credential scope and team");
  const policy = createContextSharingPolicy({
    workspaceId: input.workspaceId,
    path: input.policyPath
  });
  await policy.validate();
  return {
    scopeId: input.credentialScopeId,
    resource: input.teamId,
    authorize: (audience) =>
      policy.authorize({
        audience,
        provider: "linear",
        credentialScopeId: input.credentialScopeId,
        resource: input.teamId
      })
  };
}
