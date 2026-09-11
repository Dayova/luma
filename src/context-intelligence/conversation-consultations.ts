import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  AdvisoryConsultation,
  ConsultationReceipt
} from "../consultation/interface.js";
import { consultationSourceAuthorizationHash } from "../consultation/source-proof.js";
import type { ConversationEvidenceSource } from "./conversation-evidence-source.js";
import type { ConversationContextSubject } from "./interface.js";
import type {
  EvidenceReference,
  PersonId,
  Provenance,
  WorkspaceConfig
} from "../domain/model.js";
import {
  conversationSnapshotContentHash,
  type ObservedSourceLedger
} from "../knowledge/observed-source-ledger.js";
import type { LumaDatabase } from "../persistence/db.js";

export type ConversationConsultationSubject = ConversationContextSubject;
export type ConsultationActor = { providerId: string; providerUserId: string };
export type ConsultationFollowUpIntent = {
  id: string;
  type: "publish-consultation" | "close-consultation";
  consultationId: string;
  status: "approved";
  authorization: { authorizedBy: PersonId; evidenceId: string; authorizedAt: string };
  provenance: Provenance;
};
export type ConversationConsultation = {
  workspaceId: string;
  subject: ConversationConsultationSubject;
  consultation: AdvisoryConsultation;
  publication: ConsultationReceipt | null;
};
export type ConsultationRequest = {
  workspace: WorkspaceConfig;
  subject: ConversationConsultationSubject;
  consultationId: string;
  actor: ConsultationActor;
  /** Authenticated ingress supplies this exact explicit instruction; Ask never does. */
  instruction: {
    purpose: string;
    question: string;
    options: string[];
    durationHours?: number;
    allowsMultiple?: boolean;
    ownerPersonId?: string;
    replacesConsultationId?: string;
  };
};
export type ConsultationAddress = {
  workspaceId: string;
  subject: ConversationConsultationSubject;
  consultationId: string;
};
export type ConsultationOperationAddress = {
  workspaceId: string;
  subject: ConversationConsultationSubject;
  intentId: string;
};
export type StoredConsultationOperation = {
  intent: ConsultationFollowUpIntent;
  operationId: string;
  state: "approved" | "executing" | "succeeded" | "not-applied" | "unknown";
  record: ConversationConsultationExecutionRecord | null;
  consultation: ConversationConsultation;
};
export type ConversationConsultationExecutionRecord = {
  type: "follow-up-execution-recorded";
  recordId: string;
  workspaceId: string;
  subject: ConversationConsultationSubject;
  intentId: string;
  consultationId: string;
  operationId: string;
  recordedAt: string;
  outcome:
    | { status: "succeeded"; receipt: ConsultationReceipt }
    | {
        status: "failed";
        errorCode: string;
        message: string;
        requiresManualRecovery: boolean;
      };
};
export interface ConversationConsultations {
  request(
    input: ConsultationRequest
  ): Promise<{ consultation: ConversationConsultation; intentId: string }>;
  requestClose(
    input: ConsultationAddress & { requestId: string; actor: ConsultationActor }
  ): Promise<{ intentId: string }>;
  requireCurrent(consultation: ConversationConsultation): Promise<void>;
  get(input: ConsultationAddress): Promise<ConversationConsultation>;
  readJudgments(input: ConsultationAddress): Promise<
    Array<{
      personId: string;
      choice: string;
      rationale: string;
      authority: "accountable-owner" | "founder-opinion";
    }>
  >;
  recordJudgment(
    input: ConsultationAddress & {
      judgmentId: string;
      actor: ConsultationActor;
      choice: string;
      rationale: string;
    }
  ): Promise<void>;
}
export class ConversationConsultationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function consultationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function consultationSubjectKey(subject: ConversationConsultationSubject): string {
  return JSON.stringify([
    subject.type,
    subject.providerId,
    subject.conversationObjectId,
    subject.anchorMessageId
  ]);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}
