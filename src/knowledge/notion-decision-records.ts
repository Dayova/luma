import { z } from "zod";
import type { DecisionRecordCatalog } from "./decision-record-catalog.js";
import type { ExternalReference } from "../domain/model.js";
import { createScheduledNotionClient } from "./notion-scheduled-client.js";
import { NOTION_OPERATION_TIMEOUT_MS } from "./notion-request-scheduler.js";
import type {
  CanonicalDecisionRecord,
  DecisionAudience,
  DecisionAuthoritySnapshot,
  DecisionHumanReview,
  DecisionCatalogSnapshot,
  DecisionRecordContent,
  DecisionSource,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";
import {
  decisionAudienceSchema,
  canonicalDecisionRecordSchema,
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

export type NotionDecisionRequestContext = {
  signal: AbortSignal;
  priority?: "background";
  beforeDispatch?: () => Promise<void>;
  onDispatch?: () => void;
};
export type NotionDecisionReadTransport = {
  list(
    dataSourceId: string,
    cursor?: string,
    context?: NotionDecisionRequestContext
  ): Promise<unknown>;
  readPage(pageId: string, context?: NotionDecisionRequestContext): Promise<unknown>;
  readMarkdown(pageId: string, context?: NotionDecisionRequestContext): Promise<unknown>;
};
export type NotionDecisionTransport = NotionDecisionReadTransport & {
  create(
    input: {
      dataSourceId: string;
      titleProperty: string;
      title: string;
      markdown: string;
    },
    context?: NotionDecisionRequestContext
  ): Promise<unknown>;
  replace(
    input: { pageId: string; before: string; after: string },
    context?: NotionDecisionRequestContext
  ): Promise<unknown>;
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
    signal?: AbortSignal;
    priority?: "background";
  }): Promise<boolean>;
  /** Historical authority evidence has its own current source permission fence. */
  authorizeRetainedAuthority(input: {
    audience: DecisionAudience;
    snapshot: DecisionAuthoritySnapshot;
    signal?: AbortSignal;
    priority?: "background";
  }): Promise<boolean>;
  /** Supplemental original Human reviews have independent retained actor/source/audience proofs. */
  authorizeRetainedHumanReview?(input: {
    audience: DecisionAudience;
    review: DecisionHumanReview;
    signal?: AbortSignal;
    priority?: "background";
  }): Promise<boolean>;
  transport?: NotionDecisionTransport;
  now?: () => Date;
};
export type NotionDecisionRecordCatalogConfig = Omit<
  NotionDecisionRecordsConfig,
  "token" | "transport"
> & {
  readOnlyApiToken: string;
  transport?: NotionDecisionReadTransport;
  token?: never;
};
type Deadline = { signal: AbortSignal; priority?: "background"; check(): void };
type ProofPass = {
  sources: Map<string, DecisionSource>;
  authorities: Map<string, DecisionAuthoritySnapshot>;
  humanReviews: Map<string, DecisionHumanReview>;
};
const proofPass = (): ProofPass => ({
  sources: new Map(),
  authorities: new Map(),
  humanReviews: new Map()
});
type ReadRecord = {
  record: CanonicalDecisionRecord;
  section: string;
  archive: DecisionRecordArchive;
};
const MAX_RECORDS = 100;

const safeFailure = () =>
  new Error(
    "Canonical Decision Records could not be verified completely for this audience."
  );

