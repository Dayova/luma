import { describe, expect, it, vi } from "vitest";
import { createGranolaMcpClient } from "../../src/granola/mcp-client.js";
import {
  granolaMeetingDocuments,
  requireGranolaReadTools
} from "../../src/granola/wire-format.js";
const credential = () =>
  Promise.resolve({
    accessToken: "fixture-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
function rpc(id: number, result: unknown, sse = false) {
  const data = JSON.stringify({ jsonrpc: "2.0", id, result });
  return new Response(sse ? `: heartbeat\n\ndata: ${data}\n\n` : data, {
    headers: {
      "content-type": sse ? "text/event-stream" : "application/json",
      "mcp-session-id": "fixture-session"
    }
  });
}
describe("read-only Granola Streamable HTTP", () => {
  it.each([false, true])(
    "negotiates a scoped authenticated session and reads %s responses without exposing a writer",
    async (sse) => {
      const calls: Array<{
        url: string;
        headers: Headers;
        body: Record<string, unknown>;
      }> = [];
      const client = createGranolaMcpClient({
        credential,
        fetch: (url, init) => {
          if (typeof url !== "string" || typeof init?.body !== "string")
            throw new Error("Expected literal endpoint and JSON body");
          const body = JSON.parse(init.body) as Record<string, unknown>;
          calls.push({ url, headers: new Headers(init?.headers), body });
          if (body["method"] === "initialize")
            return Promise.resolve(
              rpc(Number(body["id"]), { protocolVersion: "2025-03-26" }, sse)
            );
          if (body["method"] === "notifications/initialized")
            return Promise.resolve(new Response(null, { status: 202 }));
          return Promise.resolve(
            rpc(
              Number(body["id"]),
              { content: [{ type: "text", text: "Account Jakob; workspace Dayova" }] },
              sse
            )
          );
        }
      });
      expect(await client.call("get_account_info", {})).toMatchObject({
        content: [{ text: "Account Jakob; workspace Dayova" }]
      });
      expect(calls.map((call) => call.url)).toEqual(
        Array(3).fill("https://mcp.granola.ai/mcp")
      );
      expect(calls[2]!.headers.get("mcp-session-id")).toBe("fixture-session");
      expect(calls[2]!.headers.get("mcp-protocol-version")).toBe("2025-03-26");
      expect(calls[2]!.headers.get("authorization")).toBe("Bearer fixture-secret");
      expect(calls[2]!.body).toMatchObject({
        method: "tools/call",
        params: { name: "get_account_info", arguments: {} }
      });
      expect(calls.some((call) => JSON.stringify(call.body).includes("transcript"))).toBe(
        false
      );
    }
  );
  it("bounds stalled credential resolution without logging its contents", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>();
      const client = createGranolaMcpClient({
        credential: () => new Promise(() => undefined),
        timeoutMs: 20,
        fetch: fetcher
      });
      const pending = expect(client.tools()).rejects.toThrow("connection-unavailable");
      await vi.advanceTimersByTimeAsync(21);
      await pending;
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([401, 429, 302])(
    "reports safe status for HTTP %s without following redirects or returning provider text",
    async (status) => {
      const client = createGranolaMcpClient({
        credential,
        fetch: (_url, init) => {
          expect(init?.redirect).toBe("error");
          return Promise.resolve(
            new Response("PRIVATE SERVER ERROR fixture-secret", { status })
          );
        }
      });
      await expect(client.tools()).rejects.toThrow(
        status === 401
          ? "reauthentication-required"
          : status === 429
            ? "rate-limited"
            : "connection-unavailable"
      );
    }
  );
  it("refuses an unsolicited server request instead of treating it as source content", async () => {
    const client = createGranolaMcpClient({
      credential,
      fetch: () =>
        Promise.resolve(
          new Response(
            'data: {"jsonrpc":"2.0","id":9,"method":"sampling/createMessage"}\n\n',
            { headers: { "content-type": "text/event-stream" } }
          )
        )
    });
    await expect(client.tools()).rejects.toThrow("provider-shape-unsupported");
  });
});
describe("Granola's bounded provider shape", () => {
  it("does not silently accept incomplete, duplicate or error-shaped note material", () => {
    const result = (value: string) => ({ content: [{ type: "text", text: value }] });
    expect(() => granolaMeetingDocuments(result("rate limit exceeded"))).toThrow();
    expect(() =>
      granolaMeetingDocuments(result('<meeting id="one" title="Title" date="today">'))
    ).toThrow();
    const meeting =
      '<meeting id="one" title="Title" date="today"><summary>could do it</summary></meeting>';
    expect(() => granolaMeetingDocuments(result(meeting + meeting))).toThrow();
    expect(granolaMeetingDocuments(result(meeting))[0]).toMatchObject({
      date: "today",
      body: meeting,
      hasNotes: true
    });
  });
  it("requires live compatible tool capabilities instead of assuming a plan name guarantees them", () => {
    expect(() => requireGranolaReadTools([])).toThrow();
    expect(() =>
      requireGranolaReadTools([
        {
          name: "get_account_info",
          inputSchema: { type: "object", properties: {}, required: ["new_scope"] }
        }
      ])
    ).toThrow();
  });
});
