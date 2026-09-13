import type { DecisionRecordContent } from "../../src/domain/decision-records.js";

export function decisionRecord(id = "decision-release"): DecisionRecordContent {
  const reference = {
    evidenceId: "source-1",
    source: "human-judgment" as const,
    sourceObjectId: "message-1",
    participantId: "jakob",
    sourceVersion: "revision-1",
    excerpt: "Luma remains internal to the four founders.",
    externalReference: {
      providerId: "discord",
      objectType: "comment" as const,
      externalId: "message-1",
      url: "https://discord.com/channels/1/2/3"
    }
  };
  return {
    id,
    candidate: {
      statement: { text: reference.excerpt, evidenceIds: ["source-1"] },
      modality: "final-decision",
      scopeId: "luma",
      decisionMakerPersonIds: ["jakob"],
      acceptanceEvidenceIds: ["source-1"],
      context: null,
      rationale: [],
      alternatives: [],
      consequences: [],
      effectiveAt: null,
      disposition: "adopt",
      objections: [],
      unresolved: [],
      relatedWork: [],
      implementationEvidence: []
    },
    authority: {
      snapshot: {
        id: "ownership",
        revision: "ownership-v1",
        contentHash: "authority-hash",
        source: {
          providerId: "notion",
          objectType: "document",
          externalId: "ownership",
          url: "https://notion.so/ownership"
        },
        grants: [
          {
            id: "ownership-luma",
            personId: "jakob",
            scopeId: "luma",
            kind: "project-ownership",
            standing: "current",
            evidence: [reference],
            delegatedBy: null,
            consultedPersonIds: []
          }
        ]
      },
      grantIds: ["ownership-luma"],
      decisionMakerPersonIds: ["jakob"],
      acceptanceEvidenceIds: ["source-1"]
    },
    source: {
      subject: {
        type: "conversation-thread",
        providerId: "discord",
        conversationObjectId: "thread-1",
        anchorMessageId: "message-1"
      },
      revision: "revision-1",
      contentHash: "source-hash",
      authorizationHash: "source-authority",
      audience: {
        workspaceId: "dayova",
        personIds: ["jakob", "fabius", "philipp", "julius"]
      },
      evidence: [
        {
          id: "source-1",
          reference,
          text: reference.excerpt,
          authorPersonId: "jakob",
          origin: "human"
        }
      ],
      capturedAt: "2026-09-11T10:00:00Z"
    },
    status: "active",
    recordedAt: "2026-09-11T10:01:00Z",
    supersedes: [],
    supersededBy: null
  };
}
