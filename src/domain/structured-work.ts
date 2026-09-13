import type { EvidenceReference, ExternalReference, WorkspaceConfig } from "./model.js";
import type { WorkItem } from "../work/interface.js";

/** A bounded original Conversation is never represented as a synthetic Meeting. */
export type StructuredWorkConversationSubject = {
  type: "conversation-thread";
  providerId: string;
  conversationObjectId: string;
  anchorMessageId: string;
};
export type StructuredWorkSubject =
  StructuredWorkConversationSubject | { type: "meeting"; meetingId: string };
export type StructuredWorkAudience = { workspaceId: string; personIds: string[] };
export type StructuredWorkActor = { providerId: string; providerUserId: string };
export type StructuredWorkOriginalSource = {
  subject: StructuredWorkSubject;
  revision: string;
  contentHash: string;
  authorizationHash: string;
  audience: StructuredWorkAudience;
  capturedAt: string;
  evidence: Array<{
    id: string;
    reference: EvidenceReference;
    text: string;
    authorPersonId: string | null;
    origin: "human" | "provider-derived" | "poll";
  }>;
};
export type StructuredWorkSource = StructuredWorkOriginalSource & {
  /** Distinct original command; imported speaker attribution remains untouched. */
  instructionSource?: StructuredWorkOriginalSource & {
    subject: StructuredWorkConversationSubject;
  };
};
export function structuredWorkEvidence(
  source: StructuredWorkSource
): StructuredWorkOriginalSource["evidence"] {
  return [...source.evidence, ...(source.instructionSource?.evidence ?? [])];
}
export type StructuredFieldValue =
  | { type: "text"; value: string }
  | { type: "choice"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "url"; value: string }
  | { type: "date"; value: string };
export type StructuredRecordField = {
  key: string;
  label: string;
  type: StructuredFieldValue["type"];
  required: boolean;
  choices: string[];
};
/** Provider-specific property IDs, native status IDs and table IDs stay in the adapter. */
export type StructuredRecordSchema = {
  targetKey: string;
  label: string;
  revision: string;
  titleField: string;
  fields: StructuredRecordField[];
  defaults: Record<string, StructuredFieldValue>;
};
export type StructuredRecord = {
  reference: ExternalReference;
  version: string;
  fields: Record<string, StructuredFieldValue>;
  active: boolean;
};
export type StructuredRecordSnapshot = {
  schema: StructuredRecordSchema;
  records: StructuredRecord[];
  complete: boolean;
  revision: string;
};
export type StructuredWorkOwnership =
  | { status: "confirmed"; personId: string; evidenceIds: string[] }
  | { status: "intentionally-unassigned"; evidenceIds: string[] }
  | { status: "unresolved"; reason: string };
export type StructuredWorkReconciliation =
  | { action: "create" }
  | { action: "link" | "update"; targetId: string }
  | { action: "clarify" | "reject"; reason: string };
export type StructuredWorkInterpretation = {
  targetKey: string;
  record: {
    fields: Record<string, StructuredFieldValue>;
    evidenceIds: string[];
    reconciliation: StructuredWorkReconciliation;
  };
  work: {
    title: string;
    description: string;
    evidenceIds: string[];
    ownership: StructuredWorkOwnership;
    reconciliation: StructuredWorkReconciliation;
  };
};
export type StructuredRecordCreate = {
  schema: StructuredRecordSchema;
  fields: Record<string, StructuredFieldValue>;
  source: StructuredWorkSource;
  ownerPersonId: string | null;
  relatedWork: ExternalReference | null;
};
export type StructuredWorkStageResult = {
  target: "record" | "work";
  disposition: "created" | "linked" | "updated" | "not-applied" | "unknown";
  reference: ExternalReference | null;
  message: string;
};
export type StructuredWorkUpdateValue =
  | StructuredFieldValue
  | {
      type: "people";
      value: Array<{ providerId: string; providerUserId: string; displayName: string }>;
    };
/** A retained proposal for manual application, never an approved external write. */
export type StructuredWorkUpdateProposal = {
  target: "record" | "work";
  reference: ExternalReference;
  expectedVersion: string;
  changes: Array<{
    key: string;
    label: string;
    before: StructuredWorkUpdateValue | null;
    after: StructuredWorkUpdateValue | null;
  }>;
  reason: "provider-conditional-update-unavailable";
};
/** User-facing projection; durable execution stages and provider snapshots remain private. */
export type StructuredWorkState = {
  requestId: string;
  subject: StructuredWorkSubject;
  state:
    | "planned"
    | "validated"
    | "partially-executed"
    | "completed"
    | "manual-application-required"
    | "needs-clarification"
    | "failed-recoverable";
  message: string;
  source: StructuredWorkSource;
  preview: StructuredWorkInterpretation | null;
  /** Absent on requests retained before manual update proposals were supported. */
  updateProposals?: StructuredWorkUpdateProposal[];
  approvedIntentId: string | null;
  outcomes: StructuredWorkStageResult[];
};
export type ObserveStructuredWork = {
  workspace: WorkspaceConfig;
  subject: StructuredWorkSubject;
  observations: [
    {
      type: "structured-work-requested";
      observationId: string;
      actor: StructuredWorkActor;
      instruction: string;
      /** A caller may select a configured alias, never a provider object ID. */
      targetKey: string;
      /** Original authenticated command boundary when operating on a real Meeting. */
      instructionSubject?: StructuredWorkConversationSubject;
      /** An explicitly named work identity may be read even when outside ordinary discovery. */
      workItemId?: string;
    }
  ];
};
export type QueryStructuredWork = {
  workspaceId: string;
  subject: StructuredWorkSubject;
  query: { type: "structured-work-request"; requestId: string };
};
export type ConcludeStructuredWork = {
  workspaceId: string;
  subject: StructuredWorkSubject;
  structuredWorkRequestId: string;
};
export type StructuredWorkModelInput = {
  requestId: string;
  workspace: WorkspaceConfig;
  instruction: string;
  requesterPersonId: string;
  source: StructuredWorkSource;
  records: StructuredRecordSnapshot;
  work: WorkItem[];
};
