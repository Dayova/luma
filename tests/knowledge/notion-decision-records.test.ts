import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNotionDecisionRecords,
  type NotionDecisionTransport
} from "../../src/knowledge/notion-decision-records.js";
import type { DecisionWriteStage } from "../../src/domain/decision-records.js";
import { DecisionWriteNotAppliedError } from "../../src/knowledge/decision-records.js";
import { decisionRecord } from "./decision-record-fixture.js";

const dataSourceId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
const firstPageId = "3d52e872-28bf-80ae-befe-d1c0e2c39df5";
const secondPageId = "3d52e872-28bf-81f9-8d79-c1233431c8bd";
const audience = decisionRecord().source.audience;
function fixture() {
  const pages = new Map<string, { parent: string; markdown: string; version: string }>();
  let targetGranted = true;
  let sourceGranted = true;
  let authorityGranted = true;
  let uncertainCreate = false;
  const mutationLog: string[] = [];
  const hooks: { beforeList?: () => Promise<void>; afterCreate?: () => void } = {};
  const transport: NotionDecisionTransport = {
    async list() {
      await hooks.beforeList?.();
      return {
        object: "list",
        results: [...pages.keys()].map((id) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null
      };
    },
    readPage(id) {
      const page = pages.get(id);
      if (!page) return Promise.reject(new Error("missing"));
      return Promise.resolve({
        object: "page",
        id,
        url: `https://notion.so/${id}`,
        archived: false,
        in_trash: false,
        last_edited_time: page.version,
        parent: { type: "data_source_id", data_source_id: page.parent }
      });
    },
    readMarkdown(id) {
      return Promise.resolve({
        object: "page_markdown",
        id,
        markdown: pages.get(id)?.markdown ?? "",
        truncated: false,
        unknown_block_ids: []
      });
    },
    create(input) {
      mutationLog.push("create");
      const id = pages.size === 0 ? firstPageId : secondPageId;
      pages.set(id, {
        parent: input.dataSourceId,
        markdown: input.markdown,
        version: "2026-09-11T10:01:00Z"
      });
      hooks.afterCreate?.();
      return uncertainCreate
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve({ object: "page", id });
    },
    replace(input) {
      mutationLog.push("replace");
      const page = pages.get(input.pageId)!;
      if (page.markdown.split(input.before).length !== 2)
        return Promise.reject(new Error("conflict"));
      page.markdown = page.markdown.replace(input.before, input.after);
      page.version = "2026-09-11T10:02:00Z";
      return Promise.resolve({});
    }
  };
  const config = {
    workspaceId: "dayova",
    dataSourceId,
    token: "test-only-token",
    signingKey: "test-only-signing-key-with-more-than-32-bytes",
    authorize: (input: { audience: typeof audience }) =>
      Promise.resolve(
        targetGranted &&
          input.audience.personIds.every((person) => audience.personIds.includes(person))
      ),
    authorizeRetainedSource: () => Promise.resolve(sourceGranted),
    authorizeRetainedAuthority: () => Promise.resolve(authorityGranted),
    now: () => new Date("2026-09-11T10:03:00Z")
  };
  const make = () => createNotionDecisionRecords({ ...config, transport });
  return {
    config,
    make,
    records: make(),
    pages,
    transport,
    mutationLog,
    hooks,
    denyTarget: () => {
      targetGranted = false;
    },
    allowTarget: () => {
      targetGranted = true;
    },
    denySource: () => {
      sourceGranted = false;
    },
    denyAuthority: () => {
      authorityGranted = false;
    },
    loseCreateResponse: () => {
      uncertainCreate = true;
    }
  };
}
const createInput = () => ({
  audience,
  stage: { type: "create-record", record: decisionRecord() } satisfies DecisionWriteStage,
  operationId: "approved-create-unique"
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("canonical Notion Decision Records", () => {
  it("retains literal region-marker text as evidence without making its own write unrecoverable", async () => {
    const f = fixture();
    const request = createInput();
    const text =
      "Quoted `luma-decision-record:start:v1` and `luma-decision-record:end:v1` are just evidence.";
    request.stage.record.source.evidence[0]!.text = text;
    request.stage.record.candidate.statement.text = text;
    const receipt = await f.records.write(request);
    expect(receipt.record.content.source.evidence[0]!.text).toBe(text);
    expect(receipt.record.content.candidate.statement.text).toBe(text);
    expect(await f.make().findWritten(request)).toEqual(receipt);
    expect(f.mutationLog).toEqual(["create"]);
  });
  it("retains a recoverable native toggle through documented empty-line normalization and escaped prose", async () => {
    const f = fixture();
    const create = f.transport.create.bind(f.transport);
    f.transport.create = async (input) => {
      const result = await create(input);
      const page = f.pages.get(firstPageId)!;
      if (
        !page.markdown.includes(
          "<summary>Evidence and revision history</summary>\n\n\t```json\n\t{"
        )
      )
        throw new Error("Notion requires indented toggle children");
      page.markdown = page.markdown
        .split("\n")
        .filter((line) => line !== "")
        .join("\n");
      return result;
    };
    const request = createInput();
    request.stage.record.candidate.statement.text =
      "Budget $30; x^2 < limit > 0 & history stays.";
    const receipt = await f.records.write(request);
    expect(receipt.record.content).toEqual(request.stage.record);
    expect(f.pages.get(firstPageId)!.markdown).toContain(
      "Budget \\$30; x\\^2 \\< limit \\> 0 & history stays."
    );
    const content = structuredClone(receipt.record.content);
    content.candidate.statement.text = "The approved budget remains $30.";
    const amended = await f.records.write({
      audience,
      operationId: "normalized-amend",
      stage: { type: "amend-record", target: receipt.record, record: content }
    });
    expect(amended.record.content.candidate.statement.text).toBe(
      content.candidate.statement.text
    );
    expect(f.mutationLog).toEqual(["create", "replace"]);
  });
  it("withholds retained ownership evidence after its own source grant is revoked", async () => {
    const f = fixture();
    const request = createInput();
    const created = await f.records.write(request);
    f.denyAuthority();
    expect(
      await f.records.read({ audience, recordId: created.record.content.id })
    ).toBeNull();
    expect((await f.records.discover({ audience, limit: 100 })).complete).toBe(false);
    await expect(f.records.findWritten(request)).rejects.toThrow();
    await expect(f.records.write(request)).rejects.toBeInstanceOf(
      DecisionWriteNotAppliedError
    );
    expect(f.mutationLog).toEqual(["create"]);
  });
  it("creates one canonical record, replays the exact operation and rediscovers it after recreation", async () => {
    const f = fixture();
    const input = createInput();
    const receipt = await f.records.write(input);
    expect(receipt.record.content).toEqual(input.stage.record);
    expect(await f.make().findWritten(input)).toEqual(receipt);
    expect(await f.make().write(input)).toEqual(receipt);
    expect(
      (await f.make().read({ audience, recordId: input.stage.record.id }))?.content
    ).toEqual(input.stage.record);
    expect(f.mutationLog).toEqual(["create"]);
    expect((await f.records.discover({ audience, limit: 10 })).complete).toBe(true);
  });
  it("does not resend an uncertain create and recovers only its exact signed operation", async () => {
    const f = fixture();
    f.loseCreateResponse();
    const input = createInput();
    await expect(f.records.write(input)).rejects.toThrow("unknown");
    expect(await f.make().findWritten(input)).toMatchObject({
      operationId: input.operationId
    });
    const changed = structuredClone(input);
    changed.stage.record.candidate.statement.text = "Changed decision";
    expect(await f.make().findWritten(changed)).toBeNull();
    await expect(f.records.write(changed)).rejects.toBeInstanceOf(
      DecisionWriteNotAppliedError
    );
    expect(f.mutationLog).toEqual(["create"]);
  });
  it("amends only the exact current owned section and preserves unrelated notes and original history", async () => {
    const f = fixture();
    const original = await f.records.write(createInput());
    const page = f.pages.get(firstPageId)!;
    page.markdown += "\n\n## Human note\nKeep this unrelated note.";
    const current = (await f.records.read({
      audience,
      recordId: original.record.content.id
    }))!;
    const content = structuredClone(current.content);
    content.candidate.statement.text = "Luma remains internal; revisit support later.";
    const stale = {
      audience,
      operationId: "amend-stale",
      stage: {
        type: "amend-record",
        target: original.record,
        record: content
      } satisfies DecisionWriteStage
    };
    await expect(f.records.write(stale)).rejects.toBeInstanceOf(
      DecisionWriteNotAppliedError
    );
    const amended = await f.records.write({
      ...stale,
      operationId: "amend-current",
      stage: { ...stale.stage, target: current }
    });
    expect(amended.record.content.candidate.statement.text).toBe(
      content.candidate.statement.text
    );
    expect(page.markdown).toContain("Keep this unrelated note.");
    expect(page.markdown).toContain(original.record.content.candidate.statement.text);
    expect(f.mutationLog).toEqual(["create", "replace"]);
  });
  it("publishes a pending successor, retires its predecessor and activates only after the backlink is proven", async () => {
    const f = fixture();
    const original = await f.records.write(createInput());
    const successor = decisionRecord("decision-successor");
    successor.status = "pending";
    successor.supersedes = [original.record.reference];
    successor.candidate.statement.text = "Pause the wider rollout.";
    successor.candidate.disposition = "pause";
    const pending = await f.records.write({
      audience,
      operationId: "successor-create",
      stage: { type: "create-record", record: successor }
    });
    const activation = {
      audience,
      operationId: "successor-activate",
      stage: {
        type: "activate-record",
        target: pending.record
      } satisfies DecisionWriteStage
    };
    await expect(f.records.write(activation)).rejects.toBeInstanceOf(
      DecisionWriteNotAppliedError
    );
    const retired = await f.records.write({
      audience,
      operationId: "original-retire",
      stage: {
        type: "retire-record",
        target: original.record,
        status: "reversed",
        successor: pending.record.reference
      }
    });
    expect(retired.record.content).toMatchObject({
      status: "reversed",
      supersededBy: pending.record.reference
    });
    const active = await f.records.write(activation);
    expect(active.record.content).toMatchObject({
      status: "active",
      candidate: { disposition: "pause" }
    });
    expect(
      (await f.records.read({ audience, recordId: original.record.content.id }))?.content
        .status
    ).toBe("reversed");
    expect(f.mutationLog).toEqual(["create", "create", "replace", "replace"]);
  });
  it.each([
    "rendered text",
    "signed evidence",
    "parent",
    "source grant",
    "target grant",
    "original audience"
  ])("withholds %s changes from discovery, reads and mutation", async (kind) => {
    const f = fixture();
    const original = await f.records.write(createInput());
    const page = f.pages.get(firstPageId)!;
    if (kind === "rendered text")
      page.markdown = page.markdown.replace("## Decision", "## Replaced");
    if (kind === "signed evidence")
      page.markdown = page.markdown.replace(
        '"modality":"final-decision"',
        '"modality":"proposal"'
      );
    if (kind === "parent") page.parent = secondPageId;
    if (kind === "source grant") f.denySource();
    if (kind === "target grant") f.denyTarget();
    const recipients =
      kind === "original audience" ? { ...audience, personIds: ["guest"] } : audience;
    expect(
      (await f.records.discover({ audience: recipients, limit: 100 })).complete
    ).toBe(false);
    expect(
      await f.records.read({ audience: recipients, recordId: original.record.content.id })
    ).toBeNull();
    await expect(
      f.records.write({
        ...createInput(),
        audience: recipients,
        operationId: "repeat-as-new"
      })
    ).rejects.toBeInstanceOf(DecisionWriteNotAppliedError);
    expect(f.mutationLog).toEqual(["create"]);
  });
  it("does not expose a positive result after source access changes during publication", async () => {
    const f = fixture();
    f.hooks.afterCreate = f.denyTarget;
    await expect(f.records.write(createInput())).rejects.toThrow("unknown");
    f.allowTarget();
    expect(await f.make().findWritten(createInput())).toMatchObject({
      operationId: createInput().operationId
    });
    expect(f.mutationLog).toEqual(["create"]);
  });
  it("stops at its deadline and never dispatches a late mutation after a stalled discovery returns", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.hooks.beforeList = () => held;
    const pending = expect(f.records.write(createInput())).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_001);
    await pending;
    release();
    await vi.runAllTimersAsync();
    expect(f.mutationLog).toEqual([]);
  });
  it("uses the pinned SDK's scoped discovery, create and exact-region update without auxiliary writes", async () => {
    const f = fixture();
    const requests: { path: string; method: string; body: Record<string, unknown> }[] =
      [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (init?.body && typeof init.body !== "string")
        throw new Error("Expected the native SDK to encode a JSON request body");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      requests.push({ path: url.pathname, method, body });
      let result: unknown;
      if (url.pathname === `/v1/data_sources/${dataSourceId}/query`)
        result = await f.transport.list(dataSourceId);
      else if (url.pathname === "/v1/pages" && method === "POST")
        result = await f.transport.create({
          dataSourceId,
          titleProperty: "title",
          title: "Decision",
          markdown: String(body["markdown"])
        });
      else if (url.pathname.endsWith("/markdown") && method === "PATCH") {
        const updates = body["update_content"] as {
          content_updates: { old_str: string; new_str: string }[];
        };
        result = await f.transport.replace({
          pageId: firstPageId,
          before: updates.content_updates[0]!.old_str,
          after: updates.content_updates[0]!.new_str
        });
      } else if (url.pathname.endsWith("/markdown"))
        result = await f.transport.readMarkdown(firstPageId);
      else result = await f.transport.readPage(firstPageId);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const records = createNotionDecisionRecords(f.config);
    const original = await records.write(createInput());
    const content = structuredClone(original.record.content);
    content.candidate.statement.text = "Keep internal, with a later review.";
    await records.write({
      audience,
      operationId: "sdk-amend",
      stage: { type: "amend-record", target: original.record, record: content }
    });
    expect(
      requests.filter(
        (request) => request.method === "POST" && request.path === "/v1/pages"
      )
    ).toHaveLength(1);
    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      path: `/v1/pages/${firstPageId}/markdown`,
      body: {
        type: "update_content",
        update_content: {
          allow_deleting_content: false,
          content_updates: [{ replace_all_matches: false }]
        }
      }
    });
    expect(f.mutationLog).toEqual(["create", "replace"]);
  });
});
