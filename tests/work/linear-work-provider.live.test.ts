import { describe, expect, it } from "vitest";
import { createLinearWorkProviderFromEnv } from "../../src/work/linear-work-provider.js";

const liveLinearEnabled =
  process.env["LUMA_LIVE_LINEAR_TESTS"] === "1" &&
  Boolean(process.env["LINEAR_API_KEY"]) &&
  Boolean(process.env["LINEAR_TEAM_ID"]);

describe.skipIf(!liveLinearEnabled)("Linear WorkProvider live integration", () => {
  it("can search the configured Linear team without mutating it", async () => {
    const provider = createLinearWorkProviderFromEnv();
    const results = await provider.searchWorkItems({
      workspaceId: "workspace_live_test",
      text: "DAY",
      limit: 1
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.providerId ?? provider.providerId).toBe(provider.providerId);
  });
});
