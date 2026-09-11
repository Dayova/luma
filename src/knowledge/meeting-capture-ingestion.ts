import { createHash } from "node:crypto";
import type { LogicalMeeting } from "../logical-meetings/interface.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { MeetingCaptureSetObserved } from "../domain/meeting-capture-synthesis.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";

/** Deterministic source delivery only. Interpretation remains behind MI.observe. */
export function createMeetingCaptureIngestion(input: {
  workspace: WorkspaceConfig;
  meetingIntelligence: Pick<MeetingIntelligence, "observe">;
}) {
  return {
    ingest(meeting: LogicalMeeting) {
      const captures = meeting.captureRefs
        .map((capture) => ({
          captureId: capture.id,
          sourceRevision: capture.latestRevision.sourceRevision,
          contentHash: capture.latestRevision.contentHash
        }))
        .sort((left, right) => compare(left.captureId, right.captureId));
      const binding = meeting.captureRefs
        .map((capture) => [capture.id, capture.binding, capture.admission])
        .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input.workspace.workspaceId,
            meeting.id,
            captures,
            binding,
            meeting.canonicalAnchorRef
          ])
        )
        .digest("hex");
      const observation: MeetingCaptureSetObserved = {
        type: "meeting-capture-set-observed",
        observationId: `capture-set:${fingerprint}`,
        workspaceId: input.workspace.workspaceId,
        meetingId: meeting.id,
        occurredAt: meeting.updatedAt,
        observedAt: meeting.updatedAt,
        captures
      };
      return input.meetingIntelligence.observe({
        workspace: input.workspace,
        observations: [observation]
      });
    }
  };
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
