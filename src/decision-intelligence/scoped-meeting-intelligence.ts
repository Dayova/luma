import type { AutomaticDecisionIntelligence } from "./automatic-decisions.js";
import type {
  ObserveProcessedDecisionSource,
  AutomaticDecisionBatch,
  QueryAutomaticDecisions,
  ConcludeAutomaticDecisions,
  AutomaticDecisionConclusion
} from "../domain/automatic-decisions.js";
import type {
  ConcludeMeeting,
  MeetingIntelligence,
  QueryMeeting,
  MeetingQueryResult,
  MeetingUpdate,
  ObserveMeeting
} from "../meeting-intelligence/interface.js";
import type { MeetingConclusion } from "../domain/model.js";
import type {
  ConcludeDecision,
  DecisionConclusion,
  DecisionRequestState,
  DecisionUpdate,
  ObserveDecision,
  QueryDecision
} from "../domain/decision-records.js";
import type { DecisionIntelligence } from "./interface.js";
import type { StructuredWorkIntelligence } from "../structured-work/interface.js";
import type {
  ObserveStructuredWork,
  QueryStructuredWork,
  ConcludeStructuredWork,
  StructuredWorkState
} from "../domain/structured-work.js";

export type ScopedMeetingIntelligence = MeetingIntelligence &
  DecisionIntelligence &
  StructuredWorkIntelligence &
  AutomaticDecisionIntelligence;
export function scopeMeetingIntelligence(
  meeting: MeetingIntelligence,
  decision?: DecisionIntelligence,
  structuredWork?: StructuredWorkIntelligence,
  automatic?: AutomaticDecisionIntelligence
): ScopedMeetingIntelligence {
  const requireAutomatic = () => {
    if (!automatic) throw new Error("Automatic Decision processing is not configured");
    return automatic;
  };
  const requireDecision = () => {
    if (!decision) throw new Error("Decision recording is not configured");
    return decision;
  };
  const requireStructuredWork = () => {
    if (!structuredWork) throw new Error("Structured work is not configured");
    return structuredWork;
  };
  function observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  function observe(input: ObserveDecision): Promise<DecisionUpdate>;
  function observe(
    input: ObserveStructuredWork
  ): Promise<StructuredWorkState & { duplicate: boolean }>;
  function observe(
    input: ObserveProcessedDecisionSource
  ): Promise<AutomaticDecisionBatch>;
  function observe(
    input:
      | ObserveMeeting
      | ObserveDecision
      | ObserveStructuredWork
      | ObserveProcessedDecisionSource
  ): Promise<
    | MeetingUpdate
    | DecisionUpdate
    | (StructuredWorkState & { duplicate: boolean })
    | AutomaticDecisionBatch
  > {
    if ("subject" in input && input.observations[0]?.type === "structured-work-requested")
      return requireStructuredWork().observe(input as ObserveStructuredWork);
    if ("subject" in input && input.observations[0]?.type === "decision-source-processed")
      return requireAutomatic().observe(input as ObserveProcessedDecisionSource);
    return "subject" in input
      ? requireDecision().observe(input as ObserveDecision)
      : meeting.observe(input);
  }
  function query(input: QueryMeeting): Promise<MeetingQueryResult>;
  function query(input: QueryDecision): Promise<DecisionRequestState>;
  function query(input: QueryStructuredWork): Promise<StructuredWorkState>;
  function query(input: QueryAutomaticDecisions): Promise<AutomaticDecisionBatch>;
  function query(
    input: QueryMeeting | QueryDecision | QueryStructuredWork | QueryAutomaticDecisions
  ): Promise<
    | MeetingQueryResult
    | DecisionRequestState
    | StructuredWorkState
    | AutomaticDecisionBatch
  > {
    if (input.query.type === "structured-work-request")
      return requireStructuredWork().query(input as QueryStructuredWork);
    if ("subject" in input && input.query.type === "automatic-decision-candidates")
      return requireAutomatic().query(input as QueryAutomaticDecisions);
    return "subject" in input
      ? requireDecision().query(input as QueryDecision)
      : meeting.query(input);
  }
  function conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
  function conclude(input: ConcludeDecision): Promise<DecisionConclusion>;
  function conclude(
    input: ConcludeStructuredWork
  ): Promise<{ request: StructuredWorkState; summary: string }>;
  function conclude(
    input: ConcludeAutomaticDecisions
  ): Promise<AutomaticDecisionConclusion>;
  function conclude(
    input:
      | ConcludeMeeting
      | ConcludeDecision
      | ConcludeStructuredWork
      | ConcludeAutomaticDecisions
  ): Promise<
    | MeetingConclusion
    | DecisionConclusion
    | { request: StructuredWorkState; summary: string }
    | AutomaticDecisionConclusion
  > {
    if ("structuredWorkRequestId" in input)
      return requireStructuredWork().conclude(input);
    if ("batchId" in input) return requireAutomatic().conclude(input);
    return "subject" in input
      ? requireDecision().conclude(input)
      : meeting.conclude(input);
  }
  return { observe, query, conclude };
}
