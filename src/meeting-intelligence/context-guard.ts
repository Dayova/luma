import type { MeetingState, Provenance, WorkspaceId } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ContextAudience,
  OrganizationalContext,
  OrganizationalContextRequest
} from "../organizational-context/interface.js";

export type MeetingContextExecutionGuard = {
  requireIntentCurrent(input: {
    workspaceId: WorkspaceId;
    meetingId: string;
    intentId: string;
  }): Promise<void>;
};
export type MeetingContextConfiguration = {
  database: LumaDatabase;
  organizationalContext?: OrganizationalContext;
  /** Configured actual shared audience; never inferred from Meeting attendance. */
  contextAudience?: (workspaceId: WorkspaceId) => Promise<ContextAudience | null>;
};
export class MeetingContextUnavailableError extends Error {
  constructor() {
    super("Meeting organizational context is unavailable or changed.");
    this.name = "MeetingContextUnavailableError";
  }
}
export async function migrateMeetingContext(database: LumaDatabase): Promise<void> {
  await database.exec(`CREATE TABLE IF NOT EXISTS meeting_context_receipts (
    workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, meeting_id, receipt_id)
  )`);
}
export async function retainMeetingContextReceipt(
  database: LumaDatabase,
  request: OrganizationalContextRequest,
  receiptId: string
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_context_receipts (workspace_id,meeting_id,receipt_id,request_json) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [request.audience.workspaceId, request.subject.id, receiptId, JSON.stringify(request)]
  );
}

export function contextReceiptIds(state: MeetingState): string[] {
  return [
    ...new Set(
      contextItems(state).flatMap((item) => item.provenance.contextReceiptIds ?? [])
    )
  ];
}
type ContextItem = {
  id: string;
  provenance: Provenance;
  relatedMeetingItemIds?: string[];
  relatedDecisionIds?: string[];
  relatedTopicIds?: string[];
  supersedesDecisionId?: string | null;
};
export function contextItems(state: MeetingState): ContextItem[] {
  return [
    ...(state.topics ?? []),
    ...(state.proposals ?? []),
    ...(state.decisions ?? []),
    ...(state.actionItems ?? []),
    ...(state.openQuestions ?? []),
    ...(state.risks ?? []),
    ...(state.followUpIntentions ?? [])
  ];
}
function relatedIds(item: ContextItem): string[] {
  return [
    ...(item.relatedMeetingItemIds ?? []),
    ...(item.relatedDecisionIds ?? []),
    ...(item.relatedTopicIds ?? []),
    ...(item.supersedesDecisionId ? [item.supersedesDecisionId] : [])
  ];
}

