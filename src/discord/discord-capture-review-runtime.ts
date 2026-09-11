import { createHash } from "node:crypto";
import type { WorkspaceConfig } from "../domain/model.js";
import type { LumaSynthesis } from "../domain/meeting-capture-synthesis.js";
import type { LogicalMeeting, LogicalMeetings } from "../logical-meetings/interface.js";
import type { MeetingCaptureAccess } from "../meeting-intelligence/meeting-capture-access.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { FollowUpExecution } from "../follow-up-execution/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import { createMeetingCaptureIngestion } from "../knowledge/meeting-capture-ingestion.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";

export type DiscordCaptureReviewCommand = DiscordCommandBase &
  (
    | { type: "captures"; meetingId?: string; page: number }
    | { type: "synthesis"; meetingId?: string; page: number }
    | {
        type: "judge";
        meetingId?: string;
        revision: number;
        claimId: string;
        choice: "confirm" | "correct" | "reject";
        text?: string;
      }
    | { type: "publish"; meetingId?: string; revision: number; recover: boolean }
    | {
        type: "capture-link";
        meetingId: string;
        captureId: string;
        revision: number;
        choice: "bind" | "separate";
        reason?: string;
      }
  );
export type DiscordCaptureReviewRuntime = {
  handle(input: {
    command: DiscordCaptureReviewCommand;
    actorPersonId: string;
    boundMeetingId?: string;
  }): Promise<DiscordCommandResponse>;
};
export function isCaptureReviewCommand(command: {
  type: string;
}): command is DiscordCaptureReviewCommand {
  return ["captures", "synthesis", "judge", "publish", "capture-link"].includes(
    command.type
  );
}
export class DiscordCaptureReviewUnavailableError extends Error {
  constructor(
    message = "Luma withheld this capture review because the exact source revision or sharing with all four founders could not be verified. Original captures, Human judgments and publication receipts are retained."
  ) {
    super(message);
  }
}

/** Private Discord composition. Identity/channel admission belongs to the bot;
 * every source projection and action additionally requires the complete founder audience. */
