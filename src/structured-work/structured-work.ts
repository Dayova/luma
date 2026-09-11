import { structuredWorkEvidence } from "../domain/structured-work.js";
import { StructuredWorkClarification } from "./errors.js";
import { isExplicitStructuredWorkInstruction } from "./explicit-instruction.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import type { IdentityDirectory } from "../identity/interface.js";
import type { StructuredRecords } from "../knowledge/structured-records.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { WorkItem, WorkProvider } from "../work/interface.js";
import type {
  QueryStructuredWork,
  StructuredWorkAudience,
  StructuredWorkInterpretation,
  StructuredWorkState
} from "../domain/structured-work.js";
import type {
  StructuredWorkEvidenceSource,
  StructuredWorkIntelligence,
  StructuredWorkInterpreter
} from "./interface.js";
import { withExecutionRunLock } from "../follow-up-execution/execution-run-lock.js";
import {
  migrateStructuredWork,
  operationDigest,
  readStructuredWork,
  saveStructuredWork,
  type StoredStructuredWork
} from "./persistence.js";
import {
  structuredWorkInterpretationSchema,
  structuredWorkSourceSchema
} from "./schemas.js";
import { requireStructuredWorkOwnership } from "./ownership.js";

export type StructuredWorkConfiguration = {
  evidenceSource: StructuredWorkEvidenceSource;
  interpreter: StructuredWorkInterpreter;
  records: StructuredRecords;
  work: WorkProvider;
  workAuthorization: {
    scopeId: string;
    resource: string;
    authorize(audience: StructuredWorkAudience): Promise<boolean>;
  };
  identityDirectory: IdentityDirectory;
  accessPolicy: WorkspaceAccessPolicy;
  audience(workspaceId: string): Promise<StructuredWorkAudience | null>;
  /** Explicit operator configuration, not authority inferred from a title or model output. */
  targets: Array<{ key: string; authorizedPersonIds: string[] }>;
  /** Both are safe independent operations; ordering is fixed before approval. */
  order?: "record-first" | "work-first";
};
export type StructuredWorkDependencies = StructuredWorkConfiguration & {
  database: LumaDatabase;
};

