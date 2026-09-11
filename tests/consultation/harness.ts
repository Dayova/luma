import { vi } from "vitest";
import type {
  ConsultationProvider,
  ConsultationReceipt,
  AdvisoryConsultation
} from "../../src/consultation/interface.js";
import type {
  CapturedConversationEvidence,
  CaptureConversationEvidenceInput
} from "../../src/context-intelligence/conversation-evidence-source.js";
import { createConversationConsultations } from "../../src/context-intelligence/conversation-consultations.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type { LumaDatabase } from "../../src/persistence/db.js";
import type { ConsultationRequest } from "../../src/context-intelligence/conversation-consultations.js";

export const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
export const subject = {
  type: "conversation-thread" as const,
  providerId: "discord",
  conversationObjectId: "200000000000000001",
  anchorMessageId: "300000000000000001"
};
export const sourceURL = `https://discord.com/channels/guild/${subject.conversationObjectId}/${subject.anchorMessageId}`;
export function captureFixture(): CapturedConversationEvidence {
  return {
    source: {
      providerId: "discord",
      sourceKind: "conversation",
      sourceObjectId: subject.anchorMessageId,
      parentObjectId: subject.conversationObjectId,
      url: sourceURL
    },
    providerVersion: null,
    observedAt: "2026-09-11T10:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      conversation: {
        conversationObjectId: subject.conversationObjectId,
        parentConversationObjectId: "100000000000000001",
        title: "Luma launch",
        url: sourceURL
      },
      boundary: {
        mode: "thread",
        anchorMessageId: subject.anchorMessageId,
        firstMessageId: subject.anchorMessageId,
        lastMessageId: subject.anchorMessageId,
        messageIds: [subject.anchorMessageId]
      },
      messages: [
        {
          id: subject.anchorMessageId,
          ordinal: 0,
          author: {
            providerUserId: "779381502311137301",
            displayName: "Jakob",
            personId: "person_jakob"
          },
          createdAt: "2026-09-11T09:00:00.000Z",
          editedAt: null,
          replyToMessageId: null,
          url: sourceURL,
          state: "available",
          text: "Sollten wir zuerst intern testen oder direkt live gehen?"
        }
      ],
      completeness: { state: "complete" }
    }
  };
}
export function requestFixture(): ConsultationRequest {
  return {
    workspace,
    subject,
    consultationId: "request-1",
    actor: { providerId: "discord", providerUserId: "779381502311137301" },
    instruction: {
      purpose: "Consult founders about launch timing",
      question: "Launch approach?",
      options: ["Internal pilot", "Launch now"],
      ownerPersonId: "person_jakob"
    }
  };
}
export function receiptFixture(plan: AdvisoryConsultation): ConsultationReceipt {
  return {
    reference: {
      providerId: "discord",
      objectType: "other",
      externalId: "400000000000000001",
      url: "https://discord.com/channels/guild/thread/poll",
      version: "bound-plan-message-reference"
    },
    origin: "luma",
    disposition: "published",
    observedAt: "2026-09-11T10:00:00.000Z",
    mention: "verified-role",
    poll: {
      question: plan.question,
      options: plan.options.map((text, index) => ({
        id: String(index + 1),
        text,
        emoji: null
      })),
      allowsMultiple: plan.allowsMultiple,
      closesAt: "2026-09-12T10:00:00.000Z",
      wordingOrigin: "luma-generated",
      results: { status: "unknown", reason: "missing" }
    }
  };
}
export function harness(database: LumaDatabase) {
  const evidence = captureFixture();
  const capture = vi.fn((_input: CaptureConversationEvidenceInput) => {
    void _input;
    return Promise.resolve(structuredClone(evidence));
  });
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    identityDirectory: createLumaTeamIdentityDirectory(),
    authorizedPersonIds: dayovaFounderPersonIds
  });
  const context = createConversationConsultations({
    database,
    ledger: createObservedSourceLedger({ database }),
    evidenceSource: { capture },
    accessPolicy,
    workspaceId: workspace.workspaceId,
    recipientPersonIds: dayovaFounderPersonIds,
    recipientGroupId: "500000000000000001"
  });
  const publish = vi.fn<ConsultationProvider["publish"]>(({ consultation }) =>
    Promise.resolve(receiptFixture(consultation))
  );
  const findPublished = vi.fn<ConsultationProvider["findPublished"]>(() =>
    Promise.resolve(null)
  );
  const read = vi.fn<ConsultationProvider["read"]>(({ consultation }) =>
    Promise.resolve(receiptFixture(consultation))
  );
  const close = vi.fn<ConsultationProvider["close"]>(({ consultation }) => {
    const receipt = receiptFixture(consultation);
    receipt.poll.results = {
      status: "finalized",
      counts: [
        { optionId: "1", votes: 1 },
        { optionId: "2", votes: 3 }
      ]
    };
    return Promise.resolve(receipt);
  });
  const model = {
    generateStructured: vi.fn(() => {
      throw new Error("No model belongs in consultation authorization or execution");
    })
  };
  const provider: ConsultationProvider = {
    providerId: "discord",
    publish,
    findPublished,
    read,
    close
  };
  const execution = createFollowUpExecution({
    database,
    meetingIntelligence: createMeetingIntelligence({ database, reasoningModel: model }),
    conversationConsultations: context,
    consultationProvider: provider,
    now: () => new Date("2026-09-11T10:00:00.000Z")
  });
  return {
    context,
    execution,
    provider,
    evidence,
    capture,
    publish,
    findPublished,
    read,
    close,
    model,
    accessPolicy
  };
}
