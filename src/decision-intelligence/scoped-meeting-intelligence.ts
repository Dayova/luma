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
  StructuredWorkIntelligence;
export function scopeMeetingIntelligence(
  meeting: MeetingIntelligence,
  decision?: DecisionIntelligence,
  structuredWork?: StructuredWorkIntelligence
): ScopedMeetingIntelligence {
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
    input: ObserveMeeting | ObserveDecision | ObserveStructuredWork
  ): Promise<
    MeetingUpdate | DecisionUpdate | (StructuredWorkState & { duplicate: boolean })
  > {
    if ("subject" in input && input.observations[0]?.type === "structured-work-requested")
      return requireStructuredWork().observe(input as ObserveStructuredWork);
    return "subject" in input
      ? requireDecision().observe(input as ObserveDecision)
      : meeting.observe(input);
  }
  function query(input: QueryMeeting): Promise<MeetingQueryResult>;
  function query(input: QueryDecision): Promise<DecisionRequestState>;
  function query(input: QueryStructuredWork): Promise<StructuredWorkState>;
  function query(
    input: QueryMeeting | QueryDecision | QueryStructuredWork
  ): Promise<MeetingQueryResult | DecisionRequestState | StructuredWorkState> {
    if (input.query.type === "structured-work-request")
      return requireStructuredWork().query(input as QueryStructuredWork);
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
    input: ConcludeMeeting | ConcludeDecision | ConcludeStructuredWork
  ): Promise<
    | MeetingConclusion
    | DecisionConclusion
    | { request: StructuredWorkState; summary: string }
  > {
    if ("structuredWorkRequestId" in input)
      return requireStructuredWork().conclude(input);
    return "subject" in input
      ? requireDecision().conclude(input)
      : meeting.conclude(input);
  }
  return { observe, query, conclude };
}
