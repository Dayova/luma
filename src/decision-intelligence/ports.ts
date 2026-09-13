import type {
  AutomaticDecisionContext,
  AutomaticDecisionDetection,
  DecisionStandingGrant
} from "../domain/automatic-decisions.js";
import type {
  DecisionActor,
  DecisionAudience,
  DecisionAuthoritySnapshot,
  DecisionCatalogSnapshot,
  DecisionInterpretation,
  DecisionSource,
  DecisionSubject,
  DecisionEvidence
} from "../domain/decision-records.js";
import type { WorkspaceConfig } from "../domain/model.js";

/** The core captures and verifies evidence; callers cannot supply a replacement snapshot. */
export interface DecisionEvidenceSource {
  capture(input: {
    workspace: WorkspaceConfig;
    subject: DecisionSubject;
    instruction: string;
    actor: DecisionActor;
    audience: DecisionAudience;
  }): Promise<DecisionSource>;
  requireCurrent(source: DecisionSource): Promise<void>;
}
/** Current source/revision-backed ownership, separate from requester admission. */
export interface DecisionAuthority {
  read(input: { audience: DecisionAudience }): Promise<DecisionAuthoritySnapshot>;
  requireCurrent(input: {
    audience: DecisionAudience;
    snapshot: DecisionAuthoritySnapshot;
  }): Promise<void>;
}
/** No provider/model SDK types or synthetic Meeting identities cross this owned port. */
export interface DecisionInterpreter {
  interpret(input: {
    workspace: WorkspaceConfig;
    requestId: string;
    instruction: string;
    requesterPersonId: string;
    source: DecisionSource;
    /** Literal authenticated review is separate from the imported original source. */
    humanReviewEvidence?: DecisionEvidence[];
    authority: DecisionAuthoritySnapshot;
    catalog: DecisionCatalogSnapshot;
    targetRecordId?: string;
  }): Promise<DecisionInterpretation>;
}

/** Reads accepted original material from a processed source, without inventing a Human request. */
export interface ProcessedDecisionEvidenceSource {
  captureProcessed(input: {
    workspace: WorkspaceConfig;
    subject: DecisionSubject;
    audience: DecisionAudience;
  }): Promise<DecisionSource>;
  requireCurrent(source: DecisionSource): Promise<void>;
}
export interface AutomaticDecisionDetector {
  detect(input: AutomaticDecisionContext): Promise<AutomaticDecisionDetection>;
}
/** The production adapter must prove an explicit Human standing instruction and current access. */
export interface DecisionStandingPolicy {
  read(input: { audience: DecisionAudience }): Promise<DecisionStandingGrant[]>;
  requireCurrent(input: {
    audience: DecisionAudience;
    grant: DecisionStandingGrant;
  }): Promise<void>;
}
