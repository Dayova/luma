import { describe, expect, it } from "vitest";
import { createLinearReadOnlyWorkCatalogFromEnv } from "../../src/work/linear-read-only-work-catalog.js";

const liveLinearReadOnlyEnabled =
  process.env["LUMA_LIVE_LINEAR_READONLY_TESTS"] === "1" &&
  Boolean(process.env["LINEAR_READONLY_API_KEY"]?.trim()) &&
  Boolean(process.env["LINEAR_TEAM_ID"]?.trim());

describe.skipIf(!liveLinearReadOnlyEnabled)(
  "Linear read-only Work Catalog live integration",
  () => {
    it("can run one bounded team-scoped search without mutating Linear", async () => {
      const catalog = createLinearReadOnlyWorkCatalogFromEnv();
      const results = await catalog.searchWorkItems({
        workspaceId: "workspace_live_test",
        text: "LUM",
        limit: 1
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results[0]?.providerId ?? catalog.providerId).toBe(catalog.providerId);
    });
  }
);
