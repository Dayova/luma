import type { EvidenceReference, MeetingState, Provenance } from "../domain/model.js";

const MAX_PRIOR_CHARACTERS = 16_000;
const MAX_PRIOR_ITEMS = 40;
const MAX_PRIOR_RECEIPTS = 8;

/** Bounded canonical state from the same revision fenced by observe. */
export function meetingAnalysisInput(state: MeetingState): {
  context: string[];
  evidence: EvidenceReference[];
  receiptIds: string[];
} {
  const human = new Set(state.humanJudgmentItemIds);
  const items = [
    ...state.decisions
      .filter((item) => item.status !== "superseded" && item.status !== "rejected")
      .map((item) => ({
        kind: "decision",
        id: item.id,
        status: item.status,
        statement: item.statement,
        humanConfirmed: human.has(item.id),
        provenance: item.provenance
      })),
    ...state.actionItems
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        kind: "action",
        id: item.id,
        status: item.status,
        description: item.description,
        ownership: item.ownership,
        ownerId: item.ownerId,
        dueDate: item.dueDate,
        humanConfirmed: human.has(item.id),
        provenance: item.provenance
      })),
    ...state.openQuestions.map((item) => ({
      kind: "question",
      id: item.id,
      question: item.question,
      humanConfirmed: human.has(item.id),
      provenance: item.provenance
    })),
    ...state.risks.map((item) => ({
      kind: "risk",
      id: item.id,
      statement: item.statement,
      humanConfirmed: human.has(item.id),
      provenance: item.provenance
    }))
  ].sort(
    (a, b) =>
      Number(b.humanConfirmed) - Number(a.humanConfirmed) ||
      b.provenance.producedAtRevision - a.provenance.producedAtRevision ||
      a.id.localeCompare(b.id)
  );
  const selected: string[] = [];
  const evidence = new Map<string, EvidenceReference>();
  const receiptIds = new Set<string>();
  let characters = 0;
  for (const item of items) {
    const value = JSON.stringify({
      ...item,
      provenance: summarizeProvenance(item.provenance)
    });
    const additionalEvidence = item.provenance.evidence.filter(
      (reference) => !evidence.has(reference.evidenceId)
    );
    const additionalCharacters = additionalEvidence.reduce(
      (total, reference) => total + JSON.stringify(reference).length,
      0
    );
    const proposedReceipts = new Set([
      ...receiptIds,
      ...(item.provenance.contextReceiptIds ?? [])
    ]);
    if (
      selected.length >= MAX_PRIOR_ITEMS ||
      characters + value.length + additionalCharacters > MAX_PRIOR_CHARACTERS ||
      proposedReceipts.size > MAX_PRIOR_RECEIPTS
    )
      continue;
    selected.push(value);
    for (const reference of item.provenance.evidence)
      evidence.set(reference.evidenceId, reference);
    for (const id of item.provenance.contextReceiptIds ?? []) receiptIds.add(id);
    characters += value.length + additionalCharacters;
  }
  return {
    evidence: [...evidence.values()],
    receiptIds: [...receiptIds],
    context: [
      JSON.stringify({
        type: "canonical-meeting-context",
        meetingId: state.meetingId,
        revision: state.revision,
        title: state.title,
        participantIds: state.participants.map((person) => person.personId),
        currentItems: selected.map((value) => JSON.parse(value) as unknown),
        coverage: {
          complete: selected.length === items.length,
          selected: selected.length,
          available: items.length
        },
        contextAvailability: state.contextAvailability,
        interpretation:
          "Prior state is context, not a new commitment or authority to execute. Human-confirmed items outrank model inference. Superseded and rejected decisions are excluded from this current view. New claims must cite supplied Evidence."
      })
    ]
  };
}
export function meetingAnalysisContext(state: MeetingState): string[] {
  return meetingAnalysisInput(state).context;
}
function summarizeProvenance(provenance: Provenance) {
  return {
    confidence: provenance.confidence,
    producedAtRevision: provenance.producedAtRevision,
    evidence: provenance.evidence.map((evidence: EvidenceReference) => ({
      evidenceId: evidence.evidenceId,
      source: evidence.source,
      sourceObjectId: evidence.sourceObjectId,
      sourceVersion: evidence.sourceVersion
    }))
  };
}
