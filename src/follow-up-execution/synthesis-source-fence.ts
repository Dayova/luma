import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { MeetingSynthesisWriter } from "../knowledge/meeting-synthesis-writer.js";
import type { OperationalOutcomeTarget } from "../knowledge/operational-outcome-writer.js";
import type { OperationalOutcomeSourceExecutionFence } from "../knowledge/ledger-backed-operational-outcome-source-execution-fence.js";
import type { OperationalOutcomeSourceCurrentnessVerifier } from "../knowledge/ledger-backed-operational-outcome-source-currentness.js";
import { sameAnchor } from "../logical-meetings/canonical-publication-anchor.js";
import {
  migrateSynthesisPublications,
  type SynthesisPublicationState
} from "../meeting-intelligence/synthesis-publication-state.js";

import {
  ensureSynthesisActionFences,
  releaseSynthesisActionFence
} from "../meeting-intelligence/synthesis-action-state.js";

export function synthesisSourceFence(input: {
  database: LumaDatabase;
  meetingIntelligence: MeetingIntelligence;
  meetingSynthesisWriter?: MeetingSynthesisWriter;
}): OperationalOutcomeSourceExecutionFence & OperationalOutcomeSourceCurrentnessVerifier {
  async function requireCurrent(target: OperationalOutcomeTarget) {
    const expected = target.synthesis;
    if (!expected || !input.meetingSynthesisWriter)
      throw new Error("Derived action source proof is not configured");
    const read = async () => {
      const view = await input.meetingIntelligence.query({
        workspaceId: target.workspaceId,
        meetingId: target.sourceObjectId,
        query: { type: "capture-synthesis" }
      });
      if (
        view.type !== "capture-synthesis" ||
        !view.synthesis ||
        view.synthesis.revision !== target.sourceRevision ||
        view.synthesis.sourceSetDigest !== target.sourceContentHash ||
        !sameAnchor(view.synthesis.canonicalAnchorRef, target.page)
      )
        throw new Error("The approved synthesis source or canonical anchor changed");
      const claim = view.synthesis.claims.find((entry) => entry.id === expected.claimId);
      if (
        !claim ||
        createHash("sha256").update(JSON.stringify(claim)).digest("hex") !==
          expected.claimDigest
      )
        throw new Error("The approved synthesis claim changed");
    };
    await read();
    await migrateSynthesisPublications(input.database);
    const rows = await input.database.query<{ state_json: string }>(
      "SELECT state_json FROM meeting_synthesis_publications WHERE workspace_id=$1 AND meeting_id=$2",
      [target.workspaceId, target.sourceObjectId]
    );
    const publications = rows.rows
      .map((row) => JSON.parse(row.state_json) as SynthesisPublicationState)
      .filter(
        (state) =>
          state.plan &&
          state.applied &&
          state.anchorStatus !== "conflict" &&
          sameAnchor(state.applied.externalReference, target.page) &&
          state.plan.synthesis.sourceSetDigest === target.sourceContentHash
      )
      .sort((a, b) => b.intent.synthesisRevision - a.intent.synthesisRevision);
    const state = publications[0];
    if (!state?.plan || !state.applied)
      throw new Error(
        "Publish the source synthesis to its canonical page before executing derived actions"
      );
    const receipt = await input.meetingSynthesisWriter.findPublished({
      publication: state.plan,
      requireCurrent: read
    });
    if (
      !receipt ||
      receipt.operationToken !== state.applied.operationToken ||
      receipt.sourceSetDigest !== target.sourceContentHash ||
      !sameAnchor(receipt.externalReference, target.page)
    )
      throw new Error(
        "Current canonical publication permission or material is unavailable"
      );
    await read();
  }
  const current = async (target: OperationalOutcomeTarget) => {
    try {
      await requireCurrent(target);
      return { status: "current" as const };
    } catch {
      return {
        status: "unavailable" as const,
        message:
          "The exact synthesis, original source sharing or canonical publication could not be verified."
      };
    }
  };
  return {
    verifyCurrent: current,
    async acquire({ target, owner }) {
      await ensureSynthesisActionFences(input.database);
      await requireCurrent(target);
      return input.database.transaction(async (tx) => {
        await tx.query(
          "SELECT revision FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2 FOR UPDATE",
          [target.workspaceId, target.sourceObjectId]
        );
        const head = await tx.query<{ revision: number }>(
          "SELECT revision FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
          [target.workspaceId, target.sourceObjectId]
        );
        if (head.rows[0]?.revision !== target.sourceRevision)
          return { status: "superseded", current: null };
        await tx.query(
          "INSERT INTO synthesis_action_execution_fences(workspace_id,meeting_id,intent_id,execution_lease_id,target_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            target.workspaceId,
            target.sourceObjectId,
            owner.intentId,
            owner.executionLeaseId,
            JSON.stringify(target)
          ]
        );
        const rows = await tx.query<{
          intent_id: string;
          execution_lease_id: string;
          target_json: string;
        }>(
          "SELECT intent_id,execution_lease_id,target_json FROM synthesis_action_execution_fences WHERE workspace_id=$1 AND meeting_id=$2",
          [target.workspaceId, target.sourceObjectId]
        );
        const held = rows.rows[0]!;
        if (
          held.intent_id !== owner.intentId ||
          held.execution_lease_id !== owner.executionLeaseId ||
          held.target_json !== JSON.stringify(target)
        )
          return {
            status: "busy",
            owner: {
              meetingId: target.sourceObjectId,
              intentId: held.intent_id,
              executionLeaseId: held.execution_lease_id
            }
          };
        return { status: "acquired" };
      });
    },
    async verifyHeldCurrent({ target, owner }) {
      const proof = await current(target);
      if (proof.status !== "current") return proof;
      const rows = await input.database.query<{
        intent_id: string;
        execution_lease_id: string;
        target_json: string;
      }>(
        "SELECT intent_id,execution_lease_id,target_json FROM synthesis_action_execution_fences WHERE workspace_id=$1 AND meeting_id=$2",
        [target.workspaceId, target.sourceObjectId]
      );
      const held = rows.rows[0];
      return held?.intent_id === owner.intentId &&
        held.execution_lease_id === owner.executionLeaseId &&
        held.target_json === JSON.stringify(target)
        ? proof
        : {
            status: "unavailable",
            message: "The exact derived source execution fence is no longer held."
          };
    },
    releaseAfterReceipt: releaseSynthesisActionFence
  };
}