export function createDiscordCaptureReviewRuntime(input: {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  logicalMeetings: LogicalMeetings;
  captureAccess: MeetingCaptureAccess;
  meetingIntelligence: MeetingIntelligence;
  followUpExecution: FollowUpExecution;
  founderPersonIds: readonly string[];
}): DiscordCaptureReviewRuntime {
  const { workspace, logicalMeetings, captureAccess, meetingIntelligence } = input;
  const personIds = [...new Set(input.founderPersonIds)].sort();
  if (personIds.length !== 4)
    throw new Error("Capture review requires exactly four configured founders");
  const audience = { workspaceId: workspace.workspaceId, personIds };
  const ingestion = createMeetingCaptureIngestion({ workspace, meetingIntelligence });
  async function read(meetingId: string) {
    const meeting = await logicalMeetings.get({
      workspaceId: workspace.workspaceId,
      logicalMeetingId: meetingId
    });
    if (!meeting || !meeting.captureRefs.length)
      throw new DiscordCaptureReviewUnavailableError();
    const scopes: string[] = [];
    for (const capture of meeting.captureRefs) {
      const proof = await captureAccess.readCurrent({
        workspaceId: workspace.workspaceId,
        capture,
        audience
      });
      if (!proof.authorizationScopeId) throw new DiscordCaptureReviewUnavailableError();
      scopes.push(proof.authorizationScopeId);
    }
    const current = await logicalMeetings.get({
      workspaceId: workspace.workspaceId,
      logicalMeetingId: meetingId
    });
    if (digest(current) !== digest(meeting))
      throw new DiscordCaptureReviewUnavailableError();
    return { meeting, identity: digest([meeting, scopes]) };
  }
  async function requireSame(receipts: Awaited<ReturnType<typeof read>>[]) {
    try {
      for (const receipt of receipts)
        if ((await read(receipt.meeting.id)).identity !== receipt.identity)
          throw new DiscordCaptureReviewUnavailableError();
    } catch {
      throw new DiscordCaptureReviewUnavailableError();
    }
  }
  async function resolve(
    explicit: string | undefined,
    bound: string | undefined
  ): Promise<string | null> {
    if (explicit) return explicit;
    if (!bound) return null;
    if (
      await logicalMeetings.get({
        workspaceId: workspace.workspaceId,
        logicalMeetingId: bound
      })
    )
      return bound;
    const snapshot = await meetingIntelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: bound,
      query: { type: "snapshot" }
    });
    if (snapshot.type !== "snapshot" || !snapshot.state.importedSources.length)
      return null;
    const ids = new Set<string>();
    // Resolve persisted identities only. A thread binding cannot manufacture or merge captures.
    for (const source of snapshot.state.importedSources) {
      const rows = await input.database.query<{ capture_id: string }>(
        `SELECT capture_id FROM meeting_captures WHERE workspace_id=$1 AND provider_id=$2 AND external_capture_id=$3 AND source_kind='meeting-note' LIMIT 2`,
        [workspace.workspaceId, source.providerId, source.sourceObjectId]
      );
      if (rows.rows.length !== 1) return null;
      const logical = await logicalMeetings.get({
        workspaceId: workspace.workspaceId,
        captureId: rows.rows[0]!.capture_id
      });
      if (!logical) return null;
      ids.add(logical.id);
    }
    return ids.size === 1 ? [...ids][0]! : null;
  }
  async function synthesis(meetingId: string) {
    const result = await meetingIntelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId,
      query: { type: "capture-synthesis" }
    });
    if (result.type !== "capture-synthesis")
      throw new DiscordCaptureReviewUnavailableError();
    return result;
  }
  async function response(
    meetingId: string,
    content: string,
    revision?: number
  ): Promise<DiscordCommandResponse> {
    const receipt = await read(meetingId);
    const requireCurrent = async () => {
      await requireSame([receipt]);
      if (
        revision !== undefined &&
        (await synthesis(meetingId)).synthesis?.revision !== revision
      )
        throw new DiscordCaptureReviewUnavailableError(
          "This synthesis changed. Read /meeting synthesis again before acting."
        );
    };
    await requireCurrent();
    return { content, requireCurrent };
  }
  return {
    async handle({ command, actorPersonId, boundMeetingId }) {
      if (!personIds.includes(actorPersonId))
        throw new DiscordCaptureReviewUnavailableError();
      if (
        !Number.isSafeInteger("revision" in command ? command.revision : command.page) ||
        ("revision" in command ? command.revision : command.page) < 1
      )
        throw new DiscordCaptureReviewUnavailableError(
          "Use a positive revision or page number from the review."
        );
      try {
        const meetingId = await resolve(command.meetingId, boundMeetingId);
        if (command.type === "captures" && !meetingId) {
          const rows = await input.database.query<{ logical_meeting_id: string }>(
            `SELECT logical_meeting_id FROM logical_meetings WHERE workspace_id=$1 ORDER BY updated_at DESC, logical_meeting_id LIMIT 5 OFFSET $2`,
            [workspace.workspaceId, (command.page - 1) * 5]
          );
          const receipts: Awaited<ReturnType<typeof read>>[] = [];
          for (const row of rows.rows) {
            try {
              receipts.push(await read(row.logical_meeting_id));
            } catch {
              /* Withhold inaccessible rows, including their identifiers. */
            }
          }
          return {
            content: pageText(
              [
                `Captured meetings · page ${command.page}`,
                ...receipts.map(
                  ({ meeting }) =>
                    `${meeting.id}\n${meeting.captureRefs.length} capture(s) · ${[...new Set(meeting.captureRefs.map((c) => c.address.providerId))].join(", ")}\n${meeting.canonicalAnchorRef ? "Canonical record published" : "Canonical record not published"}`
                ),
                receipts.length
                  ? "Use /meeting captures meeting_id:<ID> for sources, or /meeting synthesis meeting_id:<ID>. Use the next page for older records."
                  : "No currently shared captures on this page. Earlier private or unavailable captures are withheld."
              ],
              1
            ),
            requireCurrent: () => requireSame(receipts)
          };
        }
        if (!meetingId)
          return {
            content:
              "Choose a logical meeting_id from /meeting captures, or use an imported Meeting thread whose captures have been ingested."
          };
        const before = await read(meetingId);
        if (command.type === "captures") {
          const content = pageText(
            renderCaptures(before.meeting),
            command.page,
            `Logical meeting: ${meetingId}`
          );
          await requireSame([before]);
          return { content, requireCurrent: () => requireSame([before]) };
        }
        if (command.type === "capture-link") {
          const source = await logicalMeetings.get({
            workspaceId: workspace.workspaceId,
            captureId: command.captureId
          });
          if (!source) throw new DiscordCaptureReviewUnavailableError();
          const head = await input.database.query<{ binding_id: string }>(
            "SELECT binding_id FROM logical_meeting_capture_binding_heads WHERE workspace_id=$1 AND capture_id=$2",
            [workspace.workspaceId, command.captureId]
          );
          if (!head.rows[0]) throw new DiscordCaptureReviewUnavailableError();
          const sourceProof = await read(source.id);
          const capture = sourceProof.meeting.captureRefs.find(
            (c) => c.id === command.captureId
          );
          if (!capture || capture.latestRevision.sourceRevision !== command.revision)
            throw new DiscordCaptureReviewUnavailableError(
              "The capture revision changed. Read /meeting captures before linking."
            );
          await requireSame([before, sourceProof]);
          const result = await logicalMeetings.recordBindingJudgment({
            judgmentId: `discord-capture-binding:${command.interactionId}`,
            workspaceId: workspace.workspaceId,
            actorPersonId,
            captureId: command.captureId,
            expectedCapture: {
              sourceRevision: command.revision,
              contentHash: capture.latestRevision.contentHash,
              bindingId: head.rows[0].binding_id
            },
            observedAt: command.occurredAt,
            reason: command.reason ?? "Explicit founder capture binding in Discord",
            judgment:
              command.choice === "bind"
                ? { type: "bind", logicalMeetingId: meetingId }
                : { type: "make-separate", rejectedLogicalMeetingId: meetingId }
          });
          if (result.status !== "accepted")
            throw new DiscordCaptureReviewUnavailableError(
              "The binding could not be accepted. Refresh the capture review; originals are retained."
            );
          const actual = result.decision.logicalMeeting;
          // Source admission is the wake-up seam; interpretation remains owned by MI.
          let ready = false;
          try {
            ready = (await ingestion.ingest(actual)).analysisStatus === "completed";
          } catch {
            /* The accepted Human binding survives a deferred analysis attempt. */
          }
          if (source.id !== actual.id) {
            const previous = await logicalMeetings.get({
              workspaceId: workspace.workspaceId,
              logicalMeetingId: source.id
            });
            if (previous?.captureRefs.length) {
              try {
                await ingestion.ingest(previous);
              } catch {
                /* Old synthesis is fenced by its changed capture set. */
              }
            }
          }
          return response(
            actual.id,
            `Capture binding recorded.\nLogical meeting: ${actual.id}\nOriginal captures are retained.\n${ready ? "Synthesis is ready for review." : "Synthesis is pending; use /meeting synthesis and /meeting usage for current availability."}`
          );
        }
        const current = await synthesis(meetingId);
        await requireSame([before]);
        if (!current.synthesis || current.availability !== "available")
          return response(
            meetingId,
            `Logical meeting: ${meetingId}\nSynthesis: ${current.availability}. Sources may be incomplete or awaiting analysis. Use /meeting captures for source capabilities and /meeting usage for limits.`
          );
        const selected = current.synthesis;
        if (command.type === "synthesis") {
          const content = pageText(
            renderSynthesis(selected, current.followUpIntentions?.[0]?.status),
            command.page,
            `Logical meeting: ${meetingId} · synthesis revision ${selected.revision}`
          );
          const result = await response(meetingId, content, selected.revision);
          await requireSame([before]);
          return result;
        }
        if (selected.revision !== command.revision)
          throw new DiscordCaptureReviewUnavailableError(
            "This synthesis changed. Read /meeting synthesis again before acting."
          );
        if (command.type === "judge") {
          if (!selected.claims.some((c) => c.id === command.claimId))
            throw new DiscordCaptureReviewUnavailableError(
              "Choose an exact claim_id from this synthesis revision."
            );
          if (command.choice === "correct" && !command.text?.trim())
            throw new DiscordCaptureReviewUnavailableError(
              "A correction needs the replacement claim text."
            );
          const update = await meetingIntelligence.observe({
            workspace,
            observations: [
              {
                type: "capture-synthesis-judgment-recorded",
                observationId: `discord-synthesis-judgment:${command.interactionId}`,
                workspaceId: workspace.workspaceId,
                meetingId,
                occurredAt: command.occurredAt,
                observedAt: command.occurredAt,
                participantId: actorPersonId,
                expectedSynthesisRevision: command.revision,
                claimId: command.claimId,
                judgment:
                  command.choice === "correct"
                    ? { kind: "correct", text: command.text! }
                    : { kind: command.choice }
              }
            ]
          });
          if (update.errors.length)
            throw new DiscordCaptureReviewUnavailableError(
              "This judgment was not accepted. Refresh /meeting synthesis before retrying."
            );
          const next = (await synthesis(meetingId)).synthesis;
          return response(
            meetingId,
            `Human ${command.choice} recorded for ${command.claimId}.\nLogical meeting: ${meetingId}\nSynthesis revision: ${next?.revision ?? "unavailable"}. Review /meeting synthesis before publication.`,
            next?.revision
          );
        }
        const intent = current.followUpIntentions?.find(
          (i) => i.synthesisRevision === command.revision
        );
        if (!intent)
          throw new DiscordCaptureReviewUnavailableError(
            "No current publication intent is available for this synthesis."
          );
        if (!command.recover) {
          const update = await meetingIntelligence.observe({
            workspace,
            observations: [
              {
                type: "follow-up-intent-approved",
                observationId: `discord-synthesis-publication:${command.interactionId}`,
                workspaceId: workspace.workspaceId,
                meetingId,
                occurredAt: command.occurredAt,
                observedAt: command.occurredAt,
                approvedBy: actorPersonId,
                intentId: intent.id
              }
            ]
          });
          if (update.errors.length)
            throw new DiscordCaptureReviewUnavailableError(
              "Publication approval was not accepted. Refresh /meeting synthesis before retrying."
            );
        }
        const execution = await input.followUpExecution[
          command.recover ? "recover" : "execute"
        ]({ workspace, meetingId, intentId: intent.id });
        const outcome = execution.observation.outcome;
        return response(
          meetingId,
          `Synthesis revision ${command.revision} publication: ${outcome.status}.\n${outcome.status === "succeeded" ? outcome.externalReferences.map((ref) => ref.url ?? ref.externalId).join("\n") : outcome.message}\nLogical meeting: ${meetingId}`,
          command.revision
        );
      } catch (error) {
        if (error instanceof DiscordCaptureReviewUnavailableError) throw error;
        throw new DiscordCaptureReviewUnavailableError();
      }
    }
  };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function renderCaptures(meeting: LogicalMeeting): string[] {
  return [
    `Logical meeting: ${meeting.id}\nCanonical record: ${meeting.canonicalAnchorRef?.url ?? "not published"}`,
    ...meeting.captureRefs.map(
      (c) =>
        `Capture: ${c.id}\nSource revision: ${c.latestRevision.sourceRevision} · ${c.address.providerId}\nBinding: ${c.binding.state} (${c.binding.origin})\nCaptured: ${c.latestRevision.capturedAt}\n${Object.entries(
          c.latestRevision.capabilities
        )
          .map(([key, value]) => `${key}: ${value}`)
          .join(
            " · "
          )}\n${c.latestRevision.externalReference.url ?? "Source link unavailable"}`
    ),
    "Provider-derived notes are not verbatim speech. /meeting capture-link explicitly binds or separates the named capture revision; originals remain intact."
  ];
}
function renderSynthesis(
  synthesis: LumaSynthesis,
  publication: string | undefined
): string[] {
  return [
    `Logical meeting: ${synthesis.logicalMeetingId}\nSynthesis revision: ${synthesis.revision} · coverage: ${synthesis.coverage}\nCanonical record: ${synthesis.canonicalAnchorRef?.url ?? "not published"}\nPublication: ${publication ?? "unavailable"}`,
    ...synthesis.claims.map(
      (c) =>
        `Claim: ${c.id}\n${c.kind} · ${c.authority} · confidence: ${c.confidence}\n${c.text}\nConflicts: ${c.conflictingClaimIds.join(", ") || "none recorded"}\nSources: ${c.citations.map((r) => `${r.captureId} revision ${r.sourceRevision}`).join(", ")}\n${c.quotations.map((q) => `Verbatim: ${q.text}`).join("\n")}`
    ),
    "Use /meeting judge with this revision and claim_id to confirm, correct or reject. /meeting publish approves and publishes this exact derived revision. recover:true only checks an uncertain publication; it does not send another write."
  ];
}
/** Preserve complete claim text across bounded pages, including long corrections/quotations. */
function pageText(sections: string[], page: number, context = ""): string {
  const text = sections.join("\n\n").replaceAll("@", "@\u200b");
  const pages: string[] = [];
  for (let offset = 0; offset < text.length; offset += 1450)
    pages.push(text.slice(offset, offset + 1450));
  return `${context ? `${context}\n\n` : ""}${pages[page - 1] ?? "No content on this page."}\n\nPage ${page}/${pages.length || 1}`;
}