function validateSubject(subject: ConversationConsultationSubject): void {
  if (
    subject?.type !== "conversation-thread" ||
    !validId(subject.providerId) ||
    !validId(subject.conversationObjectId) ||
    !validId(subject.anchorMessageId)
  ) {
    throw new ConversationConsultationError(
      "consultation-subject-invalid",
      "Select one exact Conversation and source message."
    );
  }
}
function validateRequest(request: ConsultationRequest): void {
  validateSubject(request.subject);
  const { instruction } = request;
  if (
    !validId(request.consultationId) ||
    !validId(request.workspace.workspaceId) ||
    !instruction.purpose.trim() ||
    instruction.purpose.length > 500 ||
    !instruction.question.trim() ||
    instruction.question.length > 300 ||
    instruction.options.length < 2 ||
    instruction.options.length > 10 ||
    instruction.options.some((option) => !option.trim() || option.length > 55) ||
    new Set(instruction.options.map((option) => option.trim().toLocaleLowerCase("en-US")))
      .size !== instruction.options.length ||
    !Number.isSafeInteger(instruction.durationHours ?? 24) ||
    (instruction.durationHours ?? 24) < 1 ||
    (instruction.durationHours ?? 24) > 768
  ) {
    throw new ConversationConsultationError(
      "consultation-input-invalid",
      "Provide a purpose, distinct bounded alternatives, and a supported duration."
    );
  }
}

