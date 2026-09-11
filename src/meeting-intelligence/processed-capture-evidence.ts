import type {
  CaptureSynthesisClaim,
  CaptureSynthesisJudgmentRecorded,
  LumaSynthesis
} from "../domain/meeting-capture-synthesis.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { CaptureSynthesisConfiguration } from "./meeting-capture-access.js";
import { digest, prepareCaptureSynthesisSources } from "./capture-synthesis-sources.js";

type Stored = {
  synthesis: LumaSynthesis;
  audience: ContextAudience;
  judgments: CaptureSynthesisJudgmentRecorded[];
  materialDigest: string;
  bindingDigest: string;
  authorizationScopes: Record<string, string>;
};
const unavailable = () =>
  new Error("Processed capture source or original Human review is unavailable.");
/** Owned leaf read of accepted source state. Never synthesizes, queries MI, or creates intents. */
export async function readProcessedCaptureEvidence(input: {
  database: LumaDatabase;
  configuration: CaptureSynthesisConfiguration;
  workspaceId: string;
  meetingId: string;
  audience: ContextAudience;
}) {
  const { database, configuration, workspaceId, meetingId, audience } = input;
  const load = async (revision?: number): Promise<Stored> => {
    const result = await database.query<{ state_json: string }>(
      revision === undefined
        ? "SELECT state_json FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2"
        : "SELECT state_json FROM meeting_capture_synthesis_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3",
      revision === undefined
        ? [workspaceId, meetingId]
        : [workspaceId, meetingId, revision]
    );
    if (!result.rows[0]) throw unavailable();
    const state = JSON.parse(result.rows[0].state_json) as Stored;
    if (
      state.synthesis.workspaceId !== workspaceId ||
      state.synthesis.logicalMeetingId !== meetingId ||
      (revision !== undefined && state.synthesis.revision !== revision)
    )
      throw unavailable();
    return state;
  };
  const state = await load();
  const bound: CaptureSynthesisConfiguration = {
    ...configuration,
    audience: async (id) => {
      const current = await configuration.audience(id);
      return current &&
        current.workspaceId === audience.workspaceId &&
        audience.personIds.every((person) => current.personIds.includes(person))
        ? audience
        : null;
    }
  };
  const prepared = await prepareCaptureSynthesisSources(
    bound,
    workspaceId,
    meetingId,
    state.audience
  );
  if (
    prepared.meeting.captureRefs.some(
      (capture) =>
        !["bound-high-confidence", "separate", "human-bound"].includes(
          capture.binding.state
        )
    ) ||
    prepared.bindingDigest !== state.bindingDigest ||
    prepared.materialDigest !== state.materialDigest ||
    digest(prepared.authorizationScopes) !== digest(state.authorizationScopes)
  )
    throw unavailable();
  if (state.judgments.length > 40) throw unavailable();
  const reviews: Array<{
    observation: CaptureSynthesisJudgmentRecorded;
    claim: CaptureSynthesisClaim;
  }> = [];
  for (const observation of state.judgments) {
    const result = await database.query<{ payload_json: string }>(
      "SELECT payload_json FROM meeting_capture_synthesis_observations WHERE workspace_id=$1 AND meeting_id=$2 AND observation_id=$3",
      [workspaceId, meetingId, observation.observationId]
    );
    if (
      !result.rows[0] ||
      digest(JSON.parse(result.rows[0].payload_json)) !== digest(observation)
    )
      throw unavailable();
    const original = await load(observation.expectedSynthesisRevision);
    const accepted = await load(observation.expectedSynthesisRevision + 1);
    const claim = original.synthesis.claims.find(
      (item) => item.id === observation.claimId
    );
    if (
      !claim ||
      !accepted.judgments.some((item) => digest(item) === digest(observation)) ||
      accepted.audience.workspaceId !== workspaceId ||
      audience.personIds.some(
        (person) => !accepted.audience.personIds.includes(person)
      ) ||
      !accepted.audience.personIds.includes(observation.participantId)
    )
      throw unavailable();
    for (const citation of claim.citations) {
      if (
        !prepared.authorizationScopes[citation.captureId] ||
        accepted.authorizationScopes[citation.captureId] !==
          prepared.authorizationScopes[citation.captureId] ||
        !prepared.materials.some(
          (material) =>
            material.captureId === citation.captureId &&
            material.descriptor.sourceObjectId === citation.materialId
        )
      )
        throw unavailable();
    }
    reviews.push({ observation, claim });
  }
  const final = await prepareCaptureSynthesisSources(
    bound,
    workspaceId,
    meetingId,
    state.audience
  );
  if (
    final.bindingDigest !== prepared.bindingDigest ||
    final.materialDigest !== prepared.materialDigest ||
    digest(final.authorizationScopes) !== digest(prepared.authorizationScopes) ||
    digest(final.audience) !== digest(prepared.audience) ||
    digest(await load()) !== digest(state)
  )
    throw unavailable();
  return {
    ...prepared,
    reviews,
    revision: state.synthesis.revision,
    stateDigest: digest(state)
  };
}
