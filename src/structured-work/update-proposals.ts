import type {
  StructuredRecord,
  StructuredRecordSnapshot,
  StructuredWorkInterpretation,
  StructuredWorkUpdateProposal,
  StructuredWorkUpdateValue
} from "../domain/structured-work.js";
import type { WorkItem } from "../work/interface.js";
import { operationDigest } from "./persistence.js";

/** Only approved field keys and exact selected snapshots contribute to this presentation. */
export function manualUpdateProposals(input: {
  plan: StructuredWorkInterpretation;
  records: StructuredRecordSnapshot;
  record: StructuredRecord | null;
  work: WorkItem | null;
  workUpdatesSupported: boolean;
  workIdentityProviderId: string;
  owner: { providerId: string; providerUserId: string; displayName: string } | null;
}): StructuredWorkUpdateProposal[] {
  const proposals: StructuredWorkUpdateProposal[] = [];
  const change = (
    key: string,
    label: string,
    before: StructuredWorkUpdateValue | null,
    after: StructuredWorkUpdateValue | null
  ): StructuredWorkUpdateProposal["changes"] =>
    operationDigest(before) === operationDigest(after)
      ? []
      : [{ key, label, before: structuredClone(before), after: structuredClone(after) }];
  if (input.plan.record.reconciliation.action === "update" && input.record) {
    proposals.push({
      target: "record",
      reference: structuredClone(input.record.reference),
      expectedVersion: input.record.version,
      reason: "provider-conditional-update-unavailable",
      changes: Object.entries(input.plan.record.fields).flatMap(([key, after]) =>
        change(
          key,
          input.records.schema.fields.find((field) => field.key === key)!.label,
          input.record!.fields[key] ?? null,
          after
        )
      )
    });
  }
  if (
    input.plan.work.reconciliation.action === "update" &&
    input.work &&
    !input.workUpdatesSupported
  ) {
    const work = input.work;
    proposals.push({
      target: "work",
      reference: {
        providerId: work.providerId,
        externalId: work.externalId,
        objectType: "work-item",
        url: work.url,
        version: work.updatedAt
      },
      expectedVersion: work.updatedAt,
      reason: "provider-conditional-update-unavailable",
      changes: [
        ...change(
          "title",
          "Title",
          { type: "text", value: work.title },
          {
            type: "text",
            value: input.plan.work.title
          }
        ),
        ...change(
          "description",
          "Description",
          { type: "text", value: work.description },
          {
            type: "text",
            value: input.plan.work.description
          }
        ),
        ...(operationDigest(work.assignees.map((person) => person.id).sort()) ===
        operationDigest(input.owner ? [input.owner.providerUserId] : [])
          ? []
          : change(
              "assignees",
              "Assignees",
              {
                type: "people",
                value: work.assignees.map((person) => ({
                  providerId: input.workIdentityProviderId,
                  providerUserId: person.id,
                  displayName: person.displayName
                }))
              },
              { type: "people", value: input.owner ? [input.owner] : [] }
            ))
      ]
    });
  }
  return proposals.filter((proposal) => proposal.changes.length > 0);
}
