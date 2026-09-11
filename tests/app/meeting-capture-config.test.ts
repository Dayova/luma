import { describe, expect, it } from "vitest";
import { meetingCaptureRuntimeConfig } from "../../src/app/meeting-capture-config.js";

const target = "11111111-1111-4111-8111-111111111111";
function base(): NodeJS.ProcessEnv {
  return {
    LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED: "1",
    LUMA_GRANOLA_OAUTH_ENABLED: "1",
    OPENAI_API_KEY: "test-only",
    LUMA_SYNTHESIS_NOTION_API_TOKEN: "test-only",
    LUMA_SYNTHESIS_IMPORTED_MEETINGS_DATA_SOURCE_ID: target,
    LUMA_SYNTHESIS_CREDENTIAL_SCOPE_ID: "synthesis-writer",
    LUMA_SYNTHESIS_SIGNING_KEY: "test-only-stable-signing-key-over-32-bytes",
    LUMA_CONTEXT_SHARING_POLICY_PATH: "/protected/sharing.json"
  };
}
describe("capture capability startup selection", () => {
  it("permits a configured Granola onboarding source with no copied token or invented Notion source", () => {
    expect(meetingCaptureRuntimeConfig(base())).toEqual({
      granolaEnabled: true,
      publication: {
        importedMeetingsDataSourceId: target,
        credentialScopeId: "synthesis-writer",
        sharingPolicyPath: "/protected/sharing.json"
      }
    });
    expect(meetingCaptureRuntimeConfig({})).toBeUndefined();
  });
  it.each([
    ["LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED", "yes"],
    ["LUMA_GRANOLA_OAUTH_ENABLED", "yes"],
    ["LUMA_GRANOLA_OAUTH_ENABLED", "0"],
    ["LUMA_REASONING_MODEL_PROVIDER", "disabled"],
    ["LUMA_SYNTHESIS_IMPORTED_MEETINGS_DATA_SOURCE_ID", "not-a-destination"],
    ["LUMA_SYNTHESIS_CREDENTIAL_SCOPE_ID", ""],
    ["LUMA_SYNTHESIS_SIGNING_KEY", "short"],
    ["LUMA_SYNTHESIS_NOTION_API_TOKEN", ""],
    ["LUMA_CONTEXT_SHARING_POLICY_PATH", "relative.json"],
    ["OPENAI_API_KEY", ""],
    ["NOTION_API_TOKEN", "unscoped-old-token"]
  ])("refuses incomplete or incompatible %s before intake", (key, value) => {
    expect(() => meetingCaptureRuntimeConfig({ ...base(), [key]: value })).toThrow();
  });
  it("uses the stable actual datasource identity and the distinct read grant for Notion capture", () => {
    const env = {
      ...base(),
      LUMA_GRANOLA_OAUTH_ENABLED: "0",
      NOTION_API_TOKEN: "test-only-legacy-source",
      NOTION_MEETINGS_DATA_SOURCE_ID: target,
      LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
      LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "test-only-source-reader",
      LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "meeting-reader",
      LUMA_CONTEXT_NOTION_PAGE_IDS: "22222222-2222-4222-8222-222222222222"
    };
    expect(meetingCaptureRuntimeConfig(env)?.notion).toEqual({
      providerId: "notion",
      canonicalSourceScopeId: target,
      authorizationScopeId: "meeting-reader"
    });
  });
});
