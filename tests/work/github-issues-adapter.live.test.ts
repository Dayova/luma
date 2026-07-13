import { describe, expect, it } from "vitest";
import { createGitHubIssuesWorkProviderFromEnv } from "../../src/work/github-issues-adapter.js";

const githubAppConfigured =
  Boolean(process.env["GITHUB_APP_ID"]) &&
  Boolean(process.env["GITHUB_APP_INSTALLATION_ID"]) &&
  Boolean(
    process.env["GITHUB_APP_PRIVATE_KEY"] || process.env["GITHUB_APP_PRIVATE_KEY_BASE64"]
  );
const liveGitHubEnabled =
  process.env["LUMA_LIVE_GITHUB_TESTS"] === "1" &&
  Boolean(process.env["GITHUB_REPOSITORY"]) &&
  (githubAppConfigured || Boolean(process.env["GITHUB_TOKEN"]));

describe.skipIf(!liveGitHubEnabled)("GitHub Issues WorkProvider live integration", () => {
  it("can search the configured GitHub repository without leaking provider types", async () => {
    const provider = createGitHubIssuesWorkProviderFromEnv();

    const results = await provider.searchWorkItems({
      workspaceId: "workspace_live_test",
      text: "",
      limit: 1
    });

    expect(Array.isArray(results)).toBe(true);
  });
});
