import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeNotionReviewMcp } from "../../src/app/native-notion-review-mcp.js";
import { createNotionNativeReviewAccess } from "../../src/knowledge/notion-native-review-access.js";
import {
  ids,
  locator,
  people,
  providerHarness,
  workspace
} from "./native-notion-review-fixtures.js";

const now = new Date("2026-09-11T12:01:00.000Z");
const windowStart = "2026-09-04T12:01:00.000Z";
function eventId(index: number) {
  return `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
function sessionId(index: number) {
  return `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
function harness(timeoutMs = 1000) {
  const original = providerHarness();
  const requests: Array<{
    path: string;
    options: RequestInit | undefined;
    body: unknown;
  }> = [];
  const sessions = [
    {
      ...original.session,
      updated_at: original.event.created_at,
      title: "PRIVATE SESSION TITLE"
    }
  ];
  const events: unknown[] = [structuredClone(original.event)];
  let sessionMore = false,
    eventMore = false;
  let transform: (
    kind: "permissions" | "sessions" | "events",
    value: unknown
  ) => unknown = (_, value) => value;
  let intercept: ((path: string) => Promise<Response> | undefined) | undefined;
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    ).pathname;
    const body: unknown =
      typeof options?.body === "string" ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    const overridden = intercept?.(path);
    if (overridden) return overridden;
    if (path === `/admin/v1/spaces/${ids.space}/agents/${ids.agent}/permissions`)
      return Response.json(transform("permissions", original.permissions));
    if (path === "/v1/sessions/query")
      return Response.json(
        transform("sessions", {
          object: "list",
          type: "session",
          results: sessions,
          has_more: sessionMore,
          next_cursor: sessionMore ? "more-sessions" : null
        })
      );
    if (/^\/v1\/sessions\/[a-f0-9-]+\/events\/query$/u.test(path))
      return Response.json(
        transform("events", {
          object: "list",
          type: "session_event",
          results: events,
          has_more: eventMore,
          next_cursor: eventMore ? "more-events" : null
        })
      );
    throw new Error("Unexpected native request");
  };
  const access = createNotionNativeReviewAccess({
    workspaceId: workspace.workspaceId,
    notionWorkspaceId: ids.space,
    agentId: ids.agent,
    pageId: ids.page,
    agentReadToken: "agent-reader",
    adminReadToken: "admin-reader",
    identityDirectory: original.directory,
    accessPolicy: original.accessPolicy,
    fetch: fetcher,
    now: () => now,
    timeoutMs
  });
  return {
    access,
    original,
    requests,
    sessions,
    events,
    transform(fn: typeof transform) {
      transform = fn;
    },
    intercept(fn: NonNullable<typeof intercept>) {
      intercept = fn;
    },
    more() {
      sessionMore = true;
      eventMore = true;
    }
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mcp(h: ReturnType<typeof harness>) {
  const runtime = {
    review: vi.fn(() =>
      Promise.reject(new Error("Discovery must not invoke MI or paid analysis"))
    ),
    requireCurrent: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve())
  };
  const listener = createNativeNotionReviewMcp({
    runtime,
    discovery: h.access.discovery,
    bearerToken: "x".repeat(32),
    port: 0
  });
  const address = await listener.start();
  cleanups.push(() => listener.stop());
  const call = async (method: string, params?: unknown, token = "x".repeat(32)) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/notion/review/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params })
      })
    });
    return { response, body: await response.text() };
  };
  return { listener, runtime, call };
}

