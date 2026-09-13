import type {
  CurrentActionItemReconciliationReview,
  FollowUpIntent,
  MeetingState
} from "../domain/model.js";

/** Whole fields and explicit continuation pages keep every candidate and target reviewable. */
export function renderReconciliationReviewPages(input: {
  state: MeetingState;
  reviews: CurrentActionItemReconciliationReview[];
}): string[] {
  const lines = [`Meeting: ${input.state.title}`, `Revision: ${input.state.revision}`];
  for (const current of input.reviews) {
    const review = current.proposal;
    const source = review.candidate.source.source;
    lines.push(
      "",
      `Review: ${review.id}`,
      `Candidate: ${review.candidateId}`,
      `Status: ${current.status}`,
      `Source: ${source.externalReference.url}`,
      `Source revision: ${source.sourceRevision} / ${source.contentHash}`,
      `Original wording: ${review.candidate.originalText}`,
      `Modality: ${review.candidate.modality.kind}`,
      `Normalized deadline: ${review.candidate.deadline.normalizedDate ?? "unresolved"} (${review.candidate.deadline.timezone}; ${review.candidate.deadline.confidence})`,
      `Ownership claim: ${current.ownershipClaimId}`,
      `Ownership: ${ownershipLabel(current)}`,
      `Proposed: ${review.outcome.type} — ${review.outcome.rationale}`,
      `Effective: ${current.effectiveOutcome.type}`
    );
    if (current.humanResolution)
      lines.push(
        `Human decision: ${current.humanResolution.participantId} at ${current.humanResolution.resolvedAt}; ${current.effectiveOutcome.rationale}`
      );
    if (current.conflictingCandidateIds.length)
      lines.push(`Conflicting candidates: ${current.conflictingCandidateIds.join(", ")}`);
    const seen = new Set<string>();
    for (const search of review.searches) {
      lines.push(
        `Canonical search: ${search.status} (${search.workItems.length} result(s))`
      );
      for (const work of search.workItems) {
        const key = `${work.providerId}:${work.externalId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(
          `Target ${work.externalId}: ${work.title} [${work.status}]`,
          `Target description: ${work.description}`,
          `Target owners: ${work.assignees.map((person) => person.displayName).join(", ") || "unassigned"}; deadline: ${work.dueDate ?? "none"}; updated: ${work.updatedAt}`,
          `Target source: ${work.url}`
        );
      }
    }
    for (const intent of input.state.followUpIntentions.filter((intent) =>
      reviewIntent(intent, review.id)
    ))
      lines.push(`Follow-up: ${intent.id} [${intent.status}]`);
    lines.push(
      "Use /meeting owner for ownership, /meeting reconcile for this exact review, or /meeting refresh to read canonical work again."
    );
  }
  if (!input.reviews.length)
    lines.push(
      "No current imported Action Item review is available. Source ingestion or canonical work lookup may still be pending."
    );
  const pages: string[] = [];
  let page = "";
  for (const line of lines) {
    const chunks: string[] = [];
    let chunk = "";
    // Discord counts UTF-16 code units; preserve complete Unicode characters.
    for (const character of line) {
      if (chunk.length + character.length > 1450) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += character;
    }
    chunks.push(chunk);
    for (let index = 0; index < chunks.length; index++) {
      const part = `${index ? "[continued] " : ""}${chunks[index]}`;
      if (page.length + part.length + 1 > 1600) {
        pages.push(page);
        page = "";
      }
      page += `${page ? "\n" : ""}${part}`;
    }
  }
  if (page) pages.push(page);
  return pages.map(
    (content, index) =>
      `${content}\n\nReview page ${index + 1}/${pages.length}.${index + 1 < pages.length ? ` Use /meeting review page:${index + 2} for the next page.` : " End of review."}`
  );
}
function ownershipLabel(review: CurrentActionItemReconciliationReview): string {
  const value = review.ownership;
  if (value.status === "confirmed") return `confirmed: ${value.ownerPersonId}`;
  if (value.status === "proposed")
    return `proposed: ${value.proposedOwnerPersonId ?? "unknown"}`;
  if (value.status === "unresolved") return `unresolved: ${value.reason}`;
  return "intentionally unassigned";
}
export function reviewIntent(intent: FollowUpIntent, reviewId: string): boolean {
  return "reconciliation" in intent && intent.reconciliation?.reviewId === reviewId;
}
