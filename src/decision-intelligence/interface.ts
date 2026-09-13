import type {
  ConcludeDecision,
  DecisionConclusion,
  DecisionRequestState,
  DecisionUpdate,
  ObserveDecision,
  QueryDecision
} from "../domain/decision-records.js";
export type {
  ConcludeDecision,
  DecisionConclusion,
  DecisionRequestState,
  DecisionUpdate,
  ObserveDecision,
  QueryDecision
} from "../domain/decision-records.js";
/** Composed into the deepest Meeting Intelligence facade for actual Meeting/Conversation subjects. */
export interface DecisionIntelligence {
  observe(input: ObserveDecision): Promise<DecisionUpdate>;
  query(input: QueryDecision): Promise<DecisionRequestState>;
  conclude(input: ConcludeDecision): Promise<DecisionConclusion>;
}
