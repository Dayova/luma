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
import type { DecisionEvidenceSource } from "./ports.js";

type ConversationSubject = Extract<DecisionSubject, { type: "conversation-thread" }>;

/** Original bounded Conversation evidence, with fresh identity and original-audience proof. */
export function createConversationDecisionEvidenceSource(input: {
  workspaceId: string;
  conversationEvidenceSource: ConversationEvidenceSource;
  ledger: ObservedSourceLedger;
  accessPolicy: WorkspaceAccessPolicy;
  recipientPersonIds: readonly string[];
}): DecisionEvidenceSource {
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
    capturedAt: string
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
      if (!generatedPoll && (!personId || !recipients.includes(personId)))
        throw unavailable();
      bindings.push({ messageId: message.id, personId });
      const append = (kind: "message" | "poll", text: string) => {
        const id = `decision-evidence:${hash([boundSubject, revision, message.id, kind])}`;
        evidence.push({
          id,
          text,
          authorPersonId: kind === "poll" ? null : personId,
          origin: kind === "poll" ? "poll" : generatedPoll ? "provider-derived" : "human",
          reference: {
            evidenceId: id,
            source: "external-activity",
            sourceObjectId: message.id,
            sourceVersion: revision,
            ...(personId ? { participantId: personId } : {}),
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
        bindings
      ]),
      audience: boundAudience,
      evidence,
      capturedAt
    };
  }

  const source: DecisionEvidenceSource = {
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
      const boundSubject = subject(original.subject);
      const boundAudience = audience(original.audience);
      const revision = Number(original.revision);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        String(revision) !== original.revision
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
        retained.capturedAt
      );
      if (hash(prior) !== hash(original)) throw unavailable();
      const current = structuredClone(
        await input.conversationEvidenceSource.capture({
          workspaceId: input.workspaceId,
          subject: boundSubject,
          purpose: "decision-record"
        })
      );
      const proof = await project(
        current,
        boundSubject,
        boundAudience,
        original.revision,
        original.capturedAt
      );
      if (proof.authorizationHash !== original.authorizationHash) throw unavailable();
    }
  };
  return source;
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
