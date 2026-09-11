import type { ProcessedConversationSources } from "../context-intelligence/processed-conversation-source.js";
import { createHash } from "node:crypto";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "../context-intelligence/conversation-evidence-source.js";
import { consultationSourceAuthorizationHash } from "../consultation/source-proof.js";
import type {
  DecisionAudience,
  DecisionEvidence,
  DecisionSource,
  DecisionSubject
} from "../domain/decision-records.js";
import {
  conversationSnapshotContentHash,
  type ObservedSourceLedger,
  type RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { DecisionEvidenceSource, ProcessedDecisionEvidenceSource } from "./ports.js";

type ConversationSubject = Extract<DecisionSubject, { type: "conversation-thread" }>;
export interface ConversationDecisionEvidenceSource
  extends DecisionEvidenceSource, ProcessedDecisionEvidenceSource {
  /** Read/projection permission for immutable retained history; never authorizes execution. */
  authorizeRetained(input: {
    audience: DecisionAudience;
    source: DecisionSource;
  }): Promise<boolean>;
}

/** Original bounded Conversation evidence, with fresh identity and original-audience proof. */
export function createConversationDecisionEvidenceSource(input: {
  workspaceId: string;
  processedSources?: ProcessedConversationSources;
  conversationEvidenceSource: ConversationEvidenceSource;
  ledger: ObservedSourceLedger;
  accessPolicy: WorkspaceAccessPolicy;
  recipientPersonIds: readonly string[];
}): ConversationDecisionEvidenceSource {
  const recipients = [...input.recipientPersonIds].sort();
  if (
    !input.workspaceId.trim() ||
    !recipients.length ||
    recipients.some((person) => !person.trim()) ||
    new Set(recipients).size !== recipients.length
  )
    throw new Error("Decision source requires an explicit unique recipient audience");

  function subject(value: DecisionSubject): ConversationSubject {
    if (
      value.type !== "conversation-thread" ||
      !value.providerId.trim() ||
      !value.conversationObjectId.trim() ||
      !value.anchorMessageId.trim()
    )
      throw unavailable();
    return value;
  }
  function audience(value: DecisionAudience): DecisionAudience {
    if (
      value.workspaceId !== input.workspaceId ||
      hash([...value.personIds].sort()) !== hash(recipients)
    )
      throw unavailable();
    return { workspaceId: input.workspaceId, personIds: [...recipients] };
  }
  async function project(
    captured: CapturedConversationEvidence,
    boundSubject: ConversationSubject,
    boundAudience: DecisionAudience,
    revision: string,
    capturedAt: string,
    processedAdmissionId?: string
  ): Promise<DecisionSource> {
    validateCapture(captured, boundSubject);
    const evidence: DecisionEvidence[] = [];
    const bindings: Array<{ messageId: string; personId: string | null }> = [];
    for (const message of captured.snapshot.messages) {
      if (message.state !== "available") throw unavailable();
      const generatedPoll = message.poll?.wordingOrigin === "luma-generated";
      const person = await input.accessPolicy.authorize({
        workspaceId: input.workspaceId,
        providerId: boundSubject.providerId,
        providerUserId: message.author.providerUserId
      });
      // The owned capture adapter proves Luma poll origin. Its text and counts
      // remain generated/provider facts and can never establish Human authority.
      const personId = generatedPoll ? null : (person?.personId ?? null);
      if (
        processedAdmissionId &&
        !generatedPoll &&
        message.author.personId !== null &&
        message.author.personId !== personId
      )
        throw unavailable();
      const originalPersonId =
        processedAdmissionId && message.author.personId === null ? null : personId;
      if (!generatedPoll && (!personId || !recipients.includes(personId)))
        throw unavailable();
      bindings.push({ messageId: message.id, personId });
      const append = (kind: "message" | "poll", text: string) => {
        const id = `decision-evidence:${hash([boundSubject, revision, message.id, kind])}`;
        evidence.push({
          id,
          text,
          authorPersonId: kind === "poll" ? null : originalPersonId,
          origin: kind === "poll" ? "poll" : generatedPoll ? "provider-derived" : "human",
          reference: {
            evidenceId: id,
            source: "external-activity",
            sourceObjectId: message.id,
            sourceVersion: revision,
            ...(originalPersonId ? { participantId: originalPersonId } : {}),
            excerpt: text,
            externalReference: {
              providerId: boundSubject.providerId,
              objectType: "comment",
              externalId: message.id,
              url: message.url,
              version: revision
            }
          }
        });
      };
      if (message.text.trim()) append("message", message.text);
      if (message.poll)
        append(
          "poll",
          JSON.stringify({
            description:
              "Advisory native poll; aggregate results are not Human decision authority.",
            creatorProviderUserId: message.author.providerUserId,
            poll: message.poll
          })
        );
    }
    return {
      subject: structuredClone(boundSubject),
      revision,
      contentHash: conversationSnapshotContentHash(captured.snapshot),
      authorizationHash: hash([
        consultationSourceAuthorizationHash(captured.snapshot),
        boundAudience,
        bindings,
        ...(processedAdmissionId ? [processedAdmissionId] : [])
      ]),
      audience: boundAudience,
      evidence,
      capturedAt
    };
  }

  async function originalProof(original: DecisionSource) {
    const boundSubject = subject(original.subject);
    const boundAudience = audience(original.audience);
    const processed = /^processed:(\d+):([a-f0-9]{64})$/u.exec(original.revision);
    const revision = Number(processed?.[1] ?? original.revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      String(revision) !== (processed?.[1] ?? original.revision)
    )
      throw unavailable();
    const retained = await input.ledger.get({
      workspaceId: input.workspaceId,
      source: {
        providerId: boundSubject.providerId,
        sourceKind: "conversation",
        sourceObjectId: boundSubject.anchorMessageId
      },
      revision
    });
    if (!retained || retained.contentHash !== original.contentHash) throw unavailable();
    if (processed) {
      if (!input.processedSources) throw unavailable();
      const proof = await input.processedSources.read({
        workspaceId: input.workspaceId,
        subject: boundSubject,
        audience: boundAudience,
        admissionId: processed[2]!
      });
      if (
        proof.original.revision !== revision ||
        proof.original.contentHash !== original.contentHash
      )
        throw unavailable();
    }
    const prior = await project(
      {
        source: retained.source,
        providerVersion: retained.providerVersion,
        snapshot: retained.snapshot,
        observedAt: retained.capturedAt
      },
      boundSubject,
      boundAudience,
      original.revision,
      retained.capturedAt,
      processed?.[2]
    );
    if (hash(prior) !== hash(original)) throw unavailable();
    return {
      boundSubject,
      boundAudience,
      retained,
      processedAdmissionId: processed?.[2]
    };
  }

  const source: ConversationDecisionEvidenceSource = {
    async captureProcessed(request) {
      const boundSubject = subject(request.subject),
        boundAudience = audience(request.audience);
      if (request.workspace.workspaceId !== input.workspaceId || !input.processedSources)
        throw unavailable();
      const proof = await input.processedSources.read({
        workspaceId: input.workspaceId,
        subject: boundSubject,
        audience: boundAudience
      });
      const result = await project(
        {
          source: proof.original.source,
          providerVersion: proof.original.providerVersion,
          snapshot: proof.original.snapshot,
          observedAt: proof.original.capturedAt
        },
        boundSubject,
        boundAudience,
        `processed:${proof.original.revision}:${proof.admission.id}`,
        proof.original.capturedAt,
        proof.admission.id
      );
      await source.requireCurrent(result);
      return result;
    },
    async capture(request) {
      request = structuredClone(request);
      const boundSubject = subject(request.subject);
      const boundAudience = audience(request.audience);
      if (
        request.workspace.workspaceId !== input.workspaceId ||
        request.actor.providerId !== boundSubject.providerId ||
        !request.instruction.trim()
      )
        throw unavailable();
      const actor = await input.accessPolicy.authorize({
        workspaceId: input.workspaceId,
        ...request.actor
      });
      if (!actor || !recipients.includes(actor.personId)) throw unavailable();
      const captured = structuredClone(
        await input.conversationEvidenceSource.capture({
          workspaceId: input.workspaceId,
          subject: boundSubject,
          question: request.instruction,
          purpose: "decision-record"
        })
      );
      validateCapture(captured, boundSubject);
      const anchor = captured.snapshot.messages.at(-1)!;
      if (
        anchor.author.providerUserId !== request.actor.providerUserId ||
        anchor.state !== "available" ||
        anchor.poll?.wordingOrigin === "luma-generated"
      )
        throw unavailable();
      // Resolve every current author before admitting the immutable raw capture.
      await project(
        captured,
        boundSubject,
        boundAudience,
        "admission",
        captured.observedAt
      );
      const recorded = await input.ledger.record({
        workspaceId: input.workspaceId,
        ...captured
      });
      const result = await project(
        { ...captured, snapshot: recorded.snapshot },
        boundSubject,
        boundAudience,
        String(recorded.revision),
        recorded.capturedAt
      );
      await source.requireCurrent(result);
      return result;
    },
    async requireCurrent(original) {
      original = structuredClone(original);
      const { boundSubject, boundAudience, processedAdmissionId } =
        await originalProof(original);
      const current = structuredClone(
        await input.conversationEvidenceSource.capture({
          workspaceId: input.workspaceId,
          subject: boundSubject,
          ...(!processedAdmissionId ? { purpose: "decision-record" as const } : {})
        })
      );
      const proof = await project(
        current,
        boundSubject,
        boundAudience,
        original.revision,
        original.capturedAt,
        processedAdmissionId
      );
      if (proof.authorizationHash !== original.authorizationHash) throw unavailable();
    },
    async authorizeRetained(request) {
      try {
        const { source: original, audience: requested } = structuredClone(request);
        if (
          requested.workspaceId !== input.workspaceId ||
          !requested.personIds.length ||
          new Set(requested.personIds).size !== requested.personIds.length ||
          requested.personIds.some(
            (personId) => !original.audience.personIds.includes(personId)
          )
        )
          return false;
        // Reconstruct the original source from its immutable ledger revision. A
        // canonical page cannot supply a replacement audience or invented excerpt.
        const { boundSubject, boundAudience, retained, processedAdmissionId } =
          await originalProof(original);
        const current = structuredClone(
          await input.conversationEvidenceSource.capture({
            workspaceId: input.workspaceId,
            subject: boundSubject,
            ...(!processedAdmissionId ? { purpose: "decision-record" as const } : {})
          })
        );
        // This fresh projection verifies complete source scope and current unique
        // author identities. Its new words never replace the retained source.
        await project(
          current,
          boundSubject,
          boundAudience,
          original.revision,
          original.capturedAt,
          processedAdmissionId
        );
        return (
          hash(retainedBoundary(retained.snapshot)) ===
          hash(retainedBoundary(current.snapshot))
        );
      } catch {
        return false;
      }
    }
  };
  return source;
}

/** Stable object identities and source presence, excluding mutable wording/labels. */
function retainedBoundary(snapshot: RawConversationSnapshot): unknown {
  return {
    conversationObjectId: snapshot.conversation.conversationObjectId,
    parentConversationObjectId: snapshot.conversation.parentConversationObjectId,
    boundary: snapshot.boundary,
    messages: snapshot.messages.map((message) => {
      if (message.state !== "available") throw unavailable();
      return {
        id: message.id,
        ordinal: message.ordinal,
        providerUserId: message.author.providerUserId,
        createdAt: message.createdAt,
        replyToMessageId: message.replyToMessageId,
        url: message.url,
        hasText: !!message.text.trim(),
        pollOrigin: message.poll?.wordingOrigin ?? null
      };
    })
  };
}

function validateCapture(
  captured: CapturedConversationEvidence,
  subject: ConversationSubject
): void {
  const snapshot: RawConversationSnapshot = captured.snapshot;
  // This also validates native poll structure without inferring counts or votes.
  conversationSnapshotContentHash(snapshot);
  const messages = snapshot.messages;
  if (
    captured.source.providerId !== subject.providerId ||
    captured.source.sourceKind !== "conversation" ||
    captured.source.sourceObjectId !== subject.anchorMessageId ||
    captured.source.parentObjectId !== subject.conversationObjectId ||
    snapshot.conversation.conversationObjectId !== subject.conversationObjectId ||
    snapshot.boundary.anchorMessageId !== subject.anchorMessageId ||
    snapshot.boundary.lastMessageId !== subject.anchorMessageId ||
    snapshot.completeness.state !== "complete" ||
    !messages.length ||
    messages.length > 500 ||
    JSON.stringify(snapshot).length > 1_000_000 ||
    messages.some(
      (message, index) =>
        message.state !== "available" ||
        message.ordinal !== index ||
        !safeUrl(message.url)
    ) ||
    new Set(messages.map((message) => message.id)).size !== messages.length ||
    hash(snapshot.boundary.messageIds) !== hash(messages.map((message) => message.id)) ||
    messages[0]?.id !== snapshot.boundary.firstMessageId ||
    messages.at(-1)?.id !== subject.anchorMessageId ||
    !messages.at(-1)?.text?.trim()
  )
    throw unavailable();
}
function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, child: unknown) => {
        if (!child || typeof child !== "object" || Array.isArray(child)) return child;
        return Object.fromEntries(
          Object.entries(child).sort(([left], [right]) => left.localeCompare(right))
        );
      })
    )
    .digest("hex");
}
function unavailable(): Error {
  return new Error(
    "The exact complete decision source, original audience or current author identity could not be verified."
  );
}