export function structuredWorkLock(input: StructuredWorkDependencies): string {
  return `structured-work:${input.records.providerId}:${input.work.providerId}`;
}
function policyHash(input: StructuredWorkDependencies): string {
  return operationDigest({
    targets: input.targets,
    order: input.order ?? "record-first",
    records: input.records.providerId,
    work: input.work.providerId,
    workScope: input.workAuthorization.scopeId,
    workResource: input.workAuthorization.resource
  });
}
export async function requireStructuredWorkCurrent(
  input: StructuredWorkDependencies,
  stored: StoredStructuredWork
): Promise<void> {
  const observation = stored.request.observations[0];
  const audience = await input.audience(stored.request.workspace.workspaceId);
  if (
    !audience ||
    operationDigest({ ...audience, personIds: [...audience.personIds].sort() }) !==
      operationDigest({
        ...stored.state.source.audience,
        personIds: [...stored.state.source.audience.personIds].sort()
      }) ||
    policyHash(input) !== stored.policyHash
  )
    throw new Error("Source recipients or structured execution policy changed");
  const actor = await input.accessPolicy.authorize({
    workspaceId: audience.workspaceId,
    ...observation.actor
  });
  if (
    actor?.personId !== stored.requesterPersonId ||
    !audience.personIds.includes(actor.personId) ||
    !input.targets.some(
      (target) =>
        target.key === observation.targetKey &&
        target.authorizedPersonIds.includes(actor.personId)
    )
  )
    throw new Error("The requester no longer has permission for this structured target");
  await input.evidenceSource.requireCurrent(stored.state.source);
  if (!(await input.workAuthorization.authorize(stored.state.source.audience)))
    throw new Error(
      "The original audience no longer has a sanctioned work destination grant"
    );
  if (stored.intent && stored.state.preview) {
    const owner = requireStructuredWorkOwnership(
      stored.state.source,
      stored.state.preview.work.ownership
    );
    const mapping = owner ? await ownerMapping(input, audience.workspaceId, owner) : null;
    if (mapping !== stored.ownerProviderUserId)
      throw new Error("The original owner mapping changed");
  }
}
async function ownerMapping(
  input: StructuredWorkDependencies,
  workspaceId: string,
  personId: string
): Promise<string> {
  const person = await input.identityDirectory.getPerson({ workspaceId, personId });
  const account =
    input.work.identityProviderId === "linear" || input.work.providerId === "linear"
      ? person?.linearUserId
      : null;
  if (
    !account ||
    (
      await input.identityDirectory.findPeopleByProviderUserId({
        workspaceId,
        providerId: input.work.identityProviderId ?? input.work.providerId,
        providerUserId: account
      })
    ).filter((person) => person.personId === personId).length !== 1
  )
    throw new Error("The confirmed owner does not have an unambiguous work account");
  const matches = await input.identityDirectory.findPeopleByProviderUserId({
    workspaceId,
    providerId: input.work.identityProviderId ?? input.work.providerId,
    providerUserId: account
  });
  if (matches.length !== 1 || matches[0]?.personId !== personId)
    throw new Error("The owner's work account is ambiguous");
  return account;
}
export async function searchStructuredWork(
  input: StructuredWorkDependencies,
  workspaceId: string,
  text: string
): Promise<WorkItem[]> {
  const audience = await input.audience(workspaceId);
  if (!audience || !(await input.workAuthorization.authorize(audience)))
    throw new Error("The work target is not sanctioned for this audience");
  if (!input.work.discoverWorkItems)
    throw new Error("This work provider cannot prove complete bounded reconciliation");
  const result = await input.work.discoverWorkItems({ workspaceId, limit: 100 });
  const rows = [...result.items];
  if (text) {
    const selected = await input.work.getWorkItem(text);
    if (!rows.some((row) => row.id === selected.id)) rows.push(selected);
  }
  if (
    !result.complete ||
    rows.length > 100 ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => row.providerId !== input.work.providerId)
  )
    throw new Error("The validation-work search is incomplete or ambiguous");
  if (!(await input.workAuthorization.authorize(audience)))
    throw new Error("The work target grant changed during discovery");
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
export function workReference(item: WorkItem) {
  return {
    providerId: item.providerId,
    externalId: item.externalId,
    objectType: "work-item" as const,
    url: item.url,
    version: item.updatedAt
  };
}
export function selectWork(stored: StoredStructuredWork): WorkItem | null {
  const reconciliation = stored.state.preview?.work.reconciliation;
  if (!reconciliation || !("targetId" in reconciliation)) return null;
  const matches = stored.work.filter(
    (item) =>
      item.id === reconciliation.targetId || item.externalId === reconciliation.targetId
  );
  if (matches.length !== 1) throw new Error("Select one unambiguous existing work item");
  return matches[0]!;
}
export function selectRecord(stored: StoredStructuredWork) {
  const reconciliation = stored.state.preview?.record.reconciliation;
  if (!reconciliation || !("targetId" in reconciliation)) return null;
  const matches = stored.records.records.filter(
    (item) => item.reference.externalId === reconciliation.targetId
  );
  if (matches.length !== 1)
    throw new Error("Select one unambiguous existing structured record");
  return matches[0]!;
}
function prepare(
  stored: StoredStructuredWork,
  plan: StructuredWorkInterpretation,
  input: StructuredWorkDependencies
): void {
  if (plan.targetKey !== stored.request.observations[0].targetKey)
    throw new StructuredWorkClarification(
      "The interpretation changed the explicitly selected target"
    );
  for (const operation of [plan.record, plan.work]) {
    if (
      operation.evidenceIds.some(
        (id) =>
          !structuredWorkEvidence(stored.state.source).some((item) => item.id === id)
      )
    )
      throw new StructuredWorkClarification(
        "Every operation needs original source Evidence"
      );
  }
  const fields = { ...stored.records.schema.defaults, ...plan.record.fields };
  if (
    plan.record.reconciliation.action === "create" &&
    Object.entries(stored.records.schema.defaults).some(
      ([key, value]) =>
        plan.record.fields[key] &&
        operationDigest(plan.record.fields[key]) !== operationDigest(value)
    )
  )
    throw new StructuredWorkClarification(
      "A new record must retain its configured initial state; recording a validation result requires a separate explicit request."
    );
  for (const [key, value] of Object.entries(fields)) {
    const field = stored.records.schema.fields.find((field) => field.key === key);
    if (
      !field ||
      field.type !== value.type ||
      (value.type === "choice" && !field.choices.includes(value.value))
    )
      throw new StructuredWorkClarification(
        `The current structured target cannot accept field ${key}`
      );
  }
  if (stored.records.schema.fields.some((field) => field.required && !fields[field.key]))
    throw new StructuredWorkClarification("Required structured fields are missing");
  plan.record.fields = fields;
  stored.state.preview = plan;
  for (const operation of [plan.record, plan.work]) {
    if (["clarify", "reject"].includes(operation.reconciliation.action))
      throw new StructuredWorkClarification(
        "reason" in operation.reconciliation
          ? operation.reconciliation.reason
          : "Clarify the operation"
      );
  }
  const record = selectRecord(stored);
  const work = selectWork(stored);
  if (record && !record.active)
    throw new StructuredWorkClarification(
      "The selected structured record is no longer active"
    );
  if (work && ["completed", "cancelled"].includes(work.status))
    throw new StructuredWorkClarification(
      "The selected validation work is no longer active"
    );
  if (plan.record.reconciliation.action === "update")
    throw new StructuredWorkClarification(
      "This target cannot safely compare and update structured properties; clarify the existing record change"
    );
  if (plan.work.reconciliation.action === "update" && !input.work.updateWorkItemIfCurrent)
    throw new StructuredWorkClarification(
      "This work provider does not support a conditional update; clarify the existing task change"
    );
  if (plan.record.reconciliation.action === "create") {
    const titleKey = stored.records.schema.titleField;
    const title = fields[titleKey];
    if (!title || title.type !== "text")
      throw new StructuredWorkClarification(
        "The structured record needs one exact title"
      );
    if (
      stored.records.records.some(
        (item) =>
          item.active &&
          item.fields[titleKey]?.type === "text" &&
          item.fields[titleKey].value.trim().toLocaleLowerCase() ===
            title.value.trim().toLocaleLowerCase()
      )
    )
      throw new StructuredWorkClarification(
        "An equivalent exact-title record already exists; reconcile it before creation"
      );
  }
  if (
    plan.work.reconciliation.action === "create" &&
    stored.work.some(
      (item) =>
        item.title.trim().toLocaleLowerCase() ===
        plan.work.title.trim().toLocaleLowerCase()
    )
  )
    throw new StructuredWorkClarification(
      "Matching validation work already exists, including historical work; reconcile it before creation"
    );
  if (stored.request.observations[0].workItemId) {
    const selected = stored.work.filter(
      (item) =>
        item.id === stored.request.observations[0].workItemId ||
        item.externalId === stored.request.observations[0].workItemId
    );
    if (selected.length !== 1 || work?.id !== selected[0]!.id)
      throw new StructuredWorkClarification(
        "The model changed the explicitly selected validation task"
      );
  }
}
export function projectStructuredWork(stored: StoredStructuredWork): StructuredWorkState {
  const outcomes = stored.stages
    .filter((stage) => stage.state !== "pending")
    .map((stage) => ({
      target: stage.target,
      disposition:
        stage.state === "succeeded"
          ? stage.action === "link"
            ? ("linked" as const)
            : stage.action === "create"
              ? ("created" as const)
              : ("updated" as const)
          : stage.state === "not-applied"
            ? ("not-applied" as const)
            : ("unknown" as const),
      reference: stage.reference,
      message: stage.message
    }));
  const completed =
    stored.stages.length > 0 &&
    stored.stages.every((stage) => stage.state === "succeeded");
  const partial = stored.stages.some((stage) => stage.state === "succeeded");
  const uncertain = stored.stages.some((stage) =>
    ["executing", "unknown", "not-applied"].includes(stage.state)
  );
  return {
    ...structuredClone(stored.state),
    outcomes,
    state: completed
      ? "completed"
      : partial
        ? "partially-executed"
        : uncertain
          ? "failed-recoverable"
          : stored.state.state,
    message: completed
      ? "The structured record and validation work are linked to this source. Both results are retained."
      : uncertain || partial
        ? "The bundle is incomplete. Known results are retained; recover uncertain stages before making another request."
        : stored.state.message
  };
}
export async function readStructuredWorkState(
  input: StructuredWorkDependencies,
  request: QueryStructuredWork
): Promise<StructuredWorkState> {
  const stored = await readStructuredWork(
    input.database,
    request.workspaceId,
    request.query.requestId
  );
  if (
    !stored ||
    operationDigest(stored.state.subject) !== operationDigest(request.subject)
  )
    throw new Error("Select the original structured request in this Conversation");
  const digest = operationDigest(stored);
  await requireStructuredWorkCurrent(input, stored);
  for (const stage of stored.stages)
    if (stage.reference) {
      if (stage.target === "record")
        await input.records.read({
          audience: stored.state.source.audience,
          targetKey: stored.records.schema.targetKey,
          reference: stage.reference
        });
      else {
        const current = await input.work.getWorkItem(stage.reference.externalId);
        if (
          current.providerId !== stage.reference.providerId ||
          current.externalId !== stage.reference.externalId ||
          current.url !== stage.reference.url
        )
          throw new Error("The retained work reference is no longer readable");
      }
    }
  await requireStructuredWorkCurrent(input, stored);
  if (
    operationDigest(
      await readStructuredWork(
        input.database,
        request.workspaceId,
        request.query.requestId
      )
    ) !== digest
  )
    throw new Error(
      "The structured request changed during the final read; read it again"
    );
  return projectStructuredWork(stored);
}