/** Context owns capture and canonical authorization. It never publishes or calls a model. */
export function createConversationConsultations(input: {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  evidenceSource: ConversationEvidenceSource;
  accessPolicy: WorkspaceAccessPolicy;
  workspaceId: string;
  recipientPersonIds: readonly string[];
  recipientGroupId: string;
  now?: () => Date;
}): ConversationConsultations {
  const now = input.now ?? (() => new Date());
  const recipients = [...input.recipientPersonIds].sort();
  if (
    !validId(input.workspaceId) ||
    !validId(input.recipientGroupId) ||
    !recipients.length ||
    new Set(recipients).size !== recipients.length
  )
    throw new Error("Canonical consultation recipients must be configured explicitly");
  async function actor(
    workspaceId: string,
    identity: ConsultationActor
  ): Promise<string> {
    if (workspaceId !== input.workspaceId)
      throw new ConversationConsultationError(
        "consultation-access-refused",
        "This workspace is not authorized."
      );
    const authorized = await input.accessPolicy.authorize({ workspaceId, ...identity });
    if (!authorized || !recipients.includes(authorized.personId))
      throw new ConversationConsultationError(
        "consultation-access-refused",
        "Only an authorized founder can issue this instruction."
      );
    return authorized.personId;
  }
  async function requireCurrent(record: ConversationConsultation): Promise<void> {
    const plan = record.consultation;
    if (
      record.workspaceId !== input.workspaceId ||
      consultationDigest([...plan.recipientPersonIds].sort()) !==
        consultationDigest(recipients) ||
      plan.recipientGroupId !== input.recipientGroupId
    )
      throw new ConversationConsultationError(
        "consultation-policy-changed",
        "The original consultation recipients are no longer authorized."
      );
    const current = await input.evidenceSource.capture({
      workspaceId: record.workspaceId,
      subject: record.subject,
      purpose: "consultation",
      question: plan.source.question
    });
    if (
      current.source.providerId !== record.subject.providerId ||
      current.source.sourceKind !== "conversation" ||
      current.source.sourceObjectId !== record.subject.anchorMessageId ||
      current.source.parentObjectId !== record.subject.conversationObjectId ||
      consultationSourceAuthorizationHash(current.snapshot) !==
        plan.source.authorizationHash
    ) {
      throw new ConversationConsultationError(
        "consultation-source-changed",
        "The original source wording or access changed; this consultation cannot be published or displayed."
      );
    }
  }
  async function get(address: ConsultationAddress): Promise<ConversationConsultation> {
    validateSubject(address.subject);
    const result = await readCanonicalConsultation(input.database, address);
    if (!result)
      throw new ConversationConsultationError(
        "consultation-not-found",
        "No canonical consultation exists for this Conversation and ID."
      );
    await requireCurrent(result);
    return result;
  }
  return {
    requireCurrent,
    get,
    async request(rawRequest) {
      const request = structuredClone(rawRequest);
      validateRequest(request);
      const personId = await actor(request.workspace.workspaceId, request.actor);
      const address = {
        workspaceId: request.workspace.workspaceId,
        subject: request.subject,
        consultationId: request.consultationId
      };
      const requestDigest = consultationDigest({
        workspaceId: request.workspace.workspaceId,
        subject: request.subject,
        consultationId: request.consultationId,
        actor: request.actor,
        instruction: request.instruction
      });
      const existing = await readCanonicalConsultation(input.database, address);
      if (existing) {
        const row = await input.database.query<{ request_digest: string }>(
          "SELECT request_digest FROM conversation_consultations WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3",
          [
            address.workspaceId,
            consultationSubjectKey(address.subject),
            address.consultationId
          ]
        );
        if (row.rows[0]?.request_digest !== requestDigest)
          throw new ConversationConsultationError(
            "consultation-request-conflict",
            "This consultation ID already has a different immutable instruction."
          );
        await requireCurrent(existing);
        return {
          consultation: existing,
          intentId: publishIntentId(existing.consultation.id)
        };
      }
      if (
        request.instruction.ownerPersonId &&
        !recipients.includes(request.instruction.ownerPersonId)
      )
        throw new ConversationConsultationError(
          "consultation-owner-unresolved",
          "The named accountable owner is not an authorized founder."
        );
      const captured = await input.evidenceSource.capture({
        workspaceId: address.workspaceId,
        subject: address.subject,
        purpose: "consultation"
      });
      if (
        captured.source.providerId !== address.subject.providerId ||
        captured.source.sourceKind !== "conversation" ||
        captured.source.sourceObjectId !== address.subject.anchorMessageId ||
        captured.source.parentObjectId !== address.subject.conversationObjectId ||
        captured.snapshot.completeness.state !== "complete" ||
        captured.snapshot.messages.some((message) => message.state !== "available")
      ) {
        throw new ConversationConsultationError(
          "consultation-source-incomplete",
          "A complete current bounded founder discussion is required before publication."
        );
      }
      const anchor = captured.snapshot.messages.find(
        (message) => message.id === address.subject.anchorMessageId
      );
      if (!anchor || anchor.state !== "available" || !anchor.text.trim())
        throw new ConversationConsultationError(
          "consultation-source-incomplete",
          "The selected founder source message is unavailable."
        );
      const pollCount = captured.snapshot.messages.filter(
        (message) => message.state === "available" && message.poll
      ).length;
      if (pollCount > 10)
        throw new ConversationConsultationError(
          "consultation-polls-unbounded",
          "Select a bounded discussion containing at most ten poll candidates."
        );
      const recorded = await input.ledger.record({
        workspaceId: address.workspaceId,
        ...captured
      });
      const evidence: EvidenceReference = {
        evidenceId: `consultation-instruction:${request.consultationId}`,
        source: "human-judgment",
        sourceObjectId: request.consultationId,
        participantId: personId,
        excerpt:
          "Explicit founder instruction to publish the exact bounded advisory consultation."
      };
      const provenance: Provenance = {
        evidence: [
          evidence,
          {
            evidenceId: `consultation-source:${recorded.contentHash}`,
            source: "external-activity",
            sourceObjectId: address.subject.anchorMessageId,
            sourceVersion: String(recorded.revision),
            excerpt: anchor.text
          }
        ],
        confidence: "high",
        producedAtRevision: recorded.revision,
        analysisVersion: "human-consultation-v1"
      };
      const plan: AdvisoryConsultation = {
        id: request.consultationId,
        choice: {
          type: "conversation-evidence",
          messageIds: [...captured.snapshot.boundary.messageIds],
          pollMessageIds: captured.snapshot.messages
            .filter((message) => message.state === "available" && message.poll)
            .map((message) => message.id)
        },
        purpose: request.instruction.purpose,
        question: request.instruction.question,
        options: [...request.instruction.options],
        durationHours: request.instruction.durationHours ?? 24,
        allowsMultiple: request.instruction.allowsMultiple ?? false,
        owner: request.instruction.ownerPersonId
          ? {
              personId: request.instruction.ownerPersonId,
              authorityEvidenceId: evidence.evidenceId
            }
          : null,
        recipientPersonIds: recipients,
        recipientGroupId: input.recipientGroupId,
        source: {
          workspaceId: address.workspaceId,
          subject: address.subject,
          question: anchor.text,
          capturePurpose: "consultation",
          contentHash: conversationSnapshotContentHash(captured.snapshot),
          authorizationHash: consultationSourceAuthorizationHash(captured.snapshot)
        },
        authorization: {
          basis: "explicit-instruction",
          evidenceId: evidence.evidenceId,
          authorizedBy: personId
        },
        provenance,
        replacesConsultationId: request.instruction.replacesConsultationId ?? null
      };
      const choiceKey = consultationDigest({
        question: plan.question,
        options: plan.options,
        allowsMultiple: plan.allowsMultiple,
        authorizationHash: plan.source.authorizationHash,
        replacesConsultationId: plan.replacesConsultationId
      });
      const sameChoice = await input.database.query<{ consultation_id: string }>(
        `SELECT consultation_id FROM conversation_consultations
        WHERE workspace_id=$1 AND subject_key=$2 AND choice_key=$3`,
        [address.workspaceId, consultationSubjectKey(address.subject), choiceKey]
      );
      if (sameChoice.rows[0]) {
        const previous = await get({
          ...address,
          consultationId: sameChoice.rows[0].consultation_id
        });
        if (
          previous.consultation.purpose !== plan.purpose ||
          previous.consultation.durationHours !== plan.durationHours ||
          previous.consultation.owner?.personId !== plan.owner?.personId
        ) {
          throw new ConversationConsultationError(
            "consultation-instruction-changed",
            "This choice already has a consultation with a different purpose, duration or owner. Select that original consultation explicitly as a replacement instead of silently changing its instruction."
          );
        }
        return {
          consultation: previous,
          intentId: publishIntentId(previous.consultation.id)
        };
      }
      if (
        plan.replacesConsultationId &&
        !(await readCanonicalConsultation(input.database, {
          ...address,
          consultationId: plan.replacesConsultationId
        }))
      )
        throw new ConversationConsultationError(
          "consultation-replacement-not-found",
          "Select the exact retained consultation in this source boundary to replace."
        );
      const record: ConversationConsultation = {
        workspaceId: address.workspaceId,
        subject: address.subject,
        consultation: plan,
        publication: null
      };
      await requireCurrent(record);
      const intent: ConsultationFollowUpIntent = {
        id: publishIntentId(plan.id),
        type: "publish-consultation",
        consultationId: plan.id,
        status: "approved",
        authorization: {
          authorizedBy: personId,
          evidenceId: evidence.evidenceId,
          authorizedAt: now().toISOString()
        },
        provenance
      };
      await input.database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO conversation_consultations (workspace_id, subject_key, consultation_id, request_digest, choice_key, plan_json, plan_digest, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            address.workspaceId,
            consultationSubjectKey(address.subject),
            plan.id,
            requestDigest,
            choiceKey,
            JSON.stringify(plan),
            consultationDigest(plan),
            now().toISOString()
          ]
        );
        const rows = await transaction.query<{
          request_digest: string;
          plan_json: string;
        }>(
          `SELECT request_digest,plan_json FROM conversation_consultations
          WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3 FOR UPDATE`,
          [address.workspaceId, consultationSubjectKey(address.subject), plan.id]
        );
        if (rows.rows[0]?.request_digest !== requestDigest)
          throw new ConversationConsultationError(
            "consultation-request-conflict",
            "A different request owns this consultation ID."
          );
        await insertConsultationOperation(transaction, address, intent, now());
      });
      return {
        consultation: (await readCanonicalConsultation(input.database, address))!,
        intentId: intent.id
      };
    },
    async requestClose(request) {
      const personId = await actor(request.workspaceId, request.actor);
      const record = await get(request);
      if (
        !validId(request.requestId) ||
        !record.publication ||
        record.publication.origin !== "luma"
      )
        throw new ConversationConsultationError(
          "consultation-close-refused",
          "Only a positively recorded Luma poll can be closed."
        );
      const intentId = `close-consultation:${request.consultationId}`;
      const existing = await input.database.query(
        `SELECT intent_id FROM conversation_consultation_operations WHERE workspace_id=$1 AND subject_key=$2 AND intent_id=$3`,
        [request.workspaceId, consultationSubjectKey(request.subject), intentId]
      );
      if (existing.rows.length) return { intentId };
      const intent: ConsultationFollowUpIntent = {
        id: intentId,
        type: "close-consultation",
        consultationId: request.consultationId,
        status: "approved",
        authorization: {
          authorizedBy: personId,
          evidenceId: `close-instruction:${request.requestId}`,
          authorizedAt: now().toISOString()
        },
        provenance: record.consultation.provenance
      };
      await insertConsultationOperation(input.database, request, intent, now());
      return { intentId: intent.id };
    },
    async readJudgments(address) {
      await get(address);
      const rows = await input.database.query<{
        payload_json: string;
        payload_digest: string;
      }>(
        `SELECT payload_json,payload_digest FROM conversation_consultation_events
        WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3 AND kind='human-judgment' ORDER BY recorded_at DESC, event_id DESC LIMIT 20`,
        [
          address.workspaceId,
          consultationSubjectKey(address.subject),
          address.consultationId
        ]
      );
      return rows.rows.map((row) => {
        const value = JSON.parse(row.payload_json) as {
          personId: string;
          choice: string;
          rationale: string;
          authority: "accountable-owner" | "founder-opinion";
        };
        if (consultationDigest(value) !== row.payload_digest)
          throw new ConversationConsultationError(
            "consultation-corrupt",
            "Human Judgment history failed its integrity check."
          );
        return value;
      });
    },
    async recordJudgment(request) {
      const personId = await actor(request.workspaceId, request.actor);
      const record = await get(request);
      if (
        !validId(request.judgmentId) ||
        !request.choice.trim() ||
        request.choice.length > 300 ||
        !request.rationale.trim() ||
        request.rationale.length > 2_000
      )
        throw new ConversationConsultationError(
          "consultation-judgment-invalid",
          "Record the Human choice and rationale explicitly."
        );
      const judgment = {
        judgmentId: request.judgmentId,
        personId,
        choice: request.choice,
        rationale: request.rationale,
        authority:
          record.consultation.owner?.personId === personId
            ? "accountable-owner"
            : "founder-opinion"
      };
      await appendConsultationEvent(
        input.database,
        request,
        request.judgmentId,
        "human-judgment",
        judgment,
        now()
      );
    }
  };
}

