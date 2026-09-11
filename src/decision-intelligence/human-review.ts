import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  DecisionAudience,
  DecisionCandidate,
  DecisionHumanReview,
  DecisionSource,
  ObserveDecision
} from "../domain/decision-records.js";
import { decisionHumanReviewSchema } from "../domain/decision-record-schemas.js";
import type { LumaDatabase } from "../persistence/db.js";
import { decisionDigest } from "./persistence.js";

export function originalDecisionHumanReview(input: {
  request: ObserveDecision;
  requestId: string;
  source: Pick<DecisionSource, "contentHash" | "authorizationHash" | "audience">;
  personId: string;
  observedAt: string;
  acceptedCandidateHash?: string;
}): DecisionHumanReview {
  const observation = input.request.observations[0];
  if (observation.type === "decision-candidate-corrected")
    throw new Error("A correction does not imply a new owner's acceptance");
  const evidenceId = `decision-human:${decisionDigest({
    workspaceId: input.request.workspace.workspaceId,
    observationId: observation.observationId
  })}`;
  const value = {
    requestId: input.requestId,
    observationId: observation.observationId,
    subject: structuredClone(input.request.subject),
    actor: structuredClone(observation.actor),
    personId: input.personId,
    audience: structuredClone(input.source.audience),
    sourceContentHash: input.source.contentHash,
    sourceAuthorizationHash: input.source.authorizationHash,
    reviewToken:
      observation.type === "decision-candidate-accepted" ? observation.reviewToken : null,
    acceptedCandidateHash: input.acceptedCandidateHash ?? null,
    evidence: {
      id: evidenceId,
      reference: {
        evidenceId,
        source: "human-judgment" as const,
        sourceObjectId: observation.observationId,
        participantId: input.personId,
        excerpt: observation.instruction
      },
      text: observation.instruction,
      authorPersonId: input.personId,
      origin: "human" as const
    },
    observedAt: input.observedAt
  };
  return decisionHumanReviewSchema.parse({
    id: `decision-review:${decisionDigest(value)}`,
    ...value
  });
}

export async function saveDecisionHumanReview(
  database: Pick<LumaDatabase, "query">,
  review: DecisionHumanReview
): Promise<void> {
  await database.query(
    `INSERT INTO decision_human_reviews(workspace_id,review_id,payload_json,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [
      review.audience.workspaceId,
      review.id,
      JSON.stringify(review),
      decisionDigest(review)
    ]
  );
}

/** A distinct proof: permission to read an ownership page does not disclose Human review. */
export function createDecisionHumanReviewAccess(input: {
  database: Pick<LumaDatabase, "query">;
  accessPolicy: WorkspaceAccessPolicy;
  audience(workspaceId: string): Promise<DecisionAudience | null>;
}) {
  const requireRetained = async (request: {
    audience: DecisionAudience;
    review: DecisionHumanReview;
    signal?: AbortSignal;
  }): Promise<void> => {
    request.signal?.throwIfAborted();
    const review = decisionHumanReviewSchema.parse(request.review);
    const audience = request.audience;
    if (
      audience.workspaceId !== review.audience.workspaceId ||
      !audience.personIds.length ||
      new Set(audience.personIds).size !== audience.personIds.length ||
      audience.personIds.some((id) => !review.audience.personIds.includes(id))
    )
      throw new Error("Human review was not shared with this audience");
    const row = (
      await input.database.query<{ payload_json: string; payload_hash: string }>(
        `SELECT payload_json,payload_hash FROM decision_human_reviews WHERE workspace_id=$1 AND review_id=$2`,
        [audience.workspaceId, review.id]
      )
    ).rows[0];
    if (
      !row ||
      decisionDigest(JSON.parse(row.payload_json)) !== row.payload_hash ||
      row.payload_hash !== decisionDigest(review)
    )
      throw new Error("The original Human review receipt is unavailable");
    const original = (
      await input.database.query<{
        payload_json: string;
        payload_hash: string;
        request_id: string;
      }>(
        `SELECT payload_json,payload_hash,request_id FROM decision_observations WHERE workspace_id=$1 AND observation_id=$2`,
        [audience.workspaceId, review.observationId]
      )
    ).rows[0];
    if (!original || original.request_id !== review.requestId)
      throw new Error("The original Human observation is unavailable");
    const observation: ObserveDecision = JSON.parse(
      original.payload_json
    ) as ObserveDecision;
    if (
      decisionDigest(observation) !== original.payload_hash ||
      observation.observations.length !== 1 ||
      decisionDigest(
        originalDecisionHumanReview({
          request: observation,
          requestId: review.requestId,
          source: {
            contentHash: review.sourceContentHash,
            authorizationHash: review.sourceAuthorizationHash,
            audience: review.audience
          },
          personId: review.personId,
          observedAt: review.observedAt,
          ...(review.acceptedCandidateHash
            ? { acceptedCandidateHash: review.acceptedCandidateHash }
            : {})
        })
      ) !== decisionDigest(review)
    )
      throw new Error(
        "The Human review no longer matches its literal original observation"
      );
    const current = await input.audience(audience.workspaceId);
    const actor = await input.accessPolicy.authorize({
      workspaceId: audience.workspaceId,
      ...review.actor
    });
    if (
      !current ||
      current.workspaceId !== audience.workspaceId ||
      actor?.personId !== review.personId ||
      !current.personIds.includes(review.personId) ||
      audience.personIds.some((id) => !current.personIds.includes(id))
    )
      throw new Error("The Human review identity or current audience is unavailable");
    request.signal?.throwIfAborted();
  };
  return {
    requireCurrent: async (source: DecisionSource, reviews: DecisionHumanReview[]) => {
      for (const review of reviews) {
        if (
          decisionDigest(review.subject) !== decisionDigest(source.subject) ||
          review.sourceContentHash !== source.contentHash ||
          review.sourceAuthorizationHash !== source.authorizationHash ||
          decisionDigest(review.audience) !== decisionDigest(source.audience)
        )
          throw new Error("Human acceptance belongs to a different original source");
        await requireRetained({ audience: source.audience, review });
      }
    },
    authorizeRetainedHumanReview: async (request: {
      audience: DecisionAudience;
      review: DecisionHumanReview;
      signal?: AbortSignal;
    }): Promise<boolean> => {
      try {
        await requireRetained(request);
        return true;
      } catch {
        return false;
      }
    }
  };
}

export function acceptedDecisionCandidateHash(candidate: DecisionCandidate): string {
  return decisionDigest({ ...candidate, acceptanceEvidenceIds: [] });
}
