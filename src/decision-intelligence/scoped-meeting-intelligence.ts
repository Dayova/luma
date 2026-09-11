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

export type ScopedMeetingIntelligence = MeetingIntelligence & DecisionIntelligence;
export function scopeMeetingIntelligence(
  meeting: MeetingIntelligence,
  decision?: DecisionIntelligence
): ScopedMeetingIntelligence {
  const requireDecision = () => {
    if (!decision) throw new Error("Decision recording is not configured");
    return decision;
  };
  function observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  function observe(input: ObserveDecision): Promise<DecisionUpdate>;
  function observe(
    input: ObserveMeeting | ObserveDecision
  ): Promise<MeetingUpdate | DecisionUpdate> {
    return "subject" in input ? requireDecision().observe(input) : meeting.observe(input);
  }
  function query(input: QueryMeeting): Promise<MeetingQueryResult>;
  function query(input: QueryDecision): Promise<DecisionRequestState>;
  function query(
    input: QueryMeeting | QueryDecision
  ): Promise<MeetingQueryResult | DecisionRequestState> {
    return "subject" in input ? requireDecision().query(input) : meeting.query(input);
  }
  function conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
  function conclude(input: ConcludeDecision): Promise<DecisionConclusion>;
  function conclude(
    input: ConcludeMeeting | ConcludeDecision
  ): Promise<MeetingConclusion | DecisionConclusion> {
    return "subject" in input
      ? requireDecision().conclude(input)
      : meeting.conclude(input);
  }
  return { observe, query, conclude };
}