function publishIntentId(id: string): string {
  return `publish-consultation:${id}`;
}
export async function readCanonicalConsultation(
  database: Pick<LumaDatabase, "query">,
  address: ConsultationAddress
): Promise<ConversationConsultation | null> {
  const row = (
    await database.query<{
      plan_json: string;
      plan_digest: string;
      publication_json: string | null;
      publication_digest: string | null;
    }>(
      `SELECT plan_json,plan_digest,publication_json,publication_digest FROM conversation_consultations WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3`,
      [
        address.workspaceId,
        consultationSubjectKey(address.subject),
        address.consultationId
      ]
    )
  ).rows[0];
  if (!row) return null;
  const consultation = JSON.parse(row.plan_json) as AdvisoryConsultation;
  const publication = row.publication_json
    ? (JSON.parse(row.publication_json) as ConsultationReceipt)
    : null;
  if (
    consultationDigest(consultation) !== row.plan_digest ||
    consultation.id !== address.consultationId ||
    consultation.source.workspaceId !== address.workspaceId ||
    consultationSubjectKey(consultation.source.subject) !==
      consultationSubjectKey(address.subject) ||
    (publication && consultationDigest(publication) !== row.publication_digest)
  )
    throw new ConversationConsultationError(
      "consultation-corrupt",
      "Canonical consultation history failed its integrity check."
    );
  return {
    workspaceId: address.workspaceId,
    subject: structuredClone(address.subject),
    consultation,
    publication
  };
}
export async function readConsultationOperation(
  database: Pick<LumaDatabase, "query">,
  address: ConsultationOperationAddress
): Promise<StoredConsultationOperation> {
  const row = (
    await database.query<{
      consultation_id: string;
      intent_json: string;
      intent_digest: string;
      operation_id: string;
      state: StoredConsultationOperation["state"];
      record_json: string | null;
      record_digest: string | null;
    }>(
      `SELECT consultation_id,intent_json,intent_digest,operation_id,state,record_json,record_digest FROM conversation_consultation_operations WHERE workspace_id=$1 AND subject_key=$2 AND intent_id=$3`,
      [address.workspaceId, consultationSubjectKey(address.subject), address.intentId]
    )
  ).rows[0];
  if (!row)
    throw new ConversationConsultationError(
      "consultation-intent-not-found",
      "No approved Conversation intent exists for this exact subject and ID."
    );
  const intent = JSON.parse(row.intent_json) as ConsultationFollowUpIntent;
  if (
    consultationDigest(intent) !== row.intent_digest ||
    intent.id !== address.intentId ||
    intent.consultationId !== row.consultation_id ||
    intent.status !== "approved"
  )
    throw new ConversationConsultationError(
      "consultation-corrupt",
      "The canonical approved intent failed its integrity check."
    );
  const consultation = await readCanonicalConsultation(database, {
    ...address,
    consultationId: row.consultation_id
  });
  if (!consultation)
    throw new ConversationConsultationError(
      "consultation-corrupt",
      "The approved intent has no canonical consultation."
    );
  const record = row.record_json
    ? (JSON.parse(row.record_json) as ConversationConsultationExecutionRecord)
    : null;
  if (
    record &&
    (consultationDigest(record) !== row.record_digest ||
      record.intentId !== intent.id ||
      record.operationId !== row.operation_id ||
      record.workspaceId !== address.workspaceId ||
      consultationSubjectKey(record.subject) !==
        consultationSubjectKey(address.subject) ||
      record.consultationId !== intent.consultationId)
  )
    throw new ConversationConsultationError(
      "consultation-corrupt",
      "The stored Execution Record failed its integrity check."
    );
  return {
    intent,
    operationId: row.operation_id,
    state: row.state,
    record,
    consultation
  };
}
async function insertConsultationOperation(
  database: Pick<LumaDatabase, "query">,
  address: ConsultationAddress,
  intent: ConsultationFollowUpIntent,
  now: Date
): Promise<void> {
  await database.query(
    `INSERT INTO conversation_consultation_operations (workspace_id,subject_key,intent_id,consultation_id,intent_json,intent_digest,operation_id,state,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8) ON CONFLICT DO NOTHING`,
    [
      address.workspaceId,
      consultationSubjectKey(address.subject),
      intent.id,
      address.consultationId,
      JSON.stringify(intent),
      consultationDigest(intent),
      randomUUID(),
      now.toISOString()
    ]
  );
  const existing = await readConsultationOperation(database, {
    ...address,
    intentId: intent.id
  });
  // Time of repeated ingress is not a new authorization; identity and plan remain fixed.
  if (
    existing.intent.type !== intent.type ||
    existing.intent.consultationId !== intent.consultationId ||
    existing.intent.authorization.authorizedBy !== intent.authorization.authorizedBy ||
    existing.intent.authorization.evidenceId !== intent.authorization.evidenceId
  )
    throw new ConversationConsultationError(
      "consultation-request-conflict",
      "This operation ID already belongs to a different authorized instruction."
    );
}
export async function appendConsultationEvent(
  database: Pick<LumaDatabase, "query">,
  address: ConsultationAddress,
  eventId: string,
  kind: string,
  value: unknown,
  now: Date
): Promise<void> {
  const digest = consultationDigest(value);
  await database.query(
    `INSERT INTO conversation_consultation_events (workspace_id,subject_key,consultation_id,event_id,kind,payload_json,payload_digest,recorded_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      address.workspaceId,
      consultationSubjectKey(address.subject),
      address.consultationId,
      eventId,
      kind,
      JSON.stringify(value),
      digest,
      now.toISOString()
    ]
  );
  const row = (
    await database.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM conversation_consultation_events
    WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3 AND event_id=$4`,
      [
        address.workspaceId,
        consultationSubjectKey(address.subject),
        address.consultationId,
        eventId
      ]
    )
  ).rows[0];
  if (row?.payload_digest !== digest)
    throw new ConversationConsultationError(
      "consultation-event-conflict",
      "This receipt identity already records different history."
    );
}
