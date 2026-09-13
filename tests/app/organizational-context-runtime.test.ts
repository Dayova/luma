import { describe, expect, it } from "vitest";
import { organizationalContextRuntimeConfig } from "../../src/app/organizational-context-runtime.js";

describe("organizational context runtime configuration", () => {
  it("keeps collection inactive until explicitly enabled", () => {
    expect(
      organizationalContextRuntimeConfig({
        LUMA_GITHUB_CODE_READONLY_TOKEN: "saved-but-inactive"
      })
    ).toBeUndefined();
    expect(
      organizationalContextRuntimeConfig({ LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "0" })
    ).toBeUndefined();
  });
  it.each([
    { LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "true" },
    { LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1" },
    {
      LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
      LUMA_CONTEXT_SHARING_POLICY_PATH: "relative.json"
    },
    {
      LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
      LUMA_CONTEXT_SHARING_POLICY_PATH: "/etc/luma/context.json"
    },
    {
      LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
      LUMA_CONTEXT_SHARING_POLICY_PATH: "/etc/luma/context.json",
      LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "secret-should-not-print"
    }
  ])("rejects incomplete configuration without disclosing credentials", (env) => {
    expect(() => organizationalContextRuntimeConfig(env)).toThrow(
      "complete dedicated read-only"
    );
    expect(() => organizationalContextRuntimeConfig(env)).not.toThrow(
      "secret-should-not-print"
    );
  });
  it("selects only complete independently configured provider groups", () => {
    expect(
      organizationalContextRuntimeConfig({
        LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
        LUMA_CONTEXT_SHARING_POLICY_PATH: "/etc/luma/context.json",
        LUMA_GITHUB_CODE_READONLY_TOKEN: "code-reader",
        LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID: "github-1",
        LUMA_GITHUB_CODE_REPOSITORIES: "Dayova/luma",
        LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "notion-reader",
        LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "notion-1",
        LUMA_CONTEXT_NOTION_PAGE_IDS: "00000000-0000-0000-0000-000000000001",
        LINEAR_API_KEY: "writer-never-used"
      })
    ).toEqual({ policyPath: "/etc/luma/context.json", providers: ["github", "notion"] });
  });
});
