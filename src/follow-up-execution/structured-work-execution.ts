import { structuredWorkEvidence } from "../domain/structured-work.js";
import type { StructuredWorkExecution } from "../structured-work/interface.js";
import {
  operationDigest,
  readStructuredWork,
  saveStructuredWork,
  type StoredStructuredWork,
  type StoredOperationStage
} from "../structured-work/persistence.js";
import {
  requireStructuredWorkCurrent,
  readStructuredWorkState,
  searchStructuredWork,
  selectRecord,
  selectWork,
  structuredWorkLock,
  workReference,
  type StructuredWorkDependencies
} from "../structured-work/structured-work.js";
import { StructuredRecordNotAppliedError } from "../knowledge/structured-records.js";
import { withExecutionRunLock } from "./execution-run-lock.js";
import { requireStructuredWorkOwnership } from "../structured-work/ownership.js";
import type { CreateWorkItemInput } from "../work/interface.js";
import type { ExternalReference } from "../domain/model.js";

function evidenceDescription(stored: StoredStructuredWork): string {
  return structuredWorkEvidence(stored.state.source)
    .map(
      (item) =>
        `${item.reference.externalReference?.url ?? item.reference.sourceObjectId ?? item.id}\n${item.text}`
    )
    .join("\n\n");
}
function makeWorkInput(
  stored: StoredStructuredWork,
  stage: StoredOperationStage
): CreateWorkItemInput {
  const record =
    stored.stages.find((stage) => stage.target === "record")?.reference ??
    selectRecord(stored)?.reference;
  return {
    title: stored.state.preview!.work.title,
    description: `${stored.state.preview!.work.description}\n\n${record ? `Structured record: ${record.url}\n\n` : ""}Original source Evidence:\n${evidenceDescription(stored)}`,
    assigneeProviderUserId: stored.ownerProviderUserId,
    mentionProviderUserIds: [],
    dueDate: null,
    labels: [],
    idempotencyKey: stage.operationId
  };
}
async function workMatches(
  input: StructuredWorkDependencies,
  stage: StoredOperationStage,
  reference: ExternalReference
): Promise<boolean> {
  if (
    !stage.workInput ||
    reference.providerId !== input.work.providerId ||
    reference.objectType !== "work-item"
  )
    return false;
  const work = await input.work.getWorkItem(reference.externalId);
  const wanted = stage.workInput;
  const marker = `<!-- luma-idempotency-key: ${wanted.idempotencyKey} -->`;
  return (
    work.externalId === reference.externalId &&
    work.providerId === reference.providerId &&
    work.url === reference.url &&
    work.title === wanted.title &&
    work.description === `${wanted.description.trim()}\n\n${marker}` &&
    work.dueDate === wanted.dueDate &&
    (wanted.assigneeProviderUserId === null
      ? work.assignees.length === 0
      : work.assignees.length === 1 &&
        work.assignees[0]?.id === wanted.assigneeProviderUserId)
  );
}
async function workUpdateMatches(
  input: StructuredWorkDependencies,
  stage: StoredOperationStage,
  reference: ExternalReference
): Promise<boolean> {
  if (!stage.workInput || reference.providerId !== input.work.providerId) return false;
  const current = await input.work.getWorkItem(reference.externalId);
  const desired = stage.workInput;
  return (
    current.externalId === reference.externalId &&
    current.providerId === reference.providerId &&
    current.url === reference.url &&
    current.description === `${desired.description}\n\n${stage.operationId}` &&
    current.title === desired.title &&
    (desired.assigneeProviderUserId === null
      ? current.assignees.length === 0
      : current.assignees.length === 1 &&
        current.assignees[0]!.id === desired.assigneeProviderUserId)
  );
}
export function createStructuredWorkExecution(
  input: StructuredWorkDependencies
): StructuredWorkExecution {
  const run = (
    request: Parameters<StructuredWorkExecution["execute"]>[0],
    recovery: boolean
  ) =>
    withExecutionRunLock(input.database, structuredWorkLock(input), async () => {
      const stored = await readStructuredWork(
        input.database,
        request.workspace.workspaceId,
        request.structuredWorkRequestId
      );
      if (
        !stored ||
        operationDigest(stored.state.subject) !== operationDigest(request.subject) ||
        !stored.intent ||
        stored.intent.id !== request.intentId ||
        stored.intent.status !== "approved" ||
        stored.intent.planHash !== operationDigest(stored.state.preview)
      )
        throw new Error(
          "Only the original canonical approved compound intent may execute"
        );
      await requireStructuredWorkCurrent(input, stored);
      for (const stage of stored.stages) {
        if (stage.state === "succeeded") continue;
        const save = async () => {
          const previous = await readStructuredWork(
            input.database,
            request.workspace.workspaceId,
            request.structuredWorkRequestId
          );
          if (!previous) throw new Error("The original compound request disappeared");
          await saveStructuredWork(input.database, stored, operationDigest(previous));
        };
        if (["executing", "unknown"].includes(stage.state)) {
          if (!recovery) break;
          await requireStructuredWorkCurrent(input, stored);
          let found: ExternalReference | null = null;
          try {
            if (stage.target === "record" && stage.recordDraft) {
              const record = await input.records.findCreated({
                audience: stored.state.source.audience,
                draft: stage.recordDraft,
                operationId: stage.operationId
              });
              if (record) found = record.reference;
            } else if (
              stage.target === "work" &&
              stage.action === "create" &&
              input.work.findCreatedWorkItemByIdempotencyKey
            ) {
              const reference = await input.work.findCreatedWorkItemByIdempotencyKey(
                stage.operationId
              );
              if (reference && (await workMatches(input, stage, reference)))
                found = reference;
            } else if (stage.target === "work" && stage.action === "update") {
              const target = selectWork(stored);
              if (target) {
                const current = await input.work.getWorkItem(target.id);
                // A matching value alone cannot prove a particular update's origin.
                if (await workUpdateMatches(input, stage, workReference(current)))
                  found = workReference(current);
              }
            }
          } catch {
            /* Indeterminate probes never authorize another mutation. */
          }
          stage.state = found ? "succeeded" : "unknown";
          stage.reference = found ?? stage.reference;
          stage.message = found
            ? "Recovered the exact original external result without resending"
            : "The original write remains unknown; no duplicate was sent";
          await save();
          if (!found) break;
          continue;
        }
        // Recovery is read-only. A new explicit execute may continue a positively recovered bundle.
        if (recovery) break;
        try {
          await requireStructuredWorkCurrent(input, stored);
          if (stage.action === "link") {
            if (stage.target === "record") {
              const selected = selectRecord(stored)!;
              const current = await input.records.read({
                audience: stored.state.source.audience,
                targetKey: stored.records.schema.targetKey,
                reference: selected.reference
              });
              if (current.version !== selected.version)
                throw new StructuredRecordNotAppliedError(
                  "The selected structured record changed"
                );
              stage.reference = current.reference;
            } else {
              const selected = selectWork(stored)!;
              const current = await input.work.getWorkItem(selected.id);
              if (operationDigest(current) !== operationDigest(selected))
                throw new StructuredRecordNotAppliedError(
                  "The selected work item changed"
                );
              stage.reference = workReference(current);
            }
            stage.state = "succeeded";
            stage.message = "Linked the current existing canonical record";
            await save();
            continue;
          }
          if (stage.target === "record")
            stage.recordDraft ??= {
              schema: stored.records.schema,
              fields: stored.state.preview!.record.fields,
              source: stored.state.source,
              ownerPersonId: requireStructuredWorkOwnership(
                stored.state.source,
                stored.state.preview!.work.ownership
              ),
              relatedWork:
                stored.stages.find((stage) => stage.target === "work")?.reference ??
                (selectWork(stored) ? workReference(selectWork(stored)!) : null)
            };
          else stage.workInput ??= makeWorkInput(stored, stage);
          // Persist exact external payload and an in-flight claim BEFORE any possible send.
          stage.state = "executing";
          stage.message = "The external write may be in progress";
          await save();
          await requireStructuredWorkCurrent(input, stored);
          if (stage.target === "record") {
            const record = await input.records.create({
              audience: stored.state.source.audience,
              draft: stage.recordDraft!,
              expected: stored.records,
              operationId: stage.operationId,
              requireCurrent: () => requireStructuredWorkCurrent(input, stored)
            });
            stage.reference = record.reference;
          } else {
            const finalProof = async () => {
              await requireStructuredWorkCurrent(input, stored);
              const current = await searchStructuredWork(
                input,
                request.workspace.workspaceId,
                stored.workSearch
              );
              if (operationDigest(current) !== operationDigest(stored.work))
                throw new StructuredRecordNotAppliedError(
                  "Canonical work changed before the exact operation"
                );
            };
            await finalProof();
            if (stage.action === "create") {
              const reference = await input.work.createWorkItem({
                ...stage.workInput!,
                requireCurrent: finalProof
              });
              if (!(await workMatches(input, stage, reference)))
                throw new Error("The exact created work could not be verified");
              stage.reference = reference;
            } else {
              const selected = selectWork(stored)!;
              if (!input.work.updateWorkItemIfCurrent)
                throw new StructuredRecordNotAppliedError(
                  "Conditional work updates are unavailable"
                );
              const reference = await input.work.updateWorkItemIfCurrent(selected.id, {
                title: stage.workInput!.title,
                description: `${stage.workInput!.description}\n\n${stage.operationId}`,
                assigneeProviderUserId: stage.workInput!.assigneeProviderUserId,
                idempotencyKey: stage.operationId,
                expectedUpdatedAt: selected.updatedAt
              });
              if (!reference)
                throw new StructuredRecordNotAppliedError(
                  "The existing work changed before its conditional update"
                );
              if (!(await workUpdateMatches(input, stage, reference)))
                throw new Error("The updated work could not be verified");
              stage.reference = reference;
            }
          }
          stage.state = "succeeded";
          stage.message = "The exact external result was verified";
          await save();
        } catch (error) {
          // Never discard a known positive reference when later local persistence fails.
          stage.state = stage.reference
            ? "succeeded"
            : error instanceof StructuredRecordNotAppliedError ||
                stage.state !== "executing"
              ? "not-applied"
              : "unknown";
          stage.message = stage.reference
            ? "External result known; local settlement needs recovery"
            : stage.state === "unknown"
              ? "The provider result is unknown; use recovery without resending"
              : "The current source, schema, target or owner refused the operation before send";
          try {
            await save();
          } catch {
            // A positive external reference must survive even if the final success
            // transition is refused. Keep it alongside an explicitly unknown settlement.
            if (stage.reference) {
              stage.state = "unknown";
              try {
                await save();
              } catch {
                /* Original in-flight claim still prevents resend. */
              }
            }
          }
          break;
        }
      }
      return readStructuredWorkState(input, {
        workspaceId: request.workspace.workspaceId,
        subject: request.subject,
        query: {
          type: "structured-work-request",
          requestId: request.structuredWorkRequestId
        }
      });
    });
  return {
    execute: (request) => run(request, false),
    recover: (request) => run(request, true)
  };
}
