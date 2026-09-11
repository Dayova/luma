import { Client } from "@notionhq/client";
import { z } from "zod";
import type {
  CanonicalDecisionRecord,
  DecisionAudience,
  DecisionAuthoritySnapshot,
  DecisionCatalogSnapshot,
  DecisionRecordContent,
  DecisionSource,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";
import {
  decisionAudienceSchema,
  decisionWriteStageSchema
} from "../domain/decision-record-schemas.js";
import {
  DecisionWriteNotAppliedError,
  type DecisionRecords
} from "./decision-records.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";
import {
  decisionDigest,
  parseNotionDecisionRecord,
  renderNotionDecisionRecord,
  type DecisionRecordArchive
} from "./notion-decision-record-format.js";

export type NotionDecisionTransport = {
  list(dataSourceId: string, cursor?: string): Promise<unknown>;
  readPage(pageId: string): Promise<unknown>;
  readMarkdown(pageId: string): Promise<unknown>;
  create(input: {
    dataSourceId: string;
    titleProperty: string;
    title: string;
    markdown: string;
  }): Promise<unknown>;
  replace(input: { pageId: string; before: string; after: string }): Promise<unknown>;
};
export type NotionDecisionRecordsConfig = {
  workspaceId: string;
  dataSourceId: string;
  token: string;
  /** Stable protected key included in host backup/restore; never stored in Notion. */
  signingKey: string;
  titleProperty?: string;
  /** Current explicit target grant for every actual recipient, plus exact child page when known. */
  authorize(input: {
    audience: DecisionAudience;
    dataSourceId: string;
    pageId?: string;
  }): Promise<boolean>;
  /** Current access/deletion/exclusion fence for retained original Evidence, including older revisions. */
  authorizeRetainedSource(input: {
    audience: DecisionAudience;
    source: DecisionSource;
  }): Promise<boolean>;
  /** Historical authority evidence has its own current source permission fence. */
  authorizeRetainedAuthority(input: {
    audience: DecisionAudience;
    snapshot: DecisionAuthoritySnapshot;
  }): Promise<boolean>;
  transport?: NotionDecisionTransport;
  now?: () => Date;
};
type Deadline = { check(): void };
type ReadRecord = {
  record: CanonicalDecisionRecord;
  section: string;
  archive: DecisionRecordArchive;
};
const MAX_RECORDS = 100;
const TIMEOUT_MS = 15_000;
const safeFailure = () =>
  new Error(
    "Canonical Decision Records could not be verified completely for this audience."
  );

/** One configured canonical location; each approved stage performs at most one provider mutation. */
export function createNotionDecisionRecords(
  config: NotionDecisionRecordsConfig
): DecisionRecords {
  const dataSourceId = canonicalNotionObjectId(config.dataSourceId);
  if (
    !dataSourceId ||
    !config.workspaceId.trim() ||
    !config.token.trim() ||
    Buffer.byteLength(config.signingKey) < 32 ||
    typeof config.authorize !== "function" ||
    typeof config.authorizeRetainedSource !== "function" ||
    typeof config.authorizeRetainedAuthority !== "function"
  )
    throw safeFailure();
  const workspaceId = config.workspaceId;
  const signingKey = config.signingKey;
  const titleProperty = config.titleProperty ?? "title";
  const now = config.now ?? (() => new Date());
  const api = config.transport ?? sdkTransport(config.token);
  const scope = { workspaceId, dataSourceId, signingKey };

  async function grant(
    deadline: Deadline,
    audience: DecisionAudience,
    pageId?: string
  ): Promise<void> {
    deadline.check();
    if (
      audience.workspaceId !== workspaceId ||
      !decisionAudienceSchema.safeParse(audience).success ||
      !(await config.authorize({
        audience: structuredClone(audience),
        dataSourceId: dataSourceId!,
        ...(pageId ? { pageId } : {})
      }))
    )
      throw safeFailure();
    deadline.check();
  }
  async function originalGrants(
    deadline: Deadline,
    audience: DecisionAudience,
    archive: DecisionRecordArchive
  ) {
    const sources = new Set<string>();
    const authorities = new Set<string>();
    for (const revision of archive.revisions) {
      const source = revision.content.source;
      if (
        source.audience.workspaceId !== workspaceId ||
        !audience.personIds.every((person) => source.audience.personIds.includes(person))
      )
        throw safeFailure();
      deadline.check();
      const sourceKey = decisionDigest(source);
      if (!sources.has(sourceKey)) {
        if (
          !(await config.authorizeRetainedSource({
            audience: structuredClone(audience),
            source: structuredClone(source)
          }))
        )
          throw safeFailure();
        sources.add(sourceKey);
      }
      const snapshot = revision.content.authority.snapshot;
      const authorityKey = decisionDigest(snapshot);
      if (!authorities.has(authorityKey)) {
        deadline.check();
        if (
          !(await config.authorizeRetainedAuthority({
            audience: structuredClone(audience),
            snapshot: structuredClone(snapshot)
          }))
        )
          throw safeFailure();
        authorities.add(authorityKey);
      }
      deadline.check();
    }
  }
  async function readPage(
    deadline: Deadline,
    audience: DecisionAudience,
    pageId: string
  ): Promise<ReadRecord> {
    if (canonicalNotionObjectId(pageId) !== pageId) throw safeFailure();
    await grant(deadline, audience, pageId);
    const before = pageHead(await api.readPage(pageId), pageId, dataSourceId!);
    await grant(deadline, audience, pageId);
    const markdown = pageMarkdown(await api.readMarkdown(pageId), pageId);
    await grant(deadline, audience, pageId);
    const after = pageHead(await api.readPage(pageId), pageId, dataSourceId!);
    await grant(deadline, audience, pageId);
    if (decisionDigest(before) !== decisionDigest(after)) throw safeFailure();
    const parsed = parseNotionDecisionRecord({ ...scope, markdown });
    await originalGrants(deadline, audience, parsed.archive);
    await grant(deadline, audience, pageId);
    const version = decisionDigest({ after, markdown });
    return {
      ...parsed,
      record: {
        content: parsed.archive.revisions.at(-1)!.content,
        reference: {
          providerId: "notion",
          objectType: "document",
          externalId: pageId,
          url: after.url,
          version
        },
        version
      }
    };
  }
  async function list(
    deadline: Deadline,
    audience: DecisionAudience,
    limit: number
  ): Promise<{ ids: string[]; complete: boolean }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pages = 0; pages < 10; pages++) {
      await grant(deadline, audience);
      const result = z
        .object({
          object: z.literal("list"),
          results: z
            .array(z.object({ object: z.literal("page"), id: z.string() }))
            .max(100),
          has_more: z.boolean(),
          next_cursor: z.string().nullable()
        })
        .parse(await api.list(dataSourceId!, cursor));
      await grant(deadline, audience);
      for (const entry of result.results) {
        const id = canonicalNotionObjectId(entry.id);
        if (!id || ids.includes(id)) throw safeFailure();
        ids.push(id);
        if (ids.length > limit) return { ids: ids.slice(0, limit), complete: false };
      }
      if (!result.has_more) {
        if (result.next_cursor !== null) throw safeFailure();
        return { ids: ids.sort(), complete: true };
      }
      if (!result.next_cursor || seen.has(result.next_cursor)) throw safeFailure();
      cursor = result.next_cursor;
      seen.add(cursor);
    }
    return { ids, complete: false };
  }
  async function discover(
    deadline: Deadline,
    audience: DecisionAudience,
    limit: number
  ): Promise<{ snapshot: DecisionCatalogSnapshot; pages: ReadRecord[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS)
      throw safeFailure();
    const first = await list(deadline, audience, limit);
    const pages: ReadRecord[] = [];
    if (first.complete)
      for (const id of first.ids) pages.push(await readPage(deadline, audience, id));
    const last = await list(deadline, audience, limit);
    const complete =
      first.complete &&
      last.complete &&
      decisionDigest(first.ids) === decisionDigest(last.ids);
    const records = complete ? pages.map((page) => page.record) : [];
    if (new Set(records.map((record) => record.content.id)).size !== records.length)
      throw safeFailure();
    await grant(deadline, audience);
    return {
      pages,
      snapshot: {
        id: `notion-decisions:${workspaceId}:${dataSourceId}`,
        revision: decisionDigest({ audience, records, complete }),
        complete,
        records
      }
    };
  }
  async function find(
    deadline: Deadline,
    audience: DecisionAudience,
    stage: DecisionWriteStage,
    operationId: string
  ): Promise<DecisionWriteReceipt | null> {
    const pages =
      stage.type === "create-record"
        ? await discover(deadline, audience, MAX_RECORDS)
        : {
            snapshot: { complete: true },
            pages: [await readPage(deadline, audience, targetPage(stage.target))]
          };
    if (!pages.snapshot.complete) return null;
    const matches = pages.pages.filter((page) => {
      const latest = page.archive.revisions.at(-1)!;
      return (
        latest.operationId === operationId &&
        latest.stageDigest === decisionDigest(stage) &&
        decisionDigest(latest.content) === decisionDigest(nextContent(stage))
      );
    });
    if (matches.length !== 1) return null;
    return { record: matches[0]!.record, operationId, observedAt: now().toISOString() };
  }
  function targetPage(target: CanonicalDecisionRecord): string {
    if (
      target.reference.providerId !== "notion" ||
      target.reference.objectType !== "document" ||
      canonicalNotionObjectId(target.reference.externalId) !== target.reference.externalId
    )
      throw safeFailure();
    return target.reference.externalId;
  }
  return {
    providerId: "notion",
    discover(input) {
      const bound = structuredClone(input);
      return withinDeadline(async (deadline) => {
        try {
          return (await discover(deadline, bound.audience, bound.limit)).snapshot;
        } catch {
          return {
            id: `notion-decisions:${workspaceId}:${dataSourceId}`,
            revision: "unavailable",
            complete: false,
            records: []
          };
        }
      });
    },
    requireCurrent(input) {
      const bound = structuredClone(input);
      return withinDeadline(async (deadline) => {
        const current = (await discover(deadline, bound.audience, MAX_RECORDS)).snapshot;
        if (
          !bound.snapshot.complete ||
          !current.complete ||
          decisionDigest(bound.snapshot) !== decisionDigest(current)
        )
          throw safeFailure();
      });
    },
    read(input) {
      const bound = structuredClone(input);
      return withinDeadline(async (deadline) => {
        try {
          const { snapshot } = await discover(deadline, bound.audience, MAX_RECORDS);
          if (!snapshot.complete) return null;
          const found = snapshot.records.filter(
            (record) =>
              record.content.id === bound.recordId ||
              record.reference.externalId === bound.recordId
          );
          return found.length === 1 ? found[0]! : null;
        } catch {
          return null;
        }
      });
    },
    findWritten(input) {
      const bound = structuredClone(input);
      return withinDeadline(async (deadline) => {
        const stage = decisionWriteStageSchema.parse(bound.stage);
        return find(deadline, bound.audience, stage, bound.operationId);
      });
    },
    write(input) {
      const bound = structuredClone(input);
      return withinDeadline(async (deadline) => {
        let dispatched = false;
        try {
          const stage = decisionWriteStageSchema.parse(bound.stage);
          if (!bound.operationId || bound.operationId.length > 512) throw safeFailure();
          await grant(deadline, bound.audience);
          const existing = await find(deadline, bound.audience, stage, bound.operationId);
          if (existing) return existing;
          const archive: DecisionRecordArchive = {
            format: 1,
            workspaceId,
            dataSourceId: dataSourceId,
            revisions: []
          };
          let prior: ReadRecord | undefined;
          if (stage.type === "create-record") {
            const current = await discover(deadline, bound.audience, MAX_RECORDS);
            if (
              !current.snapshot.complete ||
              current.snapshot.records.length >= MAX_RECORDS ||
              current.snapshot.records.some(
                (record) => record.content.id === stage.record.id
              ) ||
              !["active", "pending"].includes(stage.record.status)
            )
              throw safeFailure();
          } else {
            prior = await readPage(deadline, bound.audience, targetPage(stage.target));
            if (decisionDigest(prior.record) !== decisionDigest(stage.target))
              throw safeFailure();
            archive.revisions = prior.archive.revisions;
            if (
              stage.type === "amend-record" &&
              (stage.target.content.status !== "active" ||
                stage.record.status !== "active" ||
                stage.record.id !== stage.target.content.id ||
                decisionDigest(stage.record.supersedes) !==
                  decisionDigest(stage.target.content.supersedes) ||
                stage.record.supersededBy !== null)
            )
              throw safeFailure();
            if (stage.type === "retire-record") {
              const successor = await readPage(
                deadline,
                bound.audience,
                targetPage({ ...stage.target, reference: stage.successor })
              );
              if (
                stage.target.content.status !== "active" ||
                successor.record.content.status !== "pending" ||
                !successor.record.content.supersedes.some(
                  (ref) =>
                    ref.providerId === "notion" &&
                    ref.externalId === stage.target.reference.externalId
                )
              )
                throw safeFailure();
            }
            if (stage.type === "activate-record") {
              if (
                stage.target.content.status !== "pending" ||
                stage.target.content.supersedes.length === 0
              )
                throw safeFailure();
              for (const ref of stage.target.content.supersedes) {
                const predecessor = await readPage(
                  deadline,
                  bound.audience,
                  targetPage({ ...stage.target, reference: ref })
                );
                if (
                  !["superseded", "reversed"].includes(
                    predecessor.record.content.status
                  ) ||
                  predecessor.record.content.supersededBy?.externalId !==
                    stage.target.reference.externalId ||
                  predecessor.record.content.supersededBy.providerId !== "notion"
                )
                  throw safeFailure();
              }
            }
          }
          if (
            archive.revisions.some(
              (revision) => revision.operationId === bound.operationId
            )
          )
            throw safeFailure();
          archive.revisions.push({
            operationId: bound.operationId,
            stageDigest: decisionDigest(stage),
            content: nextContent(stage)
          });
          await originalGrants(deadline, bound.audience, archive);
          const markdown = renderNotionDecisionRecord(archive, signingKey);
          parseNotionDecisionRecord({ ...scope, markdown });
          await grant(deadline, bound.audience, prior?.record.reference.externalId);
          deadline.check();
          dispatched = true;
          if (stage.type === "create-record") {
            await api.create({
              dataSourceId: dataSourceId,
              titleProperty,
              title: `Decision DR-${decisionDigest(stage.record.id).slice(0, 10)}`,
              markdown
            });
          } else {
            await api.replace({
              pageId: targetPage(stage.target),
              before: prior!.section,
              after: markdown
            });
          }
          deadline.check();
          const receipt = await find(deadline, bound.audience, stage, bound.operationId);
          if (!receipt) throw safeFailure();
          return receipt;
        } catch {
          if (!dispatched)
            throw new DecisionWriteNotAppliedError(
              "notion-decision-prewrite-refused",
              "The decision could not be verified for this exact target, source and audience; no provider write was sent."
            );
          throw new Error(
            "Decision write outcome is unknown; recover from positive provider evidence before any further mutation."
          );
        }
      });
    }
  };
}

