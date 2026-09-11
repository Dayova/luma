import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { nativeNotionReviewConfig } from "../../src/app/native-notion-review-config.js";
import { createNativeNotionReviewMcp } from "../../src/app/native-notion-review-mcp.js";
import { ids } from "./native-notion-review-fixtures.js";

function env(): NodeJS.ProcessEnv {
  return {
    LUMA_NATIVE_REVIEW_ENABLED: "1",
    LUMA_NATIVE_NOTION_WORKSPACE_ID: ids.space,
    LUMA_NATIVE_NOTION_AGENT_ID: ids.agent,
    LUMA_NATIVE_NOTION_PAGE_ID: ids.page,
    LUMA_NATIVE_NOTION_AGENT_READ_TOKEN: "agent",
    LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN: "admin",
    LUMA_NATIVE_NOTION_READONLY_API_TOKEN: "page",
    LINEAR_READONLY_API_KEY: "linear-reader",
    LINEAR_TEAM_ID: "linear-team",
    LUMA_NATIVE_NOTION_CREDENTIAL_SCOPE_ID: "native-page-reader",
    LUMA_NATIVE_LINEAR_CREDENTIAL_SCOPE_ID: "native-linear-reader",
    LUMA_CONTEXT_SHARING_POLICY_PATH: "/etc/luma/sharing.json",
    LUMA_NATIVE_REVIEW_MCP_BEARER_TOKEN: "native-mcp-bearer-with-at-least-32-characters"
  };
}
describe("native Notion configuration and listener lifecycle", () => {
  it("requires explicit complete activation and separate logical/provider IDs and read credentials", () => {
    expect(nativeNotionReviewConfig({})).toBeUndefined();
    expect(nativeNotionReviewConfig(env())).toMatchObject({
      agentId: ids.agent,
      pageId: ids.page,
      hostname: "127.0.0.1",
      port: 3003
    });
  });
  it.each([
    "LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN",
    "LUMA_NATIVE_NOTION_AGENT_READ_TOKEN",
    "LUMA_NATIVE_NOTION_CREDENTIAL_SCOPE_ID",
    "LUMA_NATIVE_LINEAR_CREDENTIAL_SCOPE_ID",
    "LUMA_NATIVE_REVIEW_MCP_BEARER_TOKEN"
  ])("refuses missing %s without fallback", (key) => {
    const config = env();
    delete config[key];
    expect(() => nativeNotionReviewConfig(config)).toThrow();
  });
  it.each(["notion-writer", "linear-writer", "same-read-token", "invalid-port"])(
    "refuses %s",
    (kind) => {
      const config = env();
      if (kind === "notion-writer") config["NOTION_API_TOKEN"] = "page";
      if (kind === "linear-writer") config["LINEAR_API_KEY"] = "linear-reader";
      if (kind === "same-read-token")
        config["LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN"] = "agent";
      if (kind === "invalid-port") config["LUMA_NATIVE_REVIEW_HTTP_PORT"] = "NaN";
      expect(() => nativeNotionReviewConfig(config)).toThrow();
    }
  );
  it.each([
    "LUMA_DECISION_RECORDS_NOTION_API_TOKEN",
    "LUMA_SYNTHESIS_NOTION_API_TOKEN",
    "LUMA_STRUCTURED_WORK_NOTION_API_TOKEN"
  ])("refuses the separate %s writer as its native page reader", (key) => {
    const config = env();
    config[key] = config["LUMA_NATIVE_NOTION_READONLY_API_TOKEN"];
    expect(() => nativeNotionReviewConfig(config)).toThrow();
  });
  const runtime = () => ({
    review: () => Promise.reject(new Error("No source available")),
    requireCurrent: () => Promise.reject(new Error("No source available")),
    stop: () => Promise.resolve()
  });
  it("cannot leave a listening socket when stopped while start is pending", async () => {
    const http = createNativeNotionReviewMcp({
      runtime: runtime(),
      bearerToken: "0".repeat(32),
      port: 0
    });
    const start = http.start(),
      stop = http.stop();
    const address = await start;
    await stop;
    await expect(
      fetch(`http://127.0.0.1:${address.port}/notion/review/mcp`)
    ).rejects.toThrow();
    await expect(http.start()).rejects.toThrow();
  });
  it("closes a socket with incomplete headers during shutdown", async () => {
    const http = createNativeNotionReviewMcp({
      runtime: runtime(),
      bearerToken: "0".repeat(32),
      port: 0
    });
    const address = await http.start();
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("POST /notion/review/mcp HTTP/1.1\r\nHost: localhost\r\n");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await http.stop();
    await closed;
  });
});