export function createStructuredWorkIntelligence(
  input: StructuredWorkDependencies
): StructuredWorkIntelligence {
  const ready = migrateStructuredWork(input.database);
  const query: StructuredWorkIntelligence["query"] = async (request) => {
    await ready;
    return readStructuredWorkState(input, request);
  };
  return {
    query,
    conclude: async (request) => {
      const result = await query({
        workspaceId: request.workspaceId,
        subject: request.subject,
        query: {
          type: "structured-work-request",
          requestId: request.structuredWorkRequestId
        }
      });
      return { request: result, summary: result.message };
    },
    observe: (request) =>
      withExecutionRunLock(input.database, structuredWorkLock(input), async () => {
        await ready;
        const bound = structuredClone(request);
        const observation = bound.observations[0];
        if (
          bound.observations.length !== 1 ||
          observation?.type !== "structured-work-requested" ||
          !observation.observationId.trim() ||
          observation.observationId.length > 512 ||
          !observation.instruction.trim() ||
          observation.instruction.length > 4000 ||
          !["conversation-thread", "meeting"].includes(bound.subject.type)
        )
          throw new Error("One original bounded compound command is required");
        const address: QueryStructuredWork = {
          workspaceId: bound.workspace.workspaceId,
          subject: bound.subject,
          query: { type: "structured-work-request", requestId: observation.observationId }
        };
        const previous = await readStructuredWork(
          input.database,
          address.workspaceId,
          observation.observationId
        );
        if (previous) {
          if (previous.requestHash !== operationDigest(bound))
            throw new Error(
              "This original command ID has a different instruction or source"
            );
          return { ...(await query(address)), duplicate: true };
        }
        if (!isExplicitStructuredWorkInstruction(observation.instruction))
          throw new Error(
            "An explicit instruction for both structured knowledge and validation work is required"
          );
        const audience = await input.audience(address.workspaceId);
        const person = await input.accessPolicy.authorize({
          workspaceId: address.workspaceId,
          ...observation.actor
        });
        if (
          !audience ||
          !person ||
          audience.workspaceId !== address.workspaceId ||
          !audience.personIds.includes(person.personId) ||
          audience.personIds.length !== new Set(audience.personIds).size ||
          !input.targets.some(
            (target) =>
              target.key === observation.targetKey &&
              target.authorizedPersonIds.includes(person.personId)
          )
        )
          throw new Error(
            "The founder or configured structured target is not authorized"
          );
        const source = structuredWorkSourceSchema.parse(
          await input.evidenceSource.capture({
            workspace: bound.workspace,
            subject: bound.subject,
            ...(observation.instructionSubject
              ? { instructionSubject: observation.instructionSubject }
              : {}),
            instruction: observation.instruction,
            actor: observation.actor,
            audience
          })
        );
        if (
          (bound.subject.type === "meeting" &&
            (!observation.instructionSubject ||
              !source.instructionSource ||
              operationDigest(source.instructionSource.subject) !==
                operationDigest(observation.instructionSubject))) ||
          (bound.subject.type === "conversation-thread" &&
            (!!observation.instructionSubject || !!source.instructionSource)) ||
          operationDigest(source.subject) !== operationDigest(bound.subject) ||
          operationDigest({
            ...source.audience,
            personIds: [...source.audience.personIds].sort()
          }) !==
            operationDigest({ ...audience, personIds: [...audience.personIds].sort() })
        )
          throw new Error("The source changed its original boundary or audience");
        const records = await input.records.inspect({
          audience,
          targetKey: observation.targetKey
        });
        if (
          records.schema.targetKey !== observation.targetKey ||
          records.records.length > 100 ||
          new Set(records.records.map((item) => item.reference.externalId)).size !==
            records.records.length
        )
          throw new Error("The structured target is ambiguous or unbounded");
        const titleKey = records.schema.titleField;
        const workSearch = observation.workItemId ?? "";
        const work = await searchStructuredWork(input, address.workspaceId, workSearch);
        const stored: StoredStructuredWork = {
          request: bound,
          requestHash: operationDigest(bound),
          requesterPersonId: person.personId,
          policyHash: policyHash(input),
          ownerProviderUserId: null,
          records,
          work,
          workSearch,
          state: {
            requestId: observation.observationId,
            subject: bound.subject,
            state: "planned",
            message:
              "Interpretation is incomplete. The retained command is never silently charged again.",
            source,
            preview: null,
            approvedIntentId: null,
            outcomes: []
          },
          stages: [],
          intent: null
        };
        await requireStructuredWorkCurrent(input, stored);
        await saveStructuredWork(input.database, stored, null);
        const digest = operationDigest(stored);
        try {
          if (!records.complete || !titleKey)
            throw new Error(
              "The current structured table could not be completely inspected"
            );
          // After durable paid-attempt admission, recheck before any model disclosure.
          await requireStructuredWorkCurrent(input, stored);
          await input.records.requireCurrent({ audience, snapshot: records });
          if (
            operationDigest(
              await searchStructuredWork(input, address.workspaceId, workSearch)
            ) !== operationDigest(work)
          )
            throw new Error("Canonical work changed before interpretation");
          await requireStructuredWorkCurrent(input, stored);
          const plan = structuredWorkInterpretationSchema.parse(
            await input.interpreter.interpret(
              {
                requestId: observation.observationId,
                workspace: bound.workspace,
                instruction: observation.instruction,
                requesterPersonId: person.personId,
                source: structuredClone(source),
                records: structuredClone(records),
                work: structuredClone(work)
              },
              {
                requireCurrent: async () => {
                  await requireStructuredWorkCurrent(input, stored);
                  await input.records.requireCurrent({ audience, snapshot: records });
                  if (
                    operationDigest(
                      await searchStructuredWork(input, address.workspaceId, workSearch)
                    ) !== operationDigest(work)
                  )
                    throw new Error("Canonical work changed before model dispatch");
                  await requireStructuredWorkCurrent(input, stored);
                }
              }
            )
          );
          prepare(stored, plan, input);
          const owner = requireStructuredWorkOwnership(source, plan.work.ownership);
          stored.ownerProviderUserId = owner
            ? await ownerMapping(input, address.workspaceId, owner)
            : null;
          await requireStructuredWorkCurrent(input, stored);
          await input.records.requireCurrent({ audience, snapshot: records });
          if (
            operationDigest(
              await searchStructuredWork(input, address.workspaceId, workSearch)
            ) !== operationDigest(work)
          )
            throw new Error(
              "Canonical work changed during interpretation; review the current work"
            );
          const intentId = `structured-work:${operationDigest({ requestHash: stored.requestHash, plan, schema: records.schema.revision, work, owner: stored.ownerProviderUserId })}`;
          stored.intent = {
            id: intentId,
            type: "execute-structured-work",
            status: "approved",
            authorization: "explicit-instruction",
            authorizedBy: person.personId,
            planHash: operationDigest(plan)
          };
          stored.state.approvedIntentId = intentId;
          stored.state.state = "validated";
          stored.state.message =
            "The explicit compound request is reconciled and approved for its two exact operations.";
          const order =
            input.order === "work-first"
              ? (["work", "record"] as const)
              : (["record", "work"] as const);
          stored.stages = order.map((target) => {
            const action = plan[target].reconciliation.action;
            if (action !== "link" && action !== "create" && action !== "update")
              throw new Error("A clarification cannot execute");
            return {
              target,
              action,
              state: "pending",
              operationId: `${intentId}:${target}`,
              reference: null,
              message: "Awaiting execution"
            };
          });
        } catch (error) {
          stored.intent = null;
          stored.stages = [];
          stored.state.approvedIntentId = null;
          stored.state.state = "needs-clarification";
          stored.state.message =
            error instanceof AiServiceError
              ? `AI interpretation is unavailable (${error.code}). The original request is retained and will not incur another automatic paid attempt.`
              : error instanceof StructuredWorkClarification
                ? error.message.slice(0, 1000)
                : "The structured record, work scope, source, schema or ownership needs clarification before any write. Review the retained preview and provide a clarified request.";
        }
        await saveStructuredWork(input.database, stored, digest);
        return { ...(await query(address)), duplicate: false };
      })
  };
}