function nextContent(stage: DecisionWriteStage): DecisionRecordContent {
  switch (stage.type) {
    case "create-record":
    case "amend-record":
      return structuredClone(stage.record);
    case "retire-record":
      return {
        ...structuredClone(stage.target.content),
        status: stage.status,
        supersededBy: structuredClone(stage.successor)
      };
    case "activate-record":
      return { ...structuredClone(stage.target.content), status: "active" };
  }
}
function pageHead(raw: unknown, pageId: string, dataSourceId: string) {
  const page = z
    .object({
      object: z.literal("page"),
      id: z.string(),
      url: z.string().url(),
      archived: z.literal(false),
      in_trash: z.literal(false),
      last_edited_time: z.string().datetime({ offset: true }),
      parent: z.object({ type: z.literal("data_source_id"), data_source_id: z.string() })
    })
    .parse(raw);
  const url = new URL(page.url);
  if (
    canonicalNotionObjectId(page.id) !== pageId ||
    canonicalNotionObjectId(page.parent.data_source_id) !== dataSourceId ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    throw safeFailure();
  return page;
}
function pageMarkdown(raw: unknown, pageId: string): string {
  const value = z
    .object({
      object: z.literal("page_markdown"),
      id: z.string(),
      markdown: z.string().min(1),
      truncated: z.literal(false),
      unknown_block_ids: z.array(z.string()).max(0)
    })
    .parse(raw);
  if (
    canonicalNotionObjectId(value.id) !== pageId ||
    Buffer.byteLength(value.markdown) > 500_000 ||
    /<unknown(?:\s|\/|>)/u.test(value.markdown)
  )
    throw safeFailure();
  return value.markdown;
}
function withinDeadline<T>(work: (deadline: Deadline) => Promise<T>): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(safeFailure());
    }, TIMEOUT_MS);
  });
  return Promise.race([
    work({
      check() {
        if (expired) throw safeFailure();
      }
    }),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function sdkTransport(token: string): NotionDecisionTransport {
  const client = new Client({
    auth: token,
    notionVersion: "2026-03-11",
    timeoutMs: 4_000,
    retry: false,
    logger: () => undefined
  });
  return {
    list: (dataSourceId, cursor) =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      }),
    readPage: (pageId) => client.pages.retrieve({ page_id: pageId }),
    readMarkdown: (pageId) => client.pages.retrieveMarkdown({ page_id: pageId }),
    create: (input) =>
      client.pages.create({
        parent: { type: "data_source_id", data_source_id: input.dataSourceId },
        properties: {
          [input.titleProperty]: {
            type: "title",
            title: [{ type: "text", text: { content: input.title } }]
          }
        },
        markdown: input.markdown
      }),
    replace: (input) =>
      client.pages.updateMarkdown({
        page_id: input.pageId,
        type: "update_content",
        update_content: {
          content_updates: [
            { old_str: input.before, new_str: input.after, replace_all_matches: false }
          ],
          allow_deleting_content: false
        }
      })
  };
}
