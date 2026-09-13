import { createHash } from "node:crypto";
import type { LumaSynthesis } from "../domain/meeting-capture-synthesis.js";
import type {
  EvidenceReference,
  SynthesisActionItemCandidate,
  WorkspaceConfig
} from "../domain/model.js";
import {
  importedActionItemDeadlineFor,
  importedActionItemLanguageFor,
  importedActionItemModalityFor,
  importedActionItemSourceOwnerFor,
  mentionedGitHubImplementationReferencesFor,
  mentionedWorkItemExternalIdsFor
} from "../domain/imported-action-item-semantics.js";

/** Private projection: derived claims remain derived, and Human details remain Human evidence. */
export function synthesisActionCandidates(input: {
  synthesis: LumaSynthesis;
  workspace: WorkspaceConfig;
  workProviderId: string;
  materials: readonly { evidenceId: string; text: string }[];
  deadlineReferenceAt: string | null;
}): SynthesisActionItemCandidate[] {
  const { synthesis, workspace } = input;
  return synthesis.claims
    .filter((claim) => ["action-item", "commitment"].includes(claim.kind))
    .map((claim) => {
      const currentMaterial = input.materials.find(
        (material) =>
          claim.citations.some(
            (citation) => citation.evidenceId === material.evidenceId
          ) && material.text.includes(claim.text)
      );
      const sourceText = currentMaterial ? claim.text : "";
      const review = claim.actionReview;
      const claimDigest = digest(claim);
      const id = `synthesis-action:${digest([synthesis.logicalMeetingId, synthesis.revision, synthesis.sourceSetDigest, claimDigest])}`;
      const evidence: EvidenceReference[] = [
        {
          evidenceId: `evidence:${id}`,
          source: "knowledge",
          sourceObjectId: claim.id,
          sourceVersion: `${synthesis.revision}`,
          excerpt: claim.text,
          externalReference: claim.citations[0]!.externalReference
        }
      ];
      if (review)
        evidence.push({
          evidenceId: `evidence:human-action:${digest([claim.id, review])}`,
          source: "human-judgment",
          sourceObjectId: claim.id,
          sourceVersion: `${synthesis.revision}`,
          participantId: review.participantId,
          excerpt: JSON.stringify(review)
        });
      const blocked =
        claim.authority === "human-rejected" ||
        claim.conflictingClaimIds.some(
          (otherId) =>
            synthesis.claims.find((other) => other.id === otherId)?.authority !==
            "human-rejected"
        );
      return {
        id,
        // A different interpretation cannot inherit a prior owner or create mapping.
        lineageKey: `synthesis-action-lineage:${digest([synthesis.logicalMeetingId, claim.id, claim.text, claim.actionReview])}`,
        originalText: claim.text,
        description: claim.text,
        language: importedActionItemLanguageFor(claim.text),
        modality: blocked
          ? { kind: "unknown", sourceForm: null }
          : review
            ? { kind: review.modality, sourceForm: null }
            : importedActionItemModalityFor(sourceText),
        completion: "open",
        sourceOwner: importedActionItemSourceOwnerFor(sourceText),
        ownership: review
          ? review.ownerPersonId === null
            ? { status: "intentionally-unassigned", basis: "human-confirmation" }
            : {
                status: "confirmed",
                ownerPersonId: review.ownerPersonId,
                confidence: "deterministic",
                basis: "human-confirmation"
              }
          : {
              status: "unresolved",
              reason: "insufficient-acceptance",
              likelyOwnerPersonId: null
            },
        deadline: review
          ? {
              originalPhrase: null,
              normalizedDate: review.dueDate,
              confidence: review.dueDate ? "exact" : "unknown",
              timezone: workspace.timezone
            }
          : importedActionItemDeadlineFor(
              sourceText,
              workspace.timezone,
              input.deadlineReferenceAt
            ),
        mentionedWorkItemReferences: mentionedWorkItemExternalIdsFor(sourceText).map(
          (externalId) => ({
            providerId: input.workProviderId,
            objectType: "work-item",
            externalId
          })
        ),
        sourceBoundImplementationReferences: mentionedGitHubImplementationReferencesFor(
          sourceText,
          "github-code"
        ),
        projectHints: [],
        componentHints: [],
        evidence,
        source: {
          source: {
            providerId: "luma",
            sourceKind: "capture-synthesis",
            sourceObjectId: synthesis.logicalMeetingId,
            sourceRevision: synthesis.revision,
            contentHash: synthesis.sourceSetDigest,
            logicalMeetingId: synthesis.logicalMeetingId,
            claimId: claim.id,
            claimDigest,
            externalReference: claim.citations[0]!.externalReference,
            canonicalAnchorRef: synthesis.canonicalAnchorRef,
            workItemProviderId: input.workProviderId,
            implementationReferenceProviderId: "github-code",
            // Coverage stays on the synthesis. A reviewed derived action does not invent a raw transcript.
            completeness: synthesis.coverage,
            actionItemsAvailability: blocked ? "unavailable" : "available",
            producedAt: synthesis.producedAt,
            humanNoDeadline: review?.dueDate === null,
            humanActionReviewed: Boolean(review)
          },
          sourceBlockId: claim.id,
          sourceSection: "luma-synthesis",
          sourceExcerpt: claim.text
        }
      };
    });
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