describe("real native review request discovery", () => {
  it("discovers real founder locators through the official bounded queries without exposing session text", async () => {
    const h = harness();
    const proof = await h.access.discovery.discover();
    expect(proof.result).toEqual({
      requests: [
        { ...locator, actorLabel: "Jakob", createdAt: h.original.event.created_at }
      ],
      coverage: {
        complete: true,
        windowStart,
        windowEnd: now.toISOString(),
        limitations: []
      }
    });
    expect(JSON.stringify(proof.result)).not.toContain("PRIVATE");
    expect(h.requests.find((r) => r.path === "/v1/sessions/query")?.body).toEqual({
      filter: {
        and: [
          { property: "agent_id", string: { equals: ids.agent } },
          { property: "updated_at", timestamp: { on_or_after: windowStart } }
        ]
      },
      sorts: [{ property: "updated_at", direction: "descending" }],
      page_size: 5
    });
    expect(h.requests.find((r) => r.path.endsWith("/events/query"))?.body).toEqual({
      filter: {
        and: [
          { property: "type", event_type: { equals: "user.message" } },
          { property: "created_at", timestamp: { on_or_after: windowStart } },
          { property: "created_at", timestamp: { on_or_before: now.toISOString() } }
        ]
      },
      sorts: [{ property: "sequence", direction: "descending" }],
      page_size: 20
    });
    // The tool run itself updates an active session. It must not erase its original event.
    h.sessions[0]!.updated_at = "2026-09-11T12:02:00.000Z";
    await proof.requireCurrent();
    expect(
      h.requests.every(
        (r) => r.options?.method === (r.path.includes("/permissions") ? "GET" : "POST")
      )
    ).toBe(true);
  });

  it.each([
    { created_by: null },
    { created_by: { type: "bot", id: people[0]!.notionUserId } },
    { created_by: { type: "user", id: "70000000-0000-4000-8000-000000000000" } },
    {
      content: [
        { type: "text", text: `Please quote: Luma review https://notion.so/${ids.page}` }
      ]
    },
    { content: [{ type: "text", text: `Luma review https://notion.so/${ids.agent}` }] },
    {
      content: [
        {
          type: "text",
          text: `Luma review https://notion.so/${ids.page}\nAlso change the tasks`
        }
      ]
    },
    { content: [{ type: "file", url: "https://example.com/private" }] }
  ])("excludes unrelated or unauthored provider content %#", async (change) => {
    const h = harness();
    h.events.push({ ...h.original.event, id: eventId(1), ...change });
    const found = await h.access.discovery.discover();
    expect(found.result.requests).toHaveLength(1);
    await found.requireCurrent();
  });

  it.each(["guest", "missing", "group"])(
    "checks exact audience before any session read: %s",
    async (kind) => {
      const h = harness();
      h.transform((type, value) =>
        type === "permissions"
          ? {
              permissions:
                kind === "missing"
                  ? h.original.permissions.permissions.slice(1)
                  : [
                      ...h.original.permissions.permissions,
                      {
                        principal: {
                          type: kind === "group" ? "group" : "user",
                          user_id: ids.event
                        },
                        role: "edit",
                        resolved_role: "edit"
                      }
                    ]
            }
          : value
      );
      await expect(h.access.discovery.discover()).rejects.toMatchObject({
        code: "access-unavailable"
      });
      expect(h.requests).toHaveLength(1);
    }
  );

  it.each(["agent", "session", "old", "duplicate", "inconsistent-page"])(
    "withholds malformed discovery scope: %s",
    async (kind) => {
      const h = harness();
      if (kind === "agent") h.sessions[0]!.agent_id = ids.page;
      if (kind === "session")
        h.events[0] = { ...h.original.event, session_id: sessionId(2) };
      if (kind === "old")
        h.events[0] = { ...h.original.event, created_at: "2026-08-01T12:00:00.000Z" };
      if (kind === "duplicate") h.events.push(h.original.event);
      if (kind === "inconsistent-page")
        h.transform((type, value) =>
          type === "sessions"
            ? {
                object: "list",
                type: "session",
                results: [],
                has_more: true,
                next_cursor: null
              }
            : value
        );
      await expect(h.access.discovery.discover()).rejects.toMatchObject({
        code: "access-unavailable"
      });
    }
  );

  it("reports actual pagination/result bounds and keeps multiple requests distinct", async () => {
    const h = harness();
    h.more();
    h.events.splice(
      0,
      1,
      ...Array.from({ length: 11 }, (_, index) => ({
        ...h.original.event,
        id: eventId(index),
        sequence: index + 1
      }))
    );
    const found = await h.access.discovery.discover();
    expect(found.result.requests).toHaveLength(10);
    expect(new Set(found.result.requests.map((r) => r.eventId)).size).toBe(10);
    expect(found.result.coverage).toMatchObject({
      complete: false,
      limitations: ["session-limit", "event-limit", "result-limit"]
    });
    expect(h.requests.filter((r) => r.path.includes("/events/query"))).toHaveLength(1);
    await found.requireCurrent();
  });

  it("empty results only claim completeness inside the stated recent window", async () => {
    const h = harness();
    h.sessions.splice(0);
    const found = await h.access.discovery.discover();
    expect(found.result).toEqual({
      requests: [],
      coverage: {
        complete: true,
        windowStart,
        windowEnd: now.toISOString(),
        limitations: []
      }
    });
    expect(h.requests.some((r) => r.path.includes("events"))).toBe(false);
    await found.requireCurrent();
  });

  it("rejects ACL loss at the final discovery fence", async () => {
    const h = harness();
    let acl = 0;
    h.transform((type, value) =>
      type === "permissions" && ++acl === 2 ? { permissions: [] } : value
    );
    await expect(h.access.discovery.discover()).rejects.toMatchObject({
      code: "access-unavailable"
    });
  });

  it.each(["author", "wording", "membership"])(
    "revalidates exact original matches before delivery: %s",
    async (kind) => {
      const h = harness();
      const found = await h.access.discovery.discover();
      if (kind === "author")
        h.events[0] = {
          ...h.original.event,
          created_by: { type: "user", id: people[1]!.notionUserId }
        };
      if (kind === "wording")
        h.events[0] = {
          ...h.original.event,
          content: [
            { type: "text", text: `Luma review https://app.notion.com/${ids.page}` }
          ]
        };
      if (kind === "membership") h.original.permissions.permissions.pop();
      await expect(found.requireCurrent()).rejects.toMatchObject({
        code: "access-unavailable"
      });
    }
  );

  it("retains true provider completion after a deadline and refuses new discovery while stopping", async () => {
    const h = harness(20);
    let release!: (value: Response) => void;
    h.intercept((path) =>
      path === "/v1/sessions/query"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : undefined
    );
    await expect(h.access.discovery.discover()).rejects.toMatchObject({
      code: "access-unavailable"
    });
    let stopped = false;
    const stop = h.access.discovery.stop().then(() => {
      stopped = true;
    });
    await expect(h.access.discovery.discover()).rejects.toMatchObject({
      code: "stopped"
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release(
      Response.json({
        object: "list",
        type: "session",
        results: [],
        has_more: false,
        next_cursor: null
      })
    );
    await stop;
    expect(stopped).toBe(true);
  });

  it("serves authenticated MCP discovery with zero model/review calls and rejects claimed identities", async () => {
    const h = harness();
    const server = await mcp(h);
    const list = await server.call("tools/list");
    expect(list.body).toContain("find_review_requests");
    expect(list.body).not.toContain("from Notion Activity");
    const forged = await server.call("tools/call", {
      name: "find_review_requests",
      arguments: { personId: "person_jakob" }
    });
    expect(forged.body).toContain('"code":-32602');
    expect(h.requests).toHaveLength(0);
    const unauthorized = await server.call(
      "tools/call",
      { name: "find_review_requests", arguments: {} },
      "wrong"
    );
    expect(unauthorized.response.status).toBe(401);
    expect(h.requests).toHaveLength(0);
    const actual = await server.call("tools/call", {
      name: "find_review_requests",
      arguments: {}
    });
    expect(actual.body).toContain(ids.event);
    expect(actual.body).toContain("Jakob");
    expect(actual.body).toContain('"isError":false');
    expect(server.runtime.review).not.toHaveBeenCalled();
    expect(server.runtime.requireCurrent).not.toHaveBeenCalled();
    expect(h.requests.filter((r) => r.path === "/v1/sessions/query")).toHaveLength(2);
  });

  it("withholds MCP locators when the last current-audience proof is revoked", async () => {
    const h = harness();
    let acl = 0;
    h.transform((kind, value) =>
      kind === "permissions" && ++acl === 4 ? { permissions: [] } : value
    );
    const server = await mcp(h);
    const actual = await server.call("tools/call", {
      name: "find_review_requests",
      arguments: {}
    });
    expect(actual.body).toContain('"isError":true');
    expect(actual.body).not.toContain(ids.event);
    expect(server.runtime.review).not.toHaveBeenCalled();
  });
});
