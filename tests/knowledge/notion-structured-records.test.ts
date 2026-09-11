import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNotionStructuredRecords,
  type NotionStructuredRecordsConfig,
  type NotionStructuredTarget
} from "../../src/knowledge/notion-structured-records.js";
import { StructuredRecordNotAppliedError } from "../../src/knowledge/structured-records.js";
import type { StructuredRecordCreate } from "../../src/domain/structured-work.js";
import {
  audience,
  directory,
  sourceFixture,
  title,
  structuredWorkFixture,
  workspace,
  subject
} from "../structured-work/fixture.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const dataSourceId = "a24ae3d7-6a62-4b4a-9f01-b56668cd550c";
  const nativeSchema: Record<string, Record<string, unknown>> = {
    Hypothesis: { id: "title", name: "Hypothesis", type: "title", title: {} },
    "Evidence so far": {
      id: "evidence",
      name: "Evidence so far",
      type: "rich_text",
      rich_text: {}
    },
    Status: {
      id: "status",
      name: "Status",
      type: "select",
      select: {
        options: [
          { id: "to-validate", name: "To validate" },
          { id: "supported", name: "Supported" }
        ]
      }
    },
    Source: { id: "source", name: "Source", type: "rich_text", rich_text: {} },
    Owner: { id: "owner", name: "Owner", type: "people", people: {} },
    "Related work": { id: "work", name: "Related work", type: "url", url: {} }
  };
  const target: NotionStructuredTarget = {
    key: "hypotheses",
    label: "Product Hypotheses & Validation",
    dataSourceId,
    titleField: "hypothesis",
    fields: {
      hypothesis: { property: "Hypothesis", type: "text", required: true },
      evidence: { property: "Evidence so far", type: "text" },
      status: { property: "Status", type: "choice", required: true }
    },
    defaults: { status: { type: "choice", value: "To validate" } },
    sourceProperty: "Source",
    ownerProperty: "Owner",
    workLinkProperty: "Related work",
    active: { property: "Status", values: ["To validate"] }
  };
  type NativePage = {
    object: "page";
    id: string;
    url: string;
    last_edited_time: string;
    parent: { type: "data_source_id"; data_source_id: string };
    properties: Record<string, Record<string, unknown>>;
    archived: boolean;
    in_trash: boolean;
  };
  const pages = new Map<string, NativePage>(),
    blocks = new Map<string, unknown[]>();
  let grants = true,
    partial = false,
    loseAck = false,
    forgedStamp = false;
  const calls: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }> = [];
  const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(typeof init.body === "string" ? init.body : "null") as Record<
          string,
          unknown
        >)
      : null;
    calls.push({ path, method, body });
    const answer = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    if (path === `/v1/data_sources/${dataSourceId}`)
      return answer({
        object: "data_source",
        id: dataSourceId,
        properties: nativeSchema
      });
    if (path === `/v1/data_sources/${dataSourceId}/query`)
      return answer({
        results: [...pages.values()],
        has_more: partial,
        next_cursor: partial ? "next" : null
      });
    if (path === "/v1/pages" && method === "POST") {
      const id = `f7438a01-d47d-41cf-8861-${String(pages.size + 1).padStart(12, "0")}`;
      const submitted = body!["properties"] as Record<string, Record<string, unknown>>;
      const properties: NativePage["properties"] = {};
      for (const [name, definition] of Object.entries(nativeSchema)) {
        const type = String(definition["type"]);
        const value = submitted[String(definition["id"])];
        const empty =
          type === "rich_text" || type === "title" || type === "people" ? [] : null;
        properties[name] = { id: definition["id"], type, [type]: value?.[type] ?? empty };
      }
      const page: NativePage = {
        object: "page",
        id,
        url: `https://notion.so/${id}`,
        last_edited_time: "2026-09-11T10:00:00.000Z",
        parent: body!["parent"] as NativePage["parent"],
        properties,
        archived: false,
        in_trash: false
      };
      pages.set(id, page);
      blocks.set(id, body!["children"] as unknown[]);
      if (loseAck) throw new Error("Acknowledgement lost after create");
      return answer(page);
    }
    const read = /^\/v1\/pages\/([^/]+)$/u.exec(path);
    if (read && pages.has(read[1]!)) return answer(pages.get(read[1]!));
    const children = /^\/v1\/blocks\/([^/]+)\/children$/u.exec(path);
    if (children && blocks.has(children[1]!))
      return answer({
        results: forgedStamp ? [] : blocks.get(children[1]!),
        has_more: false,
        next_cursor: null
      });
    throw new Error(`Unexpected native request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", api);
  const authorize = vi.fn<NotionStructuredRecordsConfig["authorize"]>(() =>
    Promise.resolve(grants)
  );
  const config = {
    apiToken: `fake-notion-${Math.random()}`,
    credentialScopeId: "original-hypotheses-scope",
    signingKey: "a".repeat(32),
    targets: [target],
    identityDirectory: directory,
    authorize
  };
  const make = () => createNotionStructuredRecords(config);
  const provider = make();
  const seed = (id: string) => {
    const values: Record<string, unknown> = {
      Hypothesis: [{ text: { content: `${title}: ${id}` } }],
      "Evidence so far": [{ text: { content: "Original private evidence" } }],
      Status: { name: "To validate" },
      Source: [],
      Owner: [],
      "Related work": null
    };
    const page: NativePage = {
      object: "page",
      id,
      url: `https://notion.so/${id}`,
      last_edited_time: "2026-09-11T10:00:00.000Z",
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: Object.fromEntries(
        Object.entries(nativeSchema).map(([name, definition]) => [
          name,
          {
            id: definition["id"],
            type: definition["type"],
            [String(definition["type"])]: values[name]
          }
        ])
      ),
      archived: false,
      in_trash: false
    };
    pages.set(id, page);
    return page;
  };
  const plan = async () => {
    const expected = await provider.inspect({ audience, targetKey: target.key });
    const draft: StructuredRecordCreate = {
      schema: expected.schema,
      fields: {
        hypothesis: { type: "text", value: title },
        evidence: { type: "text", value: "Fabius reports variable learning times." },
        status: { type: "choice", value: "To validate" }
      },
      source: sourceFixture(),
      ownerPersonId: "jakob",
      relatedWork: {
        providerId: "linear",
        objectType: "work-item",
        externalId: "DAY-1",
        url: "https://linear.app/dayova/issue/DAY-1"
      }
    };
    return { expected, draft };
  };
  return {
    provider,
    make,
    plan,
    calls,
    pages,
    blocks,
    nativeSchema,
    config,
    authorize,
    target,
    seed,
    loseAck: () => {
      loseAck = true;
    },
    partial: () => {
      partial = true;
    },
    revoke: () => {
      grants = false;
    },
    forge: () => {
      forgedStamp = true;
    }
  };
}
describe("Actual Notion structured record schema, write and recovery", () => {
  it("bounds a stalled external grant and never starts a late native request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.authorize.mockImplementation(() => new Promise<boolean>(() => undefined));
    const pending = f.provider.inspect({ audience, targetKey: f.target.key });
    const refused = expect(pending).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(240000);
    await refused;
    expect(f.calls).toHaveLength(0);
  });
  it("introspects the real schema and creates one row with original Evidence, mapped owner and related work", async () => {
    const f = fixture();
    const { expected, draft } = await f.plan();
    expect(
      expected.schema.fields.find((field) => field.key === "status")?.choices
    ).toEqual(["To validate", "Supported"]);
    const current = vi.fn(() => Promise.resolve());
    const created = await f.provider.create({
      audience,
      draft,
      expected,
      operationId: "operation-1",
      requireCurrent: current
    });
    expect(created.fields).toEqual(draft.fields);
    expect(created.active).toBe(true);
    expect(f.pages.size).toBe(1);
    const write = f.calls.find(
      (call) => call.method === "POST" && call.path === "/v1/pages"
    )!;
    expect(write.body!["parent"]).toEqual({
      type: "data_source_id",
      data_source_id: f.target.dataSourceId
    });
    expect(write.body!["properties"]).toMatchObject({
      owner: { people: [{ id: "notion-jakob" }] },
      work: { url: draft.relatedWork!.url }
    });
    expect(JSON.stringify(write.body!["children"])).toContain(
      "So should I validate the hypothesis now?"
    );
    expect(current).toHaveBeenCalled();
    const recovered = await f
      .make()
      .findCreated({ audience, draft, operationId: "operation-1" });
    expect(recovered?.reference.externalId).toBe(created.reference.externalId);
    expect(
      f.calls.filter((call) => call.path === "/v1/pages" && call.method === "POST")
    ).toHaveLength(1);
  });
  it("recovers a lost native create acknowledgement positively after recreation, without another POST", async () => {
    const f = fixture();
    const { expected, draft } = await f.plan();
    f.loseAck();
    await expect(
      f.provider.create({
        audience,
        draft,
        expected,
        operationId: "uncertain",
        requireCurrent: () => Promise.resolve()
      })
    ).rejects.toThrow();
    expect(
      (await f.make().findCreated({ audience, draft, operationId: "uncertain" }))?.fields
    ).toEqual(draft.fields);
    expect(f.pages.size).toBe(1);
    expect(f.calls.filter((call) => call.path === "/v1/pages")).toHaveLength(1);
  });
  it.each(["schema", "choice", "grant", "source", "new-record"])(
    "refuses %s changes before dispatch",
    async (change) => {
      const f = fixture();
      const { expected, draft } = await f.plan();
      if (change === "schema") f.nativeSchema["Hypothesis"]!["type"] = "rich_text";
      if (change === "choice")
        draft.fields["status"] = { type: "choice", value: "Invented result" };
      if (change === "grant") f.revoke();
      if (change === "new-record")
        await f.provider.create({
          audience,
          draft,
          expected,
          operationId: "human-concurrent",
          requireCurrent: () => Promise.resolve()
        });
      const writes = f.calls.filter((call) => call.path === "/v1/pages").length;
      await expect(
        f.provider.create({
          audience,
          draft,
          expected,
          operationId: "refused",
          requireCurrent: () =>
            change === "source"
              ? Promise.reject(new Error("revoked source"))
              : Promise.resolve()
        })
      ).rejects.toBeInstanceOf(StructuredRecordNotAppliedError);
      expect(f.calls.filter((call) => call.path === "/v1/pages")).toHaveLength(writes);
    }
  );
  it("never uses incomplete discovery, a missing signed marker, changed ownership or changed source as positive recovery", async () => {
    const f = fixture();
    const { expected, draft } = await f.plan();
    await f.provider.create({
      audience,
      draft,
      expected,
      operationId: "original",
      requireCurrent: () => Promise.resolve()
    });
    const changed = structuredClone(draft);
    changed.source.contentHash = "different-original";
    expect(
      await f.provider.findCreated({ audience, draft: changed, operationId: "original" })
    ).toBeNull();
    f.pages.values().next().value!.properties["Owner"]!["people"] = [
      { id: "notion-fabius" }
    ];
    expect(
      await f.provider.findCreated({ audience, draft, operationId: "original" })
    ).toBeNull();
    f.forge();
    expect(
      await f.provider.findCreated({ audience, draft, operationId: "original" })
    ).toBeNull();
    f.partial();
    await expect(
      f.provider.findCreated({ audience, draft, operationId: "original" })
    ).rejects.toThrow("incomplete");
  });
  it("executes the provided conversation through actual MI, native Notion and actual Linear provider, preserving both known results after a lost Linear ack", async () => {
    const native = fixture();
    const database = await createPgliteDatabase();
    try {
      const f = structuredWorkFixture(database);
      f.configuration.records = native.provider;
      f.loseWork();
      const { mi, execution } = f.make();
      const planned = await mi.observe(f.request);
      expect(planned.state).toBe("validated");
      const command = {
        workspace,
        subject,
        structuredWorkRequestId: planned.requestId,
        intentId: planned.approvedIntentId!
      };
      const result = await execution.execute(command);
      expect(result.state).toBe("partially-executed");
      expect(native.pages.size).toBe(1);
      expect(f.work.size).toBe(1);
      const restarted = f.make();
      expect((await restarted.execution.recover(command)).state).toBe("completed");
      expect(
        native.calls.filter((call) => call.path === "/v1/pages" && call.method === "POST")
      ).toHaveLength(1);
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.interpret).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });
});

