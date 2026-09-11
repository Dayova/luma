import type {
  DecisionAudience,
  DecisionAuthoritySnapshot,
  DecisionCatalogSnapshot,
  DecisionCandidate,
  DecisionInterpretation,
  DecisionRequestState,
  DecisionSource,
  DecisionSubject,
  DecisionActor
} from "./decision-records.js";
import type { EvidenceReference, ExternalReference, WorkspaceConfig } from "./model.js";

/** Recording permission is independent of the authority to make a decision. */
export type DecisionStandingGrant = {
  id: string;
  revision: string;
  contentHash: string;
  source: ExternalReference;
  audience: DecisionAudience;
  purpose: "automatic-decision-recording";
  authorizedBy: string;
  actor: DecisionActor;
  instruction: string;
  evidence: EvidenceReference;
  scopeId: string;
  actions: Array<"create" | "link" | "amend" | "supersede" | "reverse">;
  modalities: Array<"final-decision" | "accepted-proposal" | "reversal">;
  dispositions: Array<"adopt" | "pause" | "discard">;
  validFrom: string;
  validUntil: string | null;
};
export type AutomaticDecisionDetection = {
  /** A bounded response that omitted decisions cannot authorize any automatic write. */
  complete: boolean;
  candidates: Array<{
    confidence: "high" | "medium" | "low";
    interpretation: DecisionInterpretation & { candidate: DecisionCandidate };
  }>;
};
export type ObserveProcessedDecisionSource = {
  workspace: WorkspaceConfig;
  subject: DecisionSubject;
  observations: [{ type: "decision-source-processed"; observationId: string }];
};
export type QueryAutomaticDecisions = {
  workspaceId: string;
  subject: DecisionSubject;
  query: { type: "automatic-decision-candidates"; batchId: string };
};
export type AutomaticDecisionBatch = {
  batchId: string;
  subject: DecisionSubject;
  source: DecisionSource;
  status: "completed" | "needs-clarification";
  message: string;
  complete: boolean;
  candidates: DecisionRequestState[];
  duplicate: boolean;
};
export type ConcludeAutomaticDecisions = {
  workspaceId: string;
  subject: DecisionSubject;
  batchId: string;
};
export type AutomaticDecisionConclusion = {
  batch: AutomaticDecisionBatch;
  summary: string;
};
export type AutomaticDecisionContext = {
  workspace: WorkspaceConfig;
  batchId: string;
  source: DecisionSource;
  authority: DecisionAuthoritySnapshot | null;
  catalog: DecisionCatalogSnapshot | null;
};
