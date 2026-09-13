import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import type { PersonIdentity } from "../../src/identity/interface.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createNotionNativeReviewAccess } from "../../src/knowledge/notion-native-review-access.js";
import type { CapturedMeetingNoteEvidence } from "../../src/native-review/source-bound-native-review.js";

export const workspace = { workspaceId: "dayova", timezone: "Europe/Berlin" };
export const ids = {
  space: "10000000-0000-4000-8000-000000000000",
  agent: "20000000-0000-4000-8000-000000000000",
  page: "30000000-0000-4000-8000-000000000000",
  session: "40000000-0000-4000-8000-000000000000",
  event: "50000000-0000-4000-8000-000000000000"
};
export const locator = { sessionId: ids.session, eventId: ids.event };
export const people: PersonIdentity[] = dayovaFounderPersonIds.map((personId, index) => ({
  personId,
  displayName: personId,
  discordUserId: null,
  discordUsername: null,
  githubLogin: null,
  githubUserId: null,
  atlassianAccountId: null,
  linearUserId: null,
  notionUserId: `60000000-0000-4000-8000-00000000000${index}`,
  languagePreference: "auto"
}));
export function providerHarness() {
  const directory = createStaticIdentityDirectory({ people });
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    authorizedPersonIds: [...dayovaFounderPersonIds],
    identityDirectory: directory
  });
  const permissions = {
    permissions: people.map((p) => ({
      principal: { type: "user", user_id: p.notionUserId },
      role: "view_and_interact",
      resolved_role: "view_and_interact"
    }))
  };
  const session = { object: "session", id: ids.session, agent_id: ids.agent };
  const event = {
    object: "session_event",
    id: ids.event,
    session_id: ids.session,
    sequence: 1,
    created_at: "2026-09-11T12:00:00.000Z",
    type: "user.message",
    created_by: { type: "user", id: people[0]!.notionUserId },
    content: [{ type: "text", text: `Luma review https://www.notion.so/${ids.page}` }],
    metadata: { user_id: "not-authority" }
  };
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  let transform: (
    kind: "permissions" | "session" | "events",
    value: unknown
  ) => unknown = (_, value) => value;
  let fetchOverride: (() => Promise<Response>) | undefined;
  const fetcher: typeof fetch = async (url, options) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    requests.push({ url: requestUrl, ...(options ? { options } : {}) });
    if (fetchOverride) return fetchOverride();
    const path = new URL(requestUrl).pathname;
    let kind: "permissions" | "session" | "events";
    if (path === `/admin/v1/spaces/${ids.space}/agents/${ids.agent}/permissions`)
      kind = "permissions";
    else if (path === `/v1/sessions/${ids.session}`) kind = "session";
    else if (path === `/v1/sessions/${ids.session}/events/query`) kind = "events";
    else throw new Error("Unexpected provider request");
    return Response.json(
      transform(
        kind,
        kind === "permissions"
          ? permissions
          : kind === "session"
            ? session
            : {
                object: "list",
                type: "session_event",
                results: [event],
                has_more: false,
                next_cursor: null
              }
      )
    );
  };
  return {
    directory,
    accessPolicy,
    permissions,
    session,
    event,
    requests,
    transform(fn: typeof transform) {
      transform = fn;
    },
    override(fn: () => Promise<Response>) {
      fetchOverride = fn;
    },
    createAccess(timeoutMs = 1000) {
      return createNotionNativeReviewAccess({
        workspaceId: workspace.workspaceId,
        notionWorkspaceId: ids.space,
        agentId: ids.agent,
        pageId: ids.page,
        agentReadToken: "agent-reader",
        adminReadToken: "admin-reader",
        identityDirectory: directory,
        accessPolicy,
        fetch: fetcher,
        timeoutMs
      });
    }
  };
}
export function evidence(): CapturedMeetingNoteEvidence {
  return {
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId: "meeting-root",
      parentObjectId: ids.page,
      url: `https://www.notion.so/${ids.page}`
    },
    providerVersion: "2026-09-11T12:00:00.000Z",
    observedAt: "2026-09-11T12:01:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: "Release review",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: {
          state: "available",
          sourceBlockId: "summary",
          text: "Prepare release",
          blocks: []
        },
        actionItemsAndNotes: {
          state: "available",
          sourceBlockId: "notes",
          text: "Jakob will prepare release checklist by 2026-09-18.",
          blocks: [
            {
              id: "task-1",
              type: "to-do",
              text: "Jakob will prepare release checklist by 2026-09-18.",
              checked: false,
              children: []
            }
          ]
        },
        transcript: {
          state: "available",
          sourceBlockId: "transcript",
          text: "We could prepare a release checklist.",
          blocks: []
        }
      },
      markdown: { content: "# Release review", truncated: false, unknownBlockIds: [] },
      completeness: { state: "complete" }
    }
  };
}
