import { Client } from "@notionhq/client";
import { z } from "zod";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { ExternalReference } from "../domain/model.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";
import {
  parseMeetingSynthesisSection,
  renderMeetingSynthesisSection,
  synthesisDigest,
  synthesisRecordKey
} from "./meeting-synthesis-markdown.js";
import {
  MeetingSynthesisWriteNotAppliedError,
  type MeetingSynthesisPublication,
  type MeetingSynthesisPublicationReceipt,
  type MeetingSynthesisWriter
} from "./meeting-synthesis-writer.js";

export interface NotionMeetingSynthesisTransport {
  find(input: {
    dataSourceId: string;
    keyProperty: string;
    key: string;
  }): Promise<unknown>;
  readPage(pageId: string): Promise<unknown>;
  readMarkdown(pageId: string): Promise<unknown>;
  create(input: {
    dataSourceId: string;
    titleProperty: string;
    keyProperty: string;
    key: string;
    title: string;
    markdown: string;
  }): Promise<unknown>;
  insert(input: { pageId: string; markdown: string }): Promise<unknown>;
  replace(input: { pageId: string; before: string; after: string }): Promise<unknown>;
}
export function createNotionMeetingSynthesisWriter(config: {
  workspaceId: string;
  importedMeetingsDataSourceId: string;
  token: string;
  signingKey: string;
  titleProperty?: string;
  recordKeyProperty?: string;
  authorize(input: {
    audience: ContextAudience;
    target: { type: "document" | "data-source"; externalId: string };
  }): Promise<boolean>;
  transport?: NotionMeetingSynthesisTransport;
  /** HTTP dependency for production transport tests; credentials remain SDK-owned. */
  fetch?: typeof fetch;
}): MeetingSynthesisWriter {
  const dataSourceId = canonicalNotionObjectId(config.importedMeetingsDataSourceId);
  if (
    !dataSourceId ||
    !config.workspaceId.trim() ||
    !config.token.trim() ||
    Buffer.byteLength(config.signingKey) < 32
  )
    throw new Error("Meeting synthesis publication configuration is incomplete");
  const api = config.transport ?? sdk(config.token, config.fetch ?? fetch);
  const titleProperty = config.titleProperty ?? "Name",
    keyProperty = config.recordKeyProperty ?? "Luma Meeting ID";
  const checkPlan = (p: MeetingSynthesisPublication) => {
    if (
      p.workspaceId !== config.workspaceId ||
      p.audience.workspaceId !== config.workspaceId ||
      p.synthesis.workspaceId !== config.workspaceId ||
      p.logicalMeetingId !== p.synthesis.logicalMeetingId ||
      !p.audience.personIds.length ||
      new Set(p.audience.personIds).size !== p.audience.personIds.length ||
      !p.operationToken.trim()
    )
      throw new Error("Synthesis publication scope is invalid");
    const rendered = renderMeetingSynthesisSection(p, config.signingKey);
    if (
      synthesisDigest(
        parseMeetingSynthesisSection(rendered, config.signingKey)?.publication
      ) !== synthesisDigest(p)
    )
      throw new Error("Synthesis publication cannot roundtrip");
    return rendered;
  };
  const grant = async (
    p: MeetingSynthesisPublication,
    current: () => Promise<void>,
    pageId?: string
  ) => {
    await current();
    if (
      !(await config.authorize({
        audience: structuredClone(p.audience),
        target: pageId
          ? { type: "document", externalId: pageId }
          : { type: "data-source", externalId: dataSourceId }
      }))
    )
      throw new Error("Synthesis publication target is unavailable for its recipients");
    await current();
  };
  const read = async (
    p: MeetingSynthesisPublication,
    pageId: string,
    current: () => Promise<void>
  ) => {
    await grant(p, current, pageId);
    const before = page(await api.readPage(pageId), pageId);
    await grant(p, current, pageId);
    const body = z
      .object({
        object: z.literal("page_markdown"),
        id: z.string(),
        markdown: z.string().max(1_000_000),
        truncated: z.literal(false),
        unknown_block_ids: z.array(z.string()).length(0)
      })
      .parse(await api.readMarkdown(pageId));
    if (requiredId(body.id) !== pageId)
      throw new Error("Notion returned another page's Markdown");
    const markdown = body.markdown;
    await grant(p, current, pageId);
    const after = page(await api.readPage(pageId), pageId);
    await grant(p, current, pageId);
    if (synthesisDigest(before) !== synthesisDigest(after))
      throw new Error("Synthesis target changed during read");
    const owned = parseMeetingSynthesisSection(markdown, config.signingKey);
    if (
      owned &&
      (owned.publication.workspaceId !== p.workspaceId ||
        owned.publication.logicalMeetingId !== p.logicalMeetingId ||
        p.audience.personIds.some(
          (id) => !owned.publication.audience.personIds.includes(id)
        ))
    )
      throw new Error("Synthesis region belongs to another meeting or audience");
    return { reference: reference(after), markdown, owned };
  };
  const target = async (p: MeetingSynthesisPublication, current: () => Promise<void>) => {
    if (p.anchor) {
      if (p.anchor.providerId !== "notion" || p.anchor.objectType !== "document")
        throw new Error("Synthesis anchor provider is unsupported");
      const id = canonicalNotionObjectId(p.anchor.externalId);
      if (!id) throw new Error("Synthesis anchor is invalid");
      return read(p, id, current);
    }
    await grant(p, current);
    const matches = z
      .object({
        results: z.array(z.object({ object: z.literal("page"), id: z.string() })).max(2),
        has_more: z.literal(false),
        next_cursor: z.null()
      })
      .parse(
        await api.find({
          dataSourceId,
          keyProperty,
          key: synthesisRecordKey(p.workspaceId, p.logicalMeetingId)
        })
      );
    await grant(p, current);
    if (matches.results.length > 1)
      throw new Error("Multiple canonical imported records require review");
    const id = matches.results[0]?.id;
    if (!id) return null;
    const result = await read(p, requiredId(id), current);
    const metadata = page(await api.readPage(requiredId(id)), requiredId(id));
    await grant(p, current, requiredId(id));
    if (
      metadata.parent.type !== "data_source_id" ||
      canonicalNotionObjectId(metadata.parent.data_source_id) !== dataSourceId ||
      !result.owned
    )
      throw new Error("Imported Meeting Record is not owned in its configured location");
    return result;
  };
  const receipt = (
    p: MeetingSynthesisPublication,
    externalReference: ExternalReference
  ): MeetingSynthesisPublicationReceipt => ({
    externalReference,
    operationToken: p.operationToken,
    synthesisRevision: p.synthesis.revision,
    sourceSetDigest: p.synthesis.sourceSetDigest
  });
  const find = async (input: Parameters<MeetingSynthesisWriter["findPublished"]>[0]) => {
    const p = structuredClone(input.publication);
    checkPlan(p);
    const found = await target(p, input.requireCurrent);
    return found?.owned && synthesisDigest(found.owned.publication) === synthesisDigest(p)
      ? receipt(p, found.reference)
      : null;
  };
  return {
    providerId: "notion",
    findPublished: (input) => find(input),
    publish: async (input) => {
      const p = structuredClone(input.publication);
      let dispatched = false;
      try {
        const markdown = checkPlan(p);
        const found = await target(p, input.requireCurrent);
        if (
          found?.owned &&
          synthesisDigest(found.owned.publication) === synthesisDigest(p)
        ) {
          const result = receipt(p, found.reference);
          await input.recordApplied(result);
          return result;
        }
        await input.beforeWrite(found?.reference ?? null);
        await grant(p, input.requireCurrent, found?.reference.externalId);
        dispatched = true;
        let externalReference: ExternalReference;
        if (!found) {
          const created = page(
            await api.create({
              dataSourceId,
              titleProperty,
              keyProperty,
              key: synthesisRecordKey(p.workspaceId, p.logicalMeetingId),
              title: `Imported Meeting — ${p.synthesis.producedAt.slice(0, 10)}`,
              markdown: `# Imported Meeting Record\n\n${markdown}`
            })
          );
          if (
            created.parent.type !== "data_source_id" ||
            canonicalNotionObjectId(created.parent.data_source_id) !== dataSourceId
          )
            throw new Error("Created imported record has an unexpected parent");
          externalReference = reference(created);
        } else {
          const updated = found.owned
            ? await api.replace({
                pageId: found.reference.externalId,
                before: found.owned.section,
                after: markdown
              })
            : await api.insert({
                pageId: found.reference.externalId,
                markdown: `\n\n${markdown}`
              });
          const acknowledged = z
            .object({ object: z.literal("page_markdown"), id: z.string() })
            .parse(updated);
          if (requiredId(acknowledged.id) !== found.reference.externalId)
            throw new Error("Notion acknowledged another page");
          externalReference = found.reference;
        }
        const result = receipt(p, externalReference);
        await input.recordApplied(result);
        return result;
      } catch (error) {
        if (!dispatched) throw new MeetingSynthesisWriteNotAppliedError();
        // Mutation may have applied. The original durable plan is the only recovery target.
        throw error;
      }
    }
  };
}
const pageSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().url(),
  archived: z.literal(false),
  in_trash: z.literal(false),
  last_edited_time: z.string(),
  parent: z.discriminatedUnion("type", [
    z.object({ type: z.literal("data_source_id"), data_source_id: z.string() }),
    z.object({ type: z.literal("page_id"), page_id: z.string() }),
    z.object({ type: z.literal("workspace"), workspace: z.literal(true) })
  ])
});
function page(value: unknown, expectedId?: string) {
  const parsed = pageSchema.parse(value),
    id = requiredId(parsed.id);
  if (expectedId && id !== expectedId) throw new Error("Notion returned another page");
  const url = new URL(parsed.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/(^|\.)notion\.(so|site)$/u.test(url.hostname)
  )
    throw new Error("Notion returned an invalid page URL");
  return { ...parsed, id };
}
function reference(value: ReturnType<typeof page>): ExternalReference {
  return {
    providerId: "notion",
    objectType: "document",
    externalId: value.id,
    url: value.url
  };
}
function requiredId(value: string): string {
  const id = canonicalNotionObjectId(value);
  if (!id) throw new Error("Invalid Notion object identity");
  return id;
}
function sdk(
  token: string,
  fetchImplementation: typeof fetch
): NotionMeetingSynthesisTransport {
  const client = new Client({
    auth: token,
    notionVersion: "2026-03-11",
    timeoutMs: 20_000,
    retry: false,
    fetch: boundedFetch(fetchImplementation)
  });
  return {
    find: ({ dataSourceId, keyProperty, key }) =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        filter: { property: keyProperty, rich_text: { equals: key } },
        page_size: 2
      }),
    readPage: (pageId) => client.pages.retrieve({ page_id: pageId }),
    readMarkdown: (pageId) =>
      client.pages.retrieveMarkdown({ page_id: pageId, include_transcript: false }),
    create: ({ dataSourceId, titleProperty, keyProperty, key, title, markdown }) =>
      client.pages.create({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: {
          [titleProperty]: {
            type: "title",
            title: [{ type: "text", text: { content: title } }]
          },
          [keyProperty]: {
            type: "rich_text",
            rich_text: [{ type: "text", text: { content: key } }]
          }
        },
        markdown
      }),
    insert: ({ pageId, markdown }) =>
      client.pages.updateMarkdown({
        page_id: pageId,
        type: "insert_content",
        insert_content: { content: markdown, position: { type: "end" } }
      }),
    replace: ({ pageId, before, after }) =>
      client.pages.updateMarkdown({
        page_id: pageId,
        type: "update_content",
        update_content: {
          content_updates: [{ old_str: before, new_str: after }],
          allow_deleting_content: false
        }
      })
  };
}
/** Abort the actual request and bound streamed bodies; the SDK timeout alone only races headers. */
function boundedFetch(fetchImplementation: typeof fetch): typeof fetch {
  return async (request, init) => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Notion synthesis request timed out"));
      }, 15_000);
    });
    try {
      const response = await Promise.race([
        fetchImplementation(request, { ...init, signal: controller.signal }),
        timeout
      ]);
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1_000_000)
            throw new Error("Notion synthesis response exceeded its size bound");
          chunks.push(chunk.value);
        }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  };
}