/** A dedicated read-only native client; its public object/transport cannot mutate Notion. */
export function createNotionDecisionRecordCatalog(
  config: NotionDecisionRecordCatalogConfig
): DecisionRecordCatalog {
  if (
    !config.readOnlyApiToken?.trim() ||
    "token" in config ||
    (config.transport &&
      Object.keys(config.transport).some(
        (key) => !["list", "readPage", "readMarkdown"].includes(key)
      ))
  )
    throw safeFailure();
  const records = createCapability(
    config,
    config.transport ?? sdkReadTransport(config.readOnlyApiToken)
  );
  return Object.freeze({
    providerId: records.providerId,
    discover: records.discover,
    requireCurrent: records.requireCurrent,
    read: records.read,
    readReference: records.readReference
  });
}
/** One configured canonical location; each approved stage performs at most one provider mutation. */
export function createNotionDecisionRecords(
  config: NotionDecisionRecordsConfig
): DecisionRecords {
  if (!config.token.trim()) throw safeFailure();
  const transport = config.transport ?? sdkTransport(config.token);
  return createCapability(config, transport, transport, config.transport === undefined);
}
function createCapability(
  config: Omit<NotionDecisionRecordsConfig, "token" | "transport">,
  api: NotionDecisionReadTransport,
  mutations?: Pick<NotionDecisionTransport, "create" | "replace">,
  nativeMutations = false
): DecisionRecords {
  const dataSourceId = canonicalNotionObjectId(config.dataSourceId);
  if (
    !dataSourceId ||
    !config.workspaceId.trim() ||
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
  function collectOriginalProofs(
    audience: DecisionAudience,
    archive: DecisionRecordArchive,
    proofs: ProofPass
  ) {
    for (const revision of archive.revisions) {
      const source = revision.content.source;
      if (
        source.audience.workspaceId !== workspaceId ||
        !audience.personIds.every((person) => source.audience.personIds.includes(person))
      )
        throw safeFailure();
      proofs.sources.set(decisionDigest(source), source);
      const snapshot = revision.content.authority.snapshot;
      proofs.authorities.set(decisionDigest(snapshot), snapshot);
      for (const review of revision.content.authority.humanReviews ?? []) {
        if (
          review.audience.workspaceId !== workspaceId ||
          !audience.personIds.every((person) =>
            review.audience.personIds.includes(person)
          )
        )
          throw safeFailure();
        proofs.humanReviews.set(decisionDigest(review), review);
      }
    }
  }
  async function currentOriginalProofs(
    deadline: Deadline,
    audience: DecisionAudience,
    proofs: ProofPass
  ) {
    await boundedMap([...proofs.sources.values()], async (source) => {
      deadline.check();
      if (
        !(await config.authorizeRetainedSource({
          audience: structuredClone(audience),
          source: structuredClone(source),
          signal: deadline.signal,
          ...(deadline.priority ? { priority: deadline.priority } : {})
        }))
      )
        throw safeFailure();
      deadline.check();
    });
    await boundedMap([...proofs.authorities.values()], async (snapshot) => {
      deadline.check();
      if (
        !(await config.authorizeRetainedAuthority({
          audience: structuredClone(audience),
          snapshot: structuredClone(snapshot),
          signal: deadline.signal,
          ...(deadline.priority ? { priority: deadline.priority } : {})
        }))
      )
        throw safeFailure();
      deadline.check();
    });
    await boundedMap([...proofs.humanReviews.values()], async (review) => {
      deadline.check();
      if (
        !config.authorizeRetainedHumanReview ||
        !(await config.authorizeRetainedHumanReview({
          audience: structuredClone(audience),
          review: structuredClone(review),
          signal: deadline.signal,
          ...(deadline.priority ? { priority: deadline.priority } : {})
        }))
      )
        throw safeFailure();
      deadline.check();
    });
  }
  async function originalGrants(
    deadline: Deadline,
    audience: DecisionAudience,
    archive: DecisionRecordArchive
  ) {
    const proofs = proofPass();
    collectOriginalProofs(audience, archive, proofs);
    await currentOriginalProofs(deadline, audience, proofs);
  }
  async function readPage(
    deadline: Deadline,
    audience: DecisionAudience,
    pageId: string,
    proofs?: ProofPass
  ): Promise<ReadRecord> {
    if (canonicalNotionObjectId(pageId) !== pageId) throw safeFailure();
    await grant(deadline, audience, pageId);
    const before = pageHead(await api.readPage(pageId, deadline), pageId, dataSourceId!);
    await grant(deadline, audience, pageId);
    const markdown = pageMarkdown(await api.readMarkdown(pageId, deadline), pageId);
    await grant(deadline, audience, pageId);
    const after = pageHead(await api.readPage(pageId, deadline), pageId, dataSourceId!);
    await grant(deadline, audience, pageId);
    if (decisionDigest(before) !== decisionDigest(after)) throw safeFailure();
    const parsed = parseNotionDecisionRecord({ ...scope, markdown });
    if (proofs) collectOriginalProofs(audience, parsed.archive, proofs);
    else await originalGrants(deadline, audience, parsed.archive);
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
        .parse(await api.list(dataSourceId!, cursor, deadline));
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
    const proofs = proofPass();
    const pages = first.complete
      ? await boundedMap(first.ids, (id) => readPage(deadline, audience, id, proofs))
      : [];
    const last = await list(deadline, audience, limit);
    const complete =
      first.complete &&
      last.complete &&
      decisionDigest(first.ids) === decisionDigest(last.ids);
    const records = complete ? pages.map((page) => page.record) : [];
    if (new Set(records.map((record) => record.content.id)).size !== records.length)
      throw safeFailure();
    if (complete) {
      await currentOriginalProofs(deadline, audience, proofs);
      await boundedMap(first.ids, (id) => grant(deadline, audience, id));
    }
    await grant(deadline, audience);
    return {
      pages,
      snapshot: {
        id: `notion-decisions:${workspaceId}:${dataSourceId}`,
        revision: decisionDigest({
          audience: { ...audience, personIds: [...audience.personIds].sort() },
          records,
          complete
        }),
        complete,
        records
      }
    };
  }
  function receiptFrom(
    pages: ReadRecord[],
    stage: DecisionWriteStage,
    operationId: string
  ): DecisionWriteReceipt | null {
    const matches = pages.filter((page) => {
      const latest = page.archive.revisions.at(-1)!;
      return (
        latest.operationId === operationId &&
        latest.stageDigest === decisionDigest(stage) &&
        decisionDigest(latest.content) === decisionDigest(nextContent(stage))
      );
    });
    return matches.length === 1
      ? { record: matches[0]!.record, operationId, observedAt: now().toISOString() }
      : null;
  }
  async function find(
    deadline: Deadline,
    audience: DecisionAudience,
    stage: DecisionWriteStage,
    operationId: string
  ): Promise<DecisionWriteReceipt | null> {
    if (stage.type !== "create-record")
      return receiptFrom(
        [await readPage(deadline, audience, targetPage(stage.target))],
        stage,
        operationId
      );
    const current = await discover(deadline, audience, MAX_RECORDS);
    return current.snapshot.complete
      ? receiptFrom(current.pages, stage, operationId)
      : null;
  }
  async function requireKnownCatalog(
    deadline: Deadline,
    audience: DecisionAudience,
    records: CanonicalDecisionRecord[]
  ): Promise<ProofPass> {
    if (records.length > MAX_RECORDS) throw safeFailure();
    const ids = records.map((record) => referencePage(record.reference)).sort();
    if (
      new Set(ids).size !== records.length ||
      new Set(records.map((record) => record.content.id)).size !== records.length
    )
      throw safeFailure();
    const current = await list(deadline, audience, MAX_RECORDS);
    if (!current.complete || decisionDigest(current.ids) !== decisionDigest(ids))
      throw safeFailure();
    const proofs = proofPass();
    await boundedMap(records, async (expected) => {
      const id = expected.reference.externalId;
      await grant(deadline, audience, id);
      const markdown = pageMarkdown(await api.readMarkdown(id, deadline), id);
      await grant(deadline, audience, id);
      const after = pageHead(await api.readPage(id, deadline), id, dataSourceId!);
      const version = decisionDigest({ after, markdown });
      // A known immutable version binds both complete bytes and the native head;
      // matching only timestamps would miss edits with an unchanged timestamp.
      if (version !== expected.version) throw safeFailure();
      const parsed = parseNotionDecisionRecord({ ...scope, markdown });
      const actual: CanonicalDecisionRecord = {
        content: parsed.archive.revisions.at(-1)!.content,
        reference: {
          providerId: "notion",
          objectType: "document",
          externalId: id,
          url: after.url,
          version
        },
        version
      };
      if (decisionDigest(actual) !== decisionDigest(expected)) throw safeFailure();
      collectOriginalProofs(audience, parsed.archive, proofs);
      await grant(deadline, audience, id);
    });
    const last = await list(deadline, audience, MAX_RECORDS);
    if (!last.complete || decisionDigest(last.ids) !== decisionDigest(current.ids))
      throw safeFailure();
    return proofs;
  }
  function referencePage(reference: ExternalReference): string {
    if (
      reference.providerId !== "notion" ||
      reference.objectType !== "document" ||
      canonicalNotionObjectId(reference.externalId) !== reference.externalId
    )
      throw safeFailure();
    return reference.externalId;
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
      const { signal, priority, ...request } = input;
      const bound = structuredClone(request);
      return withinDeadline(
        async (deadline) => {
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
        },
        signal,
        priority
      );
    },
    requireCurrent(input) {
      const { signal, ...request } = input;
      const bound = structuredClone(request);
      return withinDeadline(async (deadline) => {
        const records = bound.snapshot.records.map((record) =>
          canonicalDecisionRecordSchema.parse(record)
        );
        if (
          !bound.snapshot.complete ||
          bound.snapshot.id !== `notion-decisions:${workspaceId}:${dataSourceId}` ||
          bound.snapshot.revision !==
            decisionDigest({
              audience: {
                ...bound.audience,
                personIds: [...bound.audience.personIds].sort()
              },
              records,
              complete: true
            })
        )
          throw safeFailure();
        const proofs = await requireKnownCatalog(deadline, bound.audience, records);
        await currentOriginalProofs(deadline, bound.audience, proofs);
        await boundedMap(records, (record) =>
          grant(deadline, bound.audience, record.reference.externalId)
        );
        await grant(deadline, bound.audience);
      }, signal);
    },
    read(input) {
      const { signal, ...request } = input;
      const bound = structuredClone(request);
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
      }, signal);
    },
    readReference(input) {
      const { signal, ...request } = input;
      const bound = structuredClone(request);
      return withinDeadline(async (deadline) => {
        try {
          return (
            await readPage(deadline, bound.audience, referencePage(bound.reference))
          ).record;
        } catch {
          return null;
        }
      }, signal);
    },
    findWritten(input) {
      const bound = structuredClone({
        audience: input.audience,
        stage: input.stage,
        operationId: input.operationId
      });
      return withinDeadline(async (deadline) => {
        const stage = decisionWriteStageSchema.parse(bound.stage);
        return find(deadline, bound.audience, stage, bound.operationId);
      });
    },
    write(input) {
      const { requireCurrent, ...request } = input;
      const bound = structuredClone(request);
      let dispatched = false;
      return withinDeadline(async (deadline) => {
        try {
          if (!mutations || typeof requireCurrent !== "function") throw safeFailure();
          const stage = decisionWriteStageSchema.parse(bound.stage);
          if (!bound.operationId || bound.operationId.length > 512) throw safeFailure();
          await grant(deadline, bound.audience);
          const creationCatalog =
            stage.type === "create-record"
              ? await discover(deadline, bound.audience, MAX_RECORDS)
              : null;
          const existing = creationCatalog
            ? creationCatalog.snapshot.complete
              ? receiptFrom(creationCatalog.pages, stage, bound.operationId)
              : null
            : await find(deadline, bound.audience, stage, bound.operationId);
          if (existing) return existing;
          const archive: DecisionRecordArchive = {
            format: 1,
            workspaceId,
            dataSourceId: dataSourceId,
            revisions: []
          };
          let prior: ReadRecord | undefined;
          if (stage.type === "create-record") {
            const current = creationCatalog!;
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
          const markdown = renderNotionDecisionRecord(archive, signingKey);
          parseNotionDecisionRecord({ ...scope, markdown });
          const beforeDispatch = async () => {
            deadline.check();
            const proofs = creationCatalog
              ? await requireKnownCatalog(
                  deadline,
                  bound.audience,
                  creationCatalog.snapshot.records
                )
              : proofPass();
            if (prior) {
              const current = await readPage(
                deadline,
                bound.audience,
                prior.record.reference.externalId
              );
              if (decisionDigest(current.record) !== decisionDigest(prior.record))
                throw safeFailure();
            }
            collectOriginalProofs(bound.audience, archive, proofs);
            await currentOriginalProofs(deadline, bound.audience, proofs);
            await requireCurrent();
            await grant(deadline, bound.audience, prior?.record.reference.externalId);
            deadline.check();
          };
          if (!nativeMutations) await beforeDispatch();
          let receipt: DecisionWriteReceipt | null;
          if (!nativeMutations) dispatched = true;
          if (stage.type === "create-record") {
            const response = await mutations.create(
              {
                dataSourceId,
                titleProperty,
                title: `Decision DR-${decisionDigest(stage.record.id).slice(0, 10)}`,
                markdown
              },
              {
                signal: deadline.signal,
                beforeDispatch,
                onDispatch: () => {
                  dispatched = true;
                }
              }
            );
            dispatched = true;
            deadline.check();
            const created = z
              .object({ object: z.literal("page"), id: z.string() })
              .parse(response);
            const pageId = canonicalNotionObjectId(created.id);
            if (!pageId) throw safeFailure();
            receipt = receiptFrom(
              [await readPage(deadline, bound.audience, pageId)],
              stage,
              bound.operationId
            );
          } else {
            await mutations.replace(
              {
                pageId: targetPage(stage.target),
                before: prior!.section,
                after: markdown
              },
              {
                signal: deadline.signal,
                beforeDispatch,
                onDispatch: () => {
                  dispatched = true;
                }
              }
            );
            dispatched = true;
            deadline.check();
            receipt = await find(deadline, bound.audience, stage, bound.operationId);
          }
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
      }).catch((error: unknown) => {
        if (!dispatched)
          throw new DecisionWriteNotAppliedError(
            "notion-decision-prewrite-refused",
            "The decision could not be verified before its deadline; no provider write was sent."
          );
        throw error;
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
function withinDeadline<T>(
  work: (deadline: Deadline) => Promise<T>,
  outer?: AbortSignal,
  priority?: "background"
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outer?.aborted) abort();
  else outer?.addEventListener("abort", abort, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(safeFailure());
    else
      controller.signal.addEventListener("abort", () => reject(safeFailure()), {
        once: true
      });
  });
  const timer = setTimeout(() => controller.abort(), NOTION_OPERATION_TIMEOUT_MS);
  return Promise.race([
    work({
      signal: controller.signal,
      ...(priority ? { priority } : {}),
      check() {
        if (controller.signal.aborted) throw safeFailure();
      }
    }),
    timeout
  ]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  });
}
async function boundedMap<T, R>(
  values: readonly T[],
  work: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(4, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try {
        results[index] = await work(values[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}
function sdkReadTransport(token: string): NotionDecisionReadTransport {
  const { client, request } = createScheduledNotionClient(token);
  const run = <T>(
    context: NotionDecisionRequestContext | undefined,
    send: () => Promise<T>
  ) =>
    request({
      signal: context?.signal ?? AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
      readOnly: true,
      ...(context?.priority ? { priority: context.priority } : {}),
      send
    });
  return {
    list: (dataSourceId, cursor, context) =>
      run(context, () =>
        client.dataSources.query({
          data_source_id: dataSourceId,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        })
      ),
    readPage: (pageId, context) =>
      run(context, () => client.pages.retrieve({ page_id: pageId })),
    readMarkdown: (pageId, context) =>
      run(context, () => client.pages.retrieveMarkdown({ page_id: pageId }))
  };
}
function sdkTransport(token: string): NotionDecisionTransport {
  const { client, request } = createScheduledNotionClient(token);
  const write = <T>(
    context: NotionDecisionRequestContext | undefined,
    send: () => Promise<T>
  ) =>
    request({
      signal: context?.signal ?? AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
      readOnly: false,
      ...(context?.beforeDispatch ? { beforeDispatch: context.beforeDispatch } : {}),
      send: () => {
        context?.onDispatch?.();
        return send();
      }
    });
  return {
    ...sdkReadTransport(token),
    create: (input, context) =>
      write(context, () =>
        client.pages.create({
          parent: { type: "data_source_id", data_source_id: input.dataSourceId },
          properties: {
            [input.titleProperty]: {
              type: "title",
              title: [{ type: "text", text: { content: input.title } }]
            }
          },
          markdown: input.markdown
        })
      ),
    replace: (input, context) =>
      write(context, () =>
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
      )
  };
}
