import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Client } from "@notionhq/client";
import type { IdentityDirectory } from "../identity/interface.js";
import type {
  StructuredFieldValue,
  StructuredRecord,
  StructuredRecordCreate,
  StructuredRecordSchema,
  StructuredRecordSnapshot,
  StructuredWorkAudience
} from "../domain/structured-work.js";
import { operationDigest } from "../structured-work/persistence.js";
import { structuredFieldValueSchema } from "../structured-work/schemas.js";
import { createScheduledNotionClient } from "./notion-scheduled-client.js";
import {
  StructuredRecordNotAppliedError,
  type StructuredRecords
} from "./structured-records.js";

export type NotionStructuredTarget = {
  key: string;
  label: string;
  dataSourceId: string;
  titleField: string;
  fields: Record<
    string,
    { property: string; type: StructuredFieldValue["type"]; required?: boolean }
  >;
  defaults?: Record<string, StructuredFieldValue>;
  sourceProperty?: string;
  ownerProperty?: string;
  workLinkProperty?: string;
  /** Only explicit configured native status values determine active records. */
  active?: { property: string; values: string[] };
};
export type NotionStructuredRecordsConfig = {
  apiToken: string;
  signingKey: string;
  targets: NotionStructuredTarget[];
  identityDirectory: IdentityDirectory;
  authorize(input: {
    audience: StructuredWorkAudience;
    objectType: "data-source" | "document";
    externalId: string;
    /** Verified configured parent; document reads have already checked their native parent. */
    dataSourceId: string;
    targetKey: string;
    signal: AbortSignal;
  }): Promise<boolean>;
};
const richText = z
  .array(
    z
      .object({
        plain_text: z.string().optional(),
        text: z.object({ content: z.string(), link: z.unknown().optional() }).optional()
      })
      .passthrough()
      .refine(
        (part) =>
          typeof part.plain_text === "string" || typeof part.text?.content === "string"
      )
  )
  .max(100);