export function createMeetingContextGuard(config: MeetingContextConfiguration) {
  if (Boolean(config.organizationalContext) !== Boolean(config.contextAudience))
    throw new Error(
      "Meeting organizational context requires an explicit audience resolver."
    );
  const check = async (
    workspaceId: string,
    meetingId: string,
    receiptId: string
  ): Promise<void> => {
    if (!config.organizationalContext || !config.contextAudience || !receiptId)
      throw new MeetingContextUnavailableError();
    const audience = await config.contextAudience(workspaceId);
    if (!audience || audience.workspaceId !== workspaceId || !audience.personIds.length)
      throw new MeetingContextUnavailableError();
    const rows = await config.database.query<{ request_json: string }>(
      `SELECT request_json FROM meeting_context_receipts WHERE workspace_id=$1 AND meeting_id=$2 AND receipt_id=$3`,
      [workspaceId, meetingId, receiptId]
    );
    const row = rows.rows[0];
    if (!row) throw new MeetingContextUnavailableError();
    const request = JSON.parse(row.request_json) as OrganizationalContextRequest;
    if (
      request.audience.workspaceId !== workspaceId ||
      request.subject.type !== "meeting" ||
      request.subject.id !== meetingId ||
      JSON.stringify([...new Set(audience.personIds)].sort()) !==
        JSON.stringify([...new Set(request.audience.personIds)].sort())
    )
      throw new MeetingContextUnavailableError();
    await config.organizationalContext.requireCurrent(request, receiptId);
  };
  const eligibleReceipts = async (state: MeetingState): Promise<Set<string>> => {
    const eligible = new Set<string>();
    // Independent items remain usable if older derived dependencies exceed this
    // read bound. No unverified receipt is silently considered current.
    const ids = contextReceiptIds(state).slice(-20);
    const deadlineAt = Date.now() + 15_000;
    await Promise.all(
      ids.map(async (id) => {
        try {
          await withinDeadline(check(state.workspaceId, state.meetingId, id), deadlineAt);
          eligible.add(id);
        } catch {
          /* A read projection withholds only the dependent items. */
        }
      })
    );
    return eligible;
  };
  const project = async (state: MeetingState): Promise<MeetingState> => {
    const eligible = await eligibleReceipts(state);
    const itemAllowed = (item: { provenance: Provenance }): boolean =>
      (item.provenance.contextReceiptIds ?? []).every((id) => eligible.has(id));
    const items = contextItems(state);
    const blocked = new Set(
      items.filter((item) => !itemAllowed(item)).map((item) => item.id)
    );
    for (let previousSize = -1; blocked.size !== previousSize;) {
      previousSize = blocked.size;
      for (const item of items)
        if (relatedIds(item).some((id) => blocked.has(id))) blocked.add(item.id);
    }
    const visible = <T extends { id: string }>(values: T[]): T[] =>
      values.filter((item) => !blocked.has(item.id));
    const count = blocked.size;
    const partial = items.some(
      (item) =>
        !blocked.has(item.id) && item.provenance.contextCoverage?.complete === false
    );
    return {
      ...state,
      topics: visible(state.topics),
      proposals: visible(state.proposals),
      decisions: visible(state.decisions),
      actionItems: visible(state.actionItems),
      openQuestions: visible(state.openQuestions),
      risks: visible(state.risks),
      followUpIntentions: visible(state.followUpIntentions),
      humanJudgmentItemIds: state.humanJudgmentItemIds.filter((id) => !blocked.has(id)),
      currentTopicId:
        state.currentTopicId && blocked.has(state.currentTopicId)
          ? null
          : state.currentTopicId,
      contextAvailability: {
        status: count
          ? count === items.length
            ? "unavailable"
            : "partial"
          : config.organizationalContext
            ? partial
              ? "partial"
              : "complete"
            : "not-configured",
        withheldItemCount: count,
        warnings: count
          ? [
              "Some derived Meeting items are unavailable because their organizational sources changed or could not be verified. Original Meeting evidence and Human history are retained."
            ]
          : config.organizationalContext
            ? partial
              ? [
                  "Organizational context retrieval is partial; additional relevant knowledge may be unavailable."
                ]
              : []
            : [
                "Organizational retrieval is not configured; this view uses the Meeting's own evidence only."
              ]
      }
    };
  };
  const requireReceiptsCurrent = async (input: {
    workspaceId: string;
    meetingId: string;
    receiptIds: readonly string[];
  }): Promise<void> => {
    const ids = [...new Set(input.receiptIds)];
    if (ids.length > 20) throw new MeetingContextUnavailableError();
    const deadlineAt = Date.now() + 15_000;
    try {
      await Promise.all(
        ids.map((id) =>
          withinDeadline(check(input.workspaceId, input.meetingId, id), deadlineAt)
        )
      );
    } catch {
      throw new MeetingContextUnavailableError();
    }
  };
  const requireIntentCurrent: MeetingContextExecutionGuard["requireIntentCurrent"] =
    async (input) => {
      const rows = await config.database.query<{ state_json: string }>(
        `SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2`,
        [input.workspaceId, input.meetingId]
      );
      if (!rows.rows[0]) throw new MeetingContextUnavailableError();
      const state = JSON.parse(rows.rows[0].state_json) as MeetingState;
      const intent = state.followUpIntentions.find((item) => item.id === input.intentId);
      if (!intent) throw new MeetingContextUnavailableError();
      const items = contextItems(state);
      const selectedIds = new Set(
        intent.type === "record-meeting" ? items.map((item) => item.id) : [intent.id]
      );
      for (let previousSize = -1; selectedIds.size !== previousSize;) {
        previousSize = selectedIds.size;
        for (const item of items)
          if (selectedIds.has(item.id))
            for (const id of relatedIds(item)) selectedIds.add(id);
      }
      const selected = items.filter((item) => selectedIds.has(item.id));
      await requireReceiptsCurrent({
        ...input,
        receiptIds: selected.flatMap((item) => item.provenance.contextReceiptIds ?? [])
      });
    };
  return { project, requireReceiptsCurrent, requireIntentCurrent };
}

async function withinDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MeetingContextUnavailableError()),
          Math.max(0, deadlineAt - Date.now())
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