describe("Retained structured catalog read authorization", () => {
  const firstId = "25d42c24-6707-4c5c-a607-24b3be3cd011";
  const secondId = "25d42c24-6707-4c5c-a607-24b3be3cd012";
  const prepare = async () => {
    const f = fixture();
    f.seed(firstId);
    f.seed(secondId);
    const snapshot = await f.provider.inspect({ audience, targetKey: f.target.key });
    return {
      ...f,
      input: { audience, snapshot, authorizationScopeId: f.provider.authorizationScopeId }
    };
  };

  it("keeps original history readable after content edits and new rows without asserting currentness", async () => {
    const f = await prepare();
    const original = f.pages.get(firstId)!;
    original.properties["Evidence so far"]!["rich_text"] = [
      { text: { content: "Human corrected the evidence" } }
    ];
    original.properties["Status"]!["select"] = { name: "Supported" };
    original.last_edited_time = "2026-09-11T11:00:00.000Z";
    f.seed("25d42c24-6707-4c5c-a607-24b3be3cd013");
    const before = f.calls.length;
    await expect(f.provider.requireReadable(f.input)).resolves.toBeUndefined();
    expect(f.calls.slice(before)).toHaveLength(3);
    expect(
      f.calls.slice(before).filter((call) => call.path.startsWith("/v1/pages/"))
    ).toHaveLength(0);
    expect(f.calls.some((call) => call.path === "/v1/pages")).toBe(false);
    await expect(f.provider.requireCurrent(f.input)).rejects.toThrow("changed");
    expect(f.pages.size).toBe(3);
    expect(f.input.snapshot.records[0]!.fields["evidence"]).toEqual({
      type: "text",
      value: "Original private evidence"
    });
  });

  it("reproves all 100 original rows with three native reads in a complete catalog", async () => {
    const f = fixture();
    for (let index = 0; index < 100; index++)
      f.seed(`25d42c24-6707-4c5c-a607-${String(index).padStart(12, "0")}`);
    const snapshot = await f.provider.inspect({ audience, targetKey: f.target.key });
    const before = f.calls.length;
    await f.provider.requireReadable({
      audience,
      snapshot,
      authorizationScopeId: f.provider.authorizationScopeId
    });
    expect(f.calls.slice(before)).toHaveLength(3);
    expect(
      f.calls.slice(before).filter((call) => call.path.endsWith("/query"))
    ).toHaveLength(1);
    expect(
      f.calls.slice(before).filter((call) => call.path.startsWith("/v1/pages"))
    ).toHaveLength(0);
  });

  it("uses exact original references when later additions make native discovery partial", async () => {
    const f = await prepare();
    f.partial();
    const before = f.calls.length;
    await f.provider.requireReadable(f.input);
    expect(f.calls.slice(before)).toHaveLength(5);
    expect(
      f.calls.slice(before).filter((call) => call.path.startsWith("/v1/pages/"))
    ).toHaveLength(2);
    f.pages.get(firstId)!.parent.data_source_id = "changed-parent";
    await expect(f.provider.requireReadable(f.input)).rejects.toThrow("moved");
  });

  it.each(["credential", "target", "same-id-mapping"])(
    "refuses an original preview under a replacement %s scope before provider reads",
    async (change) => {
      const f = await prepare();
      if (change === "credential") f.config.credentialScopeId = "replacement-scope";
      if (change === "target")
        f.config.targets[0]!.dataSourceId = "f17710bd-6fef-4b80-9cb9-732df14a3325";
      if (change === "same-id-mapping")
        f.config.targets[0]!.fields["evidence"]!.property = "Source";
      const replaced = f.make();
      expect(replaced.authorizationScopeId).not.toBe(f.input.authorizationScopeId);
      const before = f.calls.length;
      await expect(replaced.requireReadable(f.input)).rejects.toThrow("scope changed");
      expect(f.calls).toHaveLength(before);
    }
  );

  it("preserves the scope for token rotation in the same configured trust boundary", async () => {
    const f = await prepare();
    f.config.apiToken = "rotated-test-credential";
    const recreated = f.make();
    expect(recreated.authorizationScopeId).toBe(f.input.authorizationScopeId);
    await expect(recreated.requireReadable(f.input)).resolves.toBeUndefined();
  });

  it.each(["parent", "unselected-row"])(
    "withholds a catalog-derived preview when the %s grant is revoked",
    async (change) => {
      const f = await prepare();
      f.authorize.mockImplementation((request) =>
        Promise.resolve(
          change === "parent"
            ? request.objectType !== "data-source"
            : request.externalId !== secondId
        )
      );
      await expect(f.provider.requireReadable(f.input)).rejects.toThrow(
        "original audience"
      );
      expect(f.calls.some((call) => call.path === "/v1/pages")).toBe(false);
    }
  );

  it("rechecks earlier row grants after later row reads", async () => {
    const f = await prepare();
    let firstRevoked = false;
    f.authorize.mockImplementation((request) => {
      if (request.externalId === secondId) firstRevoked = true;
      return Promise.resolve(!(firstRevoked && request.externalId === firstId));
    });
    await expect(f.provider.requireReadable(f.input)).rejects.toThrow(
      "original audience"
    );
  });

  it.each(["removed", "moved", "archived", "identity", "schema"])(
    "refuses %s original records without treating replacement or current listing as proof",
    async (change) => {
      const f = await prepare();
      const page = f.pages.get(secondId)!;
      if (change === "removed") f.pages.delete(secondId);
      if (change === "moved") page.parent.data_source_id = "another-table";
      if (change === "archived") page.archived = true;
      if (change === "identity") page.url = "https://notion.so/another-record";
      if (change === "schema") f.nativeSchema["Evidence so far"]!["id"] = "new-id";
      await expect(f.provider.requireReadable(f.input)).rejects.toThrow();
      expect(f.calls.some((call) => call.path === "/v1/pages")).toBe(false);
    }
  );

  it("rechecks the original parent for an empty contributing catalog", async () => {
    const f = fixture();
    const snapshot = await f.provider.inspect({ audience, targetKey: f.target.key });
    f.revoke();
    await expect(
      f.provider.requireReadable({
        audience,
        snapshot,
        authorizationScopeId: f.provider.authorizationScopeId
      })
    ).rejects.toThrow("original audience");
  });
});
