import { describe, expect, it } from "vitest";
import {
  ids,
  locator,
  people,
  providerHarness
} from "./native-notion-review-fixtures.js";

describe("actual Notion native request proof", () => {
  it("checks the audience again after reading the actual event", async () => {
    const h = providerHarness();
    let reads = 0;
    h.transform((kind, value) =>
      kind === "permissions" && ++reads === 2
        ? { permissions: h.permissions.permissions.slice(0, 3) }
        : value
    );
    await expect(h.createAccess().read(locator)).rejects.toMatchObject({
      code: "access-unavailable"
    });
    expect(h.requests).toHaveLength(4);
  });
  it("derives the founder and exact page from the provider event, never metadata or caller fields", async () => {
    const h = providerHarness();
    const result = await h.createAccess().read(locator);
    expect(result.actor.personId).toBe("person_jakob");
    expect(result.page.pageId).toBe(ids.page);
    expect(result.audience.personIds).toHaveLength(4);
    expect(h.requests.map((r) => r.options?.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET"
    ]);
    expect(h.requests[2]?.options?.body).toBe(
      JSON.stringify({
        filter: { property: "id", string: { equals: ids.event } },
        page_size: 2
      })
    );
    expect(h.requests[0]?.options?.headers).toMatchObject({
      Authorization: "Bearer admin-reader"
    });
    expect(h.requests[1]?.options?.headers).toMatchObject({
      Authorization: "Bearer agent-reader"
    });
  });
  it.each([
    "bot",
    "null",
    "guest",
    "different-session",
    "different-agent",
    "different-page",
    "quoted",
    "extra-text"
  ])("refuses %s as Human review authority", async (kind) => {
    const h = providerHarness();
    if (kind === "bot") h.event.created_by.type = "bot";
    if (kind === "guest") h.event.created_by.id = "90000000-0000-4000-8000-000000000000";
    if (kind === "null")
      h.transform((type, value) =>
        type === "events"
          ? {
              object: "list",
              type: "session_event",
              results: [{ ...h.event, created_by: null }],
              has_more: false,
              next_cursor: null
            }
          : value
      );
    if (kind === "different-session") h.event.session_id = ids.agent;
    if (kind === "different-agent") h.session.agent_id = ids.session;
    if (kind === "different-page")
      h.event.content[0]!.text = `Luma review https://www.notion.so/${ids.event}`;
    if (kind === "quoted")
      h.event.content[0]!.text = `Example: ${h.event.content[0]!.text}`;
    if (kind === "extra-text") h.event.content[0]!.text += " and create every task";
    await expect(h.createAccess().read(locator)).rejects.toMatchObject({
      code: "access-unavailable"
    });
  });
  it.each(["workspace", "group", "guest", "missing", "duplicate", "partial"])(
    "withholds private session reads for %s audience",
    async (kind) => {
      const h = providerHarness();
      h.transform((type, value) => {
        if (type !== "permissions") return value;
        if (kind === "partial") return { ...h.permissions, next_cursor: "more" };
        if (kind === "missing")
          return { permissions: h.permissions.permissions.slice(0, 3) };
        if (kind === "duplicate")
          return {
            permissions: [
              ...h.permissions.permissions.slice(0, 3),
              h.permissions.permissions[0]
            ]
          };
        return {
          permissions: [
            ...h.permissions.permissions.slice(0, 3),
            {
              principal:
                kind === "guest"
                  ? { type: "user", user_id: ids.event }
                  : { type: kind, group_id: ids.event },
              role: "full_access",
              resolved_role: "full_access"
            }
          ]
        };
      });
      await expect(h.createAccess().read(locator)).rejects.toMatchObject({
        code: "access-unavailable"
      });
      expect(h.requests).toHaveLength(1);
    }
  );
  it("revalidates original authorship and wording on every replay", async () => {
    const h = providerHarness(),
      access = h.createAccess();
    const original = await access.read(locator);
    h.event.created_by.id = people[1]!.notionUserId;
    await expect(access.requireCurrent(original)).rejects.toMatchObject({
      code: "access-unavailable"
    });
  });
  it.each(["network", "body", "cancel"])(
    "bounds stalled %s and does not print provider errors",
    async (kind) => {
      const h = providerHarness();
      h.override(() =>
        kind === "network"
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  pull: () => new Promise<void>(() => undefined),
                  cancel: () => new Promise<void>(() => undefined)
                }),
                { status: kind === "cancel" ? 403 : 200 }
              )
            )
      );
      await expect(h.createAccess(25).read(locator)).rejects.toMatchObject({
        code: "access-unavailable"
      });
    }
  );
});
