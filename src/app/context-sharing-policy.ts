import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ContextAudience } from "../organizational-context/interface.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import { dayovaFounderPersonIds } from "./founder-access.js";

const grantSchema = z
  .object({
    provider: z.enum(["notion", "linear", "github-code"]),
    credentialScopeId: z.string().trim().min(1).max(128),
    resources: z.array(z.string().trim().min(1).max(256)).min(1).max(100),
    personIds: z.array(z.enum(dayovaFounderPersonIds)).min(1).max(4)
  })
  .strict();
const policySchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().trim().min(1).max(256),
    grants: z.array(grantSchema).max(32)
  })
  .strict();
export type ContextSharingPolicyDocument = z.infer<typeof policySchema>;
export type ContextSharingRequest = {
  audience: ContextAudience;
  provider: "notion" | "linear" | "github-code";
  credentialScopeId: string;
  resource: string;
};

/** Explicit sanctioned sharing, separate from the service credential's provider access. */
export function createContextSharingPolicy(input: { path: string; workspaceId: string }) {
  if (!isAbsolute(input.path) || !input.workspaceId.trim()) throw invalidPolicy();
  const read = async (): Promise<ContextSharingPolicyDocument> => {
    try {
      const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        const uid = process.geteuid?.();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 65_536 ||
          (stat.mode & 0o022) !== 0 ||
          (stat.uid !== 0 && stat.uid !== uid)
        )
          throw invalidPolicy();
        const policy = policySchema.parse(
          JSON.parse(await file.readFile("utf8")) as unknown
        );
        if (policy.workspaceId !== input.workspaceId) throw invalidPolicy();
        for (const grant of policy.grants) {
          if (new Set(grant.personIds).size !== grant.personIds.length)
            throw invalidPolicy();
          if (
            grant.provider === "notion" &&
            grant.resources.some((resource) => !canonicalNotionObjectId(resource))
          )
            throw invalidPolicy();
        }
        return policy;
      } finally {
        await file.close();
      }
    } catch {
      throw invalidPolicy();
    }
  };
  return {
    async validate(): Promise<void> {
      await read();
    },
    async authorize(request: ContextSharingRequest): Promise<boolean> {
      if (
        request.audience.workspaceId !== input.workspaceId ||
        !request.audience.personIds.length ||
        request.audience.personIds.some(
          (id) => !(dayovaFounderPersonIds as readonly string[]).includes(id)
        )
      )
        return false;
      try {
        const policy = await read();
        return policy.grants.some(
          (grant) =>
            grant.provider === request.provider &&
            grant.credentialScopeId === request.credentialScopeId &&
            grant.resources.some((resource) =>
              sameResource(grant.provider, resource, request.resource)
            ) &&
            request.audience.personIds.every((id) =>
              (grant.personIds as readonly string[]).includes(id)
            )
        );
      } catch {
        return false;
      }
    }
  };
}
function sameResource(
  provider: ContextSharingRequest["provider"],
  left: string,
  right: string
): boolean {
  if (provider === "notion")
    return (
      canonicalNotionObjectId(left) !== null &&
      canonicalNotionObjectId(left) === canonicalNotionObjectId(right)
    );
  return left === right;
}
function invalidPolicy(): Error {
  return new Error(
    "Organizational context requires a valid, protected sharing-policy file for this workspace."
  );
}