const property = z.object({ id: z.string(), type: z.string() }).passthrough();
const pageSchema = z
  .object({
    object: z.literal("page"),
    id: z.string(),
    url: z.string().url(),
    last_edited_time: z.string(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    parent: z
      .object({ type: z.literal("data_source_id"), data_source_id: z.string() })
      .passthrough(),
    properties: z.record(property)
  })
  .passthrough();
const normalizeId = (id: string) => id.replaceAll("-", "").toLowerCase();
const textOf = (value: unknown) =>
  richText
    .parse(value)
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("");
const nativeValue = (
  value: unknown,
  type: StructuredFieldValue["type"]
): StructuredFieldValue | null => {
  const prop = property.parse(value);
  switch (type) {
    case "text": {
      if (!["title", "rich_text"].includes(prop.type))
        throw new Error("Native text schema changed");
      const text = textOf(prop[prop.type]);
      return text ? { type, value: text } : null;
    }
    case "choice": {
      if (!["select", "status"].includes(prop.type))
        throw new Error("Native choice schema changed");
      const choice = z.object({ name: z.string() }).nullable().parse(prop[prop.type]);
      return choice ? { type, value: choice.name } : null;
    }
    case "number": {
      const number = z.number().finite().nullable().parse(prop["number"]);
      return number === null ? null : { type, value: number };
    }
    case "boolean":
      return { type, value: z.boolean().parse(prop["checkbox"]) };
    case "url": {
      const url = z.string().url().nullable().parse(prop["url"]);
      return url ? { type, value: url } : null;
    }
    case "date": {
      const date = z
        .object({ start: z.string(), end: z.string().nullable().optional() })
        .nullable()
        .parse(prop["date"]);
      if (date?.end) throw new Error("A date range is not a single structured date");
      return date ? { type, value: date.start } : null;
    }
  }
};
const nativeTypes: Record<StructuredFieldValue["type"], string[]> = {
  text: ["title", "rich_text"],
  choice: ["select", "status"],
  number: ["number"],
  boolean: ["checkbox"],
  url: ["url"],
  date: ["date"]
};
function chunks(text: string) {
  return Array.from({ length: Math.ceil(text.length / 1900) }, (_, index) => ({
    type: "text" as const,
    text: { content: text.slice(index * 1900, (index + 1) * 1900) }
  }));
}

/** Actual native data-source adapter; no table/schema creation and no unsupported property CAS. */
export function createNotionStructuredRecords(
  config: NotionStructuredRecordsConfig
): StructuredRecords {
  if (
    !config.apiToken.trim() ||
    Buffer.byteLength(config.signingKey) < 32 ||
    !config.targets.length ||
    config.targets.length > 10 ||
    new Set(config.targets.map((target) => target.key)).size !== config.targets.length
  )
    throw new Error("Configure exact structured targets and a protected signing key");
  const targets = structuredClone(config.targets);
  const { client, request } = createScheduledNotionClient(config.apiToken);
  const targetFor = (key: string) => {
    const target = targets.find((target) => target.key === key);
    if (!target) throw new Error("The structured target is not configured");
    return target;
  };
  const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240000);
    let abort = () => {};
    const expired = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("The structured Notion operation expired"));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([work(controller.signal), expired]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };
  const readNative = <T>(signal: AbortSignal, send: () => Promise<T>) =>
    request({ signal, readOnly: true, send });
  const grant = async (
    audience: StructuredWorkAudience,
    externalId: string,
    objectType: "data-source" | "document",
    signal: AbortSignal,
    target: NotionStructuredTarget
  ) => {
    signal.throwIfAborted();
    if (
      !audience.personIds.length ||
      new Set(audience.personIds).size !== audience.personIds.length ||
      !(await config.authorize({
        audience,
        externalId,
        objectType,
        signal,
        dataSourceId: target.dataSourceId,
        targetKey: target.key
      }))
    )
      throw new Error(
        "The complete original audience cannot access this structured target"
      );
    signal.throwIfAborted();
  };
  const schema = async (
    target: NotionStructuredTarget,
    audience: StructuredWorkAudience,
    signal: AbortSignal
  ) => {
    await grant(audience, target.dataSourceId, "data-source", signal, target);
    const raw = z
      .object({
        object: z.literal("data_source"),
        id: z.string(),
        archived: z.boolean().optional(),
        in_trash: z.boolean().optional(),
        properties: z.record(property)
      })
      .passthrough()
      .parse(
        await readNative(signal, () =>
          client.dataSources.retrieve({ data_source_id: target.dataSourceId })
        )
      );
    if (
      normalizeId(raw.id) !== normalizeId(target.dataSourceId) ||
      raw.archived ||
      raw.in_trash
    )
      throw new Error("The configured data source changed or was removed");
    const mapped = Object.entries(target.fields);
    if (
      mapped.length > 25 ||
      !mapped.length ||
      new Set(mapped.map(([, field]) => field.property)).size !== mapped.length
    )
      throw new Error("Structured field mapping is ambiguous");
    const fields = mapped.map(([key, field]) => {
      const native = raw.properties[field.property];
      if (
        !native ||
        !nativeTypes[field.type].includes(native.type) ||
        (key === target.titleField && native.type !== "title")
      )
        throw new Error(
          "The current data-source schema no longer matches its configured semantic fields"
        );
      const choices =
        field.type === "choice"
          ? z
              .object({
                options: z.array(z.object({ name: z.string() }).passthrough()).max(100)
              })
              .passthrough()
              .parse(native[native.type])
              .options.map((option) => option.name)
          : [];
      return {
        key,
        label: field.property,
        type: field.type,
        required: field.required ?? key === target.titleField,
        choices
      };
    });
    for (const [name, accepted] of [
      [target.ownerProperty, ["people"]],
      [target.sourceProperty, ["rich_text"]],
      [target.workLinkProperty, ["url", "rich_text"]],
      [target.active?.property, ["select", "status"]]
    ] as const) {
      if (
        name &&
        (!raw.properties[name] || !accepted.includes(raw.properties[name].type as never))
      )
        throw new Error(
          "The configured source, owner, work link or lifecycle property changed"
        );
    }
    const managed = [
      target.ownerProperty,
      target.sourceProperty,
      target.workLinkProperty
    ].filter((value): value is string => !!value);
    if (
      managed.some((name) => mapped.some(([, field]) => field.property === name)) ||
      new Set(managed).size !== managed.length
    )
      throw new Error(
        "Evidence and identity properties cannot be overridden as inferred fields"
      );
    const defaults = structuredClone(target.defaults ?? {});
    for (const [key, value] of Object.entries(defaults)) {
      structuredFieldValueSchema.parse(value);
      const field = fields.find((field) => field.key === key);
      if (
        !field ||
        value.type !== field.type ||
        (value.type === "choice" && !field.choices.includes(value.value))
      )
        throw new Error("A configured default is absent from the current schema");
    }
    await grant(audience, target.dataSourceId, "data-source", signal, target);
    const owned: StructuredRecordSchema = {
      targetKey: target.key,
      label: target.label,
      titleField: target.titleField,
      fields,
      defaults,
      revision: operationDigest({ target, properties: raw.properties })
    };
    return { owned, raw };
  };
  const record = async (
    raw: unknown,
    target: NotionStructuredTarget,
    audience: StructuredWorkAudience,
    signal: AbortSignal
  ): Promise<StructuredRecord> => {
    const page = pageSchema.parse(raw);
    if (
      page.archived ||
      page.in_trash ||
      normalizeId(page.parent.data_source_id) !== normalizeId(target.dataSourceId)
    )
      throw new Error("A structured record moved or became unavailable");
    await grant(audience, page.id, "document", signal, target);
    const fields: Record<string, StructuredFieldValue> = {};
    for (const [key, field] of Object.entries(target.fields)) {
      const value = nativeValue(page.properties[field.property], field.type);
      if (value) fields[key] = value;
    }
    const activeValue = target.active
      ? nativeValue(page.properties[target.active.property], "choice")
      : null;
    const active =
      !target.active ||
      (!!activeValue &&
        typeof activeValue.value === "string" &&
        target.active.values.includes(activeValue.value));
    const version = operationDigest({
      properties: page.properties,
      edited: page.last_edited_time,
      parent: page.parent
    });
    return {
      reference: {
        providerId: "notion",
        objectType: "document",
        externalId: page.id,
        url: page.url,
        version
      },
      version,
      fields,
      active
    };
  };
  const list = async (
    target: NotionStructuredTarget,
    audience: StructuredWorkAudience,
    signal: AbortSignal
  ): Promise<{ records: StructuredRecord[]; complete: boolean }> => {
    const result = z
      .object({
        results: z.array(z.unknown()).max(100),
        has_more: z.boolean(),
        next_cursor: z.string().nullable()
      })
      .passthrough()
      .parse(
        await readNative(signal, () =>
          client.dataSources.query({
            data_source_id: target.dataSourceId,
            page_size: 100
          })
        )
      );
    const records: StructuredRecord[] = [];
    for (const raw of result.results)
      records.push(await record(raw, target, audience, signal));
    if (new Set(records.map((item) => item.reference.externalId)).size !== records.length)
      throw new Error("Duplicate structured target identities");
    return {
      records: records.sort((a, b) =>
        a.reference.externalId.localeCompare(b.reference.externalId)
      ),
      complete: !result.has_more && result.next_cursor === null
    };
  };
  const inspect = async (
    audience: StructuredWorkAudience,
    targetKey: string,
    signal: AbortSignal
  ): Promise<StructuredRecordSnapshot> => {
    const target = targetFor(targetKey);
    const before = await schema(target, audience, signal);
    const found = await list(target, audience, signal);
    const after = await schema(target, audience, signal);
    if (before.owned.revision !== after.owned.revision)
      throw new Error("The structured schema changed during discovery");
    return {
      schema: before.owned,
      ...found,
      revision: operationDigest({ schema: before.owned.revision, ...found })
    };
  };
  const read = async (
    audience: StructuredWorkAudience,
    targetKey: string,
    reference: StructuredRecord["reference"],
    signal: AbortSignal
  ) => {
    const target = targetFor(targetKey);
    if (reference.providerId !== "notion" || reference.objectType !== "document")
      throw new Error("Wrong structured provider reference");
    await schema(target, audience, signal);
    const value = await record(
      await readNative(signal, () =>
        client.pages.retrieve({ page_id: reference.externalId })
      ),
      target,
      audience,
      signal
    );
    if (
      normalizeId(value.reference.externalId) !== normalizeId(reference.externalId) ||
      value.reference.url !== reference.url
    )
      throw new Error("Structured record identity changed");
    return value;
  };
  const stamp = (draft: StructuredRecordCreate, operationId: string) => {
    const value = {
      type: "luma-structured-record",
      operationId,
      draftHash: operationDigest(draft)
    };
    return JSON.stringify({
      ...value,
      signature: createHmac("sha256", config.signingKey)
        .update(operationDigest(value))
        .digest("hex")
    });
  };
  const hasStamp = async (pageId: string, expected: string, signal: AbortSignal) => {
    const result = z
      .object({
        results: z.array(z.object({ type: z.string() }).passthrough()).max(100),
        has_more: z.boolean(),
        next_cursor: z.string().nullable()
      })
      .passthrough()
      .parse(
        await readNative(signal, () =>
          client.blocks.children.list({ block_id: pageId, page_size: 100 })
        )
      );
    if (result.has_more || result.next_cursor !== null)
      throw new Error("Structured record recovery body is incomplete");
    return (
      result.results.filter(
        (block) =>
          block.type === "code" &&
          textOf(
            z.object({ rich_text: z.unknown() }).passthrough().parse(block["code"])
              .rich_text
          ) === expected
      ).length === 1
    );
  };
  const ownerAccount = async (draft: StructuredRecordCreate) => {
    if (!draft.ownerPersonId) return null;
    const person = await config.identityDirectory.getPerson({
      workspaceId: draft.source.audience.workspaceId,
      personId: draft.ownerPersonId
    });
    if (!person?.notionUserId)
      throw new Error("The confirmed owner has no Notion identity");
    const matches = await config.identityDirectory.findPeopleByProviderUserId({
      workspaceId: draft.source.audience.workspaceId,
      providerId: "notion",
      providerUserId: person.notionUserId
    });
    if (matches.length !== 1 || matches[0]?.personId !== draft.ownerPersonId)
      throw new Error("The Notion owner account is ambiguous");
    return person.notionUserId;
  };
  const properties = async (
    draft: StructuredRecordCreate,
    target: NotionStructuredTarget,
    native: Awaited<ReturnType<typeof schema>>["raw"]
  ) => {
    const result: Parameters<Client["pages"]["create"]>[0]["properties"] = {};
    for (const [key, value] of Object.entries(draft.fields)) {
      const field = target.fields[key];
      const prop = field && native.properties[field.property];
      if (!field || !prop || value.type !== field.type)
        throw new Error("The draft changed its configured field mapping");
      structuredFieldValueSchema.parse(value);
      if (value.type === "text")
        result[prop.id] =
          prop.type === "title"
            ? { title: chunks(value.value) }
            : { rich_text: chunks(value.value) };
      else if (value.type === "choice")
        result[prop.id] =
          prop.type === "status"
            ? { status: { name: value.value } }
            : { select: { name: value.value } };
      else if (value.type === "number") result[prop.id] = { number: value.value };
      else if (value.type === "boolean") result[prop.id] = { checkbox: value.value };
      else if (value.type === "url") result[prop.id] = { url: value.value };
      else result[prop.id] = { date: { start: value.value } };
    }
    if (target.ownerProperty) {
      const account = await ownerAccount(draft);
      result[native.properties[target.ownerProperty]!.id] = {
        people: account ? [{ id: account }] : []
      };
    }
    if (target.sourceProperty)
      result[native.properties[target.sourceProperty]!.id] = {
        rich_text: chunks(
          draft.source.evidence
            .map(
              (item) =>
                item.reference.externalReference?.url ??
                item.reference.sourceObjectId ??
                item.id
            )
            .join("\n")
        )
      };
    if (target.workLinkProperty && draft.relatedWork) {
      const nativeProperty = native.properties[target.workLinkProperty]!;
      result[nativeProperty.id] =
        nativeProperty.type === "url"
          ? { url: draft.relatedWork.url }
          : { rich_text: chunks(draft.relatedWork.url) };
    }
    return result;
  };
  const sameDraft = async (
    candidate: StructuredRecord,
    draft: StructuredRecordCreate,
    operationId: string,
    signal: AbortSignal
  ) => {
    if (
      Object.entries(draft.fields).some(
        ([key, value]) =>
          operationDigest(candidate.fields[key] ?? null) !== operationDigest(value)
      ) ||
      !(await hasStamp(candidate.reference.externalId, stamp(draft, operationId), signal))
    )
      return false;
    const target = targetFor(draft.schema.targetKey);
    if (
      Object.entries(draft.schema.defaults).some(
        ([key, value]) =>
          operationDigest(draft.fields[key] ?? null) !== operationDigest(value)
      )
    )
      throw new Error("The initial structured defaults changed");
    const native = await schema(target, draft.source.audience, signal);
    const expected = await properties(draft, target, native.raw);
    const actual = pageSchema.parse(
      await readNative(signal, () =>
        client.pages.retrieve({ page_id: candidate.reference.externalId })
      )
    );
    await record(actual, target, draft.source.audience, signal);
    // Compare each managed native value, independent of provider-added rich-text metadata.
    for (const [propertyId, value] of Object.entries(expected)) {
      const current = Object.values(actual.properties).find(
        (prop) => prop.id === propertyId
      );
      if (!current) return false;
      const payload = value as Record<string, unknown>;
      if ("title" in payload || "rich_text" in payload) {
        const type = "title" in payload ? "title" : "rich_text";
        if (textOf(current[type]) !== textOf(payload[type])) return false;
      } else if ("people" in payload) {
        if (
          operationDigest(
            z
              .array(z.object({ id: z.string() }).passthrough())
              .parse(current["people"])
              .map((person) => person.id)
              .sort()
          ) !==
          operationDigest(
            z
              .array(z.object({ id: z.string() }))
              .parse(payload["people"])
              .map((person) => person.id)
              .sort()
          )
        )
          return false;
      } else {
        const key = Object.keys(payload)[0]!;
        const right = payload[key];
        const left = current[key];
        if (key === "select" || key === "status") {
          if (
            z.object({ name: z.string() }).passthrough().parse(left).name !==
            z.object({ name: z.string() }).parse(right).name
          )
            return false;
        } else if (key === "date") {
          if (
            z.object({ start: z.string() }).passthrough().parse(left).start !==
            z.object({ start: z.string() }).parse(right).start
          )
            return false;
        } else if (left !== right) return false;
      }
    }
    return true;
  };
  return {
    providerId: "notion",
    inspect: (input) =>
      bounded((signal) => inspect(input.audience, input.targetKey, signal)),
    requireCurrent: (input) =>
      bounded(async (signal) => {
        if (
          operationDigest(
            await inspect(input.audience, input.snapshot.schema.targetKey, signal)
          ) !== operationDigest(input.snapshot)
        )
          throw new Error("The structured target changed");
      }),
    read: (input) =>
      bounded((signal) => read(input.audience, input.targetKey, input.reference, signal)),
    findCreated: (input) =>
      bounded(async (signal) => {
        if (
          operationDigest(input.audience) !== operationDigest(input.draft.source.audience)
        )
          throw new Error("Recovery cannot change original recipients");
        const snapshot = await inspect(
          input.audience,
          input.draft.schema.targetKey,
          signal
        );
        if (!snapshot.complete)
          throw new Error(
            "The original create cannot be recovered from incomplete discovery"
          );
        const matches: StructuredRecord[] = [];
        for (const candidate of snapshot.records)
          if (await sameDraft(candidate, input.draft, input.operationId, signal))
            matches.push(candidate);
        if (matches.length > 1)
          throw new Error(
            "The original structured write has ambiguous positive evidence"
          );
        return matches[0] ?? null;
      }),
    create: (input) =>
      bounded(async (signal) => {
        let dispatched = false;
        try {
          const draft = structuredClone(input.draft);
          const target = targetFor(draft.schema.targetKey);
          if (
            operationDigest(input.audience) !== operationDigest(draft.source.audience) ||
            !input.expected.complete ||
            operationDigest(input.expected.schema) !== operationDigest(draft.schema)
          )
            throw new Error("The approved draft changed schema or audience");
          const native = await schema(target, input.audience, signal);
          if (native.owned.revision !== draft.schema.revision)
            throw new Error("The current schema changed");
          for (const [key, value] of Object.entries(draft.fields)) {
            const field = draft.schema.fields.find((field) => field.key === key);
            if (
              !field ||
              field.type !== value.type ||
              (value.type === "choice" && !field.choices.includes(value.value))
            )
              throw new Error("The draft contains an unsupported field or option");
          }
          if (
            draft.schema.fields.some(
              (field) => field.required && !draft.fields[field.key]
            )
          )
            throw new Error("Required fields are missing");
          const body = draft.source.evidence
            .map(
              (item) =>
                `${item.reference.externalReference?.url ?? item.reference.sourceObjectId ?? item.id}\n${item.text}`
            )
            .join("\n\n");
          if (body.length > 64000)
            throw new Error("The original source exceeds the structured record bound");
          const evidence = chunks(body).map((part) => ({
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: { rich_text: [part] }
          }));
          const createProperties = await properties(draft, target, native.raw);
          const page = await request({
            signal,
            readOnly: false,
            beforeDispatch: async () => {
              await input.requireCurrent();
              const current = await inspect(input.audience, target.key, signal);
              if (operationDigest(current) !== operationDigest(input.expected))
                throw new Error("The current canonical table changed before create");
              if (
                operationDigest(
                  await properties(
                    draft,
                    target,
                    (await schema(target, input.audience, signal)).raw
                  )
                ) !== operationDigest(createProperties)
              )
                throw new Error("The exact owner/property mapping changed");
              await input.requireCurrent();
              await grant(
                input.audience,
                target.dataSourceId,
                "data-source",
                signal,
                target
              );
            },
            send: () => {
              dispatched = true;
              return client.pages.create({
                parent: { type: "data_source_id", data_source_id: target.dataSourceId },
                properties: createProperties,
                children: [
                  ...evidence,
                  {
                    object: "block",
                    type: "code",
                    code: {
                      language: "plain text",
                      rich_text: chunks(stamp(draft, input.operationId))
                    }
                  }
                ]
              });
            }
          });
          const created = await record(page, target, input.audience, signal);
          if (!(await sameDraft(created, draft, input.operationId, signal)))
            throw new Error("The created structured record could not be verified");
          return created;
        } catch (error) {
          if (!dispatched)
            throw new StructuredRecordNotAppliedError(
              "The source, audience, schema or canonical target refused the create before dispatch"
            );
          throw error;
        }
      })
  };
}
