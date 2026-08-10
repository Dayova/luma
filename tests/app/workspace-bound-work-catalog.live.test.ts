import { describe, expect, it } from "vitest";
import { createWorkspaceBoundWorkCatalog } from "../../src/app/workspace-bound-work-catalog.js";
import { createLinearReadOnlyWorkCatalogFromEnv } from "../../src/work/linear-read-only-work-catalog.js";

const liveLinearReadOnlyEnabled =
  process.env["LUMA_LIVE_LINEAR_READONLY_TESTS"] === "1" &&
  Boolean(process.env["LINEAR_READONLY_API_KEY"]?.trim()) &&
  Boolean(process.env["LINEAR_TEAM_ID"]?.trim());
const liveLogicalWorkspaceId =
  process.env["LUMA_WORKSPACE_ID"]?.trim() || "workspace_dayova";
const liveProviderScopeId = process.env["LINEAR_TEAM_ID"]?.trim() ?? "";

describe.skipIf(!liveLinearReadOnlyEnabled)(
  "workspace-bound Linear read-only Work Catalog live integration",
  () => {
    it("accepts the logical Luma workspace while delegating one bounded search to Linear's team scope", async () => {
      const catalog = createWorkspaceBoundWorkCatalog({
        workspaceId: liveLogicalWorkspaceId,
        providerScopeId: liveProviderScopeId,
        workCatalog: createLinearReadOnlyWorkCatalogFromEnv()
      });
      const results = await catalog.searchWorkItems({
        workspaceId: liveLogicalWorkspaceId,
        text: "LUM",
        limit: 1
      });

      expect(results.length).toBeLessThanOrEqual(1);
      for (const item of results) {
        expect(item.providerId).toBe(catalog.providerId);
        expect(item.externalId).not.toHaveLength(0);
      }
    });
  }
);
