import { z } from "zod";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import type { IdentityDirectory } from "../identity/interface.js";
import type {
  NativeReviewAccess,
  NativeReviewDiscovery,
  NativeReviewDiscoveryResult,
  NativeReviewInstruction,
  NativeReviewLocator
} from "../native-review/native-review-access.js";
import { NativeReviewUnavailable } from "../native-review/native-review-access.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";

const uuid = z.string().uuid();
const user = z.object({ type: z.literal("user"), id: uuid });
const eventSchema = z.object({
  object: z.literal("session_event"),
  id: uuid,
  session_id: uuid,
  sequence: z.number().int().positive(),
  created_at: z.string().datetime(),
  type: z.literal("user.message"),
  created_by: user,
  content: z
    .array(
      z.object({ type: z.literal("text"), text: z.string().min(1).max(2048) }).strict()
    )
    .length(1)
});
const eventsSchema = z.object({
  object: z.literal("list"),
  type: z.literal("session_event"),
  results: z.array(eventSchema).length(1),
  has_more: z.literal(false),
  next_cursor: z.null()
});
const permissionsSchema = z
  .object({
    permissions: z
      .array(
        z
          .object({
            principal: z.object({ type: z.literal("user"), user_id: uuid }).strict(),
            role: z.enum(["edit", "full_access", "view_and_interact"]),
            resolved_role: z.enum(["edit", "full_access", "view_and_interact"])
          })
          .strict()
      )
      .length(4),
    next_cursor: z.never().optional()
  })
  .strict();

export type NotionNativeReviewAccessConfig = {
  workspaceId: string;
  notionWorkspaceId: string;
  agentId: string;
  pageId: string;
  /** Read access to the one Custom Agent. Never used to write/start sessions. */
  agentReadToken: string;
  /** Separate Admin API token restricted to workflows:read. */
  adminReadToken: string;
  identityDirectory: IdentityDirectory;
  accessPolicy: WorkspaceAccessPolicy;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

/** Fixed-origin agent/history and ACL reads only. No native mutation method is issued. */
export function createNotionNativeReviewAccess(
  input: NotionNativeReviewAccessConfig
): NativeReviewAccess & { discovery: NativeReviewDiscovery } {
  const pageId = uuid.parse(input.pageId);
  const agentId = uuid.parse(input.agentId);
  const spaceId = uuid.parse(input.notionWorkspaceId);
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (
    !input.workspaceId.trim() ||
    !input.agentReadToken.trim() ||
    !input.adminReadToken.trim() ||
    input.agentReadToken === input.adminReadToken ||
    timeoutMs < 10 ||
    timeoutMs > 30_000
  )
    throw new Error(
      "Native Notion review requires separate bounded agent and Admin read credentials"
    );
  const fetcher = input.fetch ?? globalThis.fetch;

  // User-facing deadlines do not detach owned proof work: stop waits its true completion.
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  };
  const run = async <T>(
    operation: (scope: {
      request: (path: string, admin: boolean, body?: unknown) => Promise<unknown>;
      audience: () => Promise<NativeReviewInstruction["recipients"]>;
    }) => Promise<T>,
    discovery = false
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = async (
      path: string,
      admin: boolean,
      body?: unknown
    ): Promise<unknown> => {
      const operation = async () => {
        const response = await fetcher(
          `https://api.notion.com/${admin ? "admin/" : ""}v1/${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${admin ? input.adminReadToken : input.agentReadToken}`,
              "Notion-Version": admin ? "2026-06-01" : "2026-03-11",
              "Content-Type": "application/json"
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }
        );
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        const reader = response.body?.getReader();
        if (!reader) throw unavailable();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const value: unknown = next.value;
            if (!(value instanceof Uint8Array)) throw unavailable();
            size += value.byteLength;
            if (size > 262_144) throw unavailable();
            chunks.push(value);
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } finally {
          void reader.cancel().catch(() => undefined);
        }
      };
      return wait(operation());
    };
    function wait<V>(promise: Promise<V>): Promise<V> {
      return withSignal(discovery ? track(promise) : promise, controller.signal);
    }
    const audience = async (): Promise<NativeReviewInstruction["recipients"]> => {
      // No private session content is fetched before the exact four-founder ACL proof.
      const permissions = permissionsSchema.parse(
        await request(`spaces/${spaceId}/agents/${agentId}/permissions`, true)
      );
      const recipients: NativeReviewInstruction["recipients"] = [];
      for (const personId of dayovaFounderPersonIds) {
        const person = await wait(
          input.identityDirectory.getPerson({
            workspaceId: input.workspaceId,
            personId
          })
        );
        const providerUserId = person?.notionUserId;
        if (!providerUserId || !uuid.safeParse(providerUserId).success)
          throw unavailable();
        const authorized = await wait(
          input.accessPolicy.authorize({
            workspaceId: input.workspaceId,
            providerId: "notion",
            providerUserId
          })
        );
        if (authorized?.personId !== personId) throw unavailable();
        recipients.push({ personId, providerUserId });
      }
      const granted = permissions.permissions.map((p) => p.principal.user_id).sort();
      if (
        new Set(granted).size !== 4 ||
        JSON.stringify(granted) !==
          JSON.stringify(recipients.map((p) => p.providerUserId).sort())
      )
        throw unavailable();
      return recipients;
    };
    try {
      return await operation({ request, audience });
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const instruction = (
    event: z.infer<typeof eventSchema>,
    sessionId: string,
    recipients: NativeReviewInstruction["recipients"]
  ): NativeReviewInstruction | null => {
    if (event.session_id !== sessionId) throw unavailable();
    const actor = recipients.find((p) => p.providerUserId === event.created_by.id);
    const originalText = event.content[0]?.text;
    if (!actor || !originalText || reviewPage(originalText) !== pageId) return null;
    return {
      agentId,
      sessionId,
      eventId: event.id,
      sequence: event.sequence,
      createdAt: event.created_at,
      originalText,
      actor: {
        identityProviderId: "notion",
        providerUserId: actor.providerUserId,
        personId: actor.personId
      },
      page: { providerId: "notion", pageId },
      audience: {
        workspaceId: input.workspaceId,
        personIds: [...dayovaFounderPersonIds].sort()
      },
      recipients
    };
  };
  const read = (locator: NativeReviewLocator): Promise<NativeReviewInstruction> =>
    run(async ({ request, audience }) => {
      const sessionId = uuid.parse(locator.sessionId),
        eventId = uuid.parse(locator.eventId);
      const recipients = await audience();
      const session = z
        .object({ object: z.literal("session"), id: uuid, agent_id: uuid })
        .parse(await request(`sessions/${sessionId}`, false));
      if (session.id !== sessionId || session.agent_id !== agentId) throw unavailable();
      const events = eventsSchema.parse(
        await request(`sessions/${sessionId}/events/query`, false, {
          filter: { property: "id", string: { equals: eventId } },
          page_size: 2
        })
      );
      const event = events.results[0];
      if (!event || event.id !== eventId) throw unavailable();
      const result = instruction(event, sessionId, recipients);
      if (!result || JSON.stringify(await audience()) !== JSON.stringify(recipients))
        throw unavailable();
      return result;
    });
  const scan = (window: { windowStart: string; windowEnd: string }) =>
    run(async ({ request, audience }) => {
      const recipients = await audience();
      const timestamp = (property: string) => [
        { property, timestamp: { on_or_after: window.windowStart } },
        { property, timestamp: { on_or_before: window.windowEnd } }
      ];
      const sessions = pageSchema(
        "session",
        z.object({
          object: z.literal("session"),
          id: uuid,
          agent_id: uuid,
          updated_at: z.string().datetime()
        }),
        5
      ).parse(
        await request("sessions/query", false, {
          filter: {
            and: [
              { property: "agent_id", string: { equals: agentId } },
              { property: "updated_at", timestamp: { on_or_after: window.windowStart } }
            ]
          },
          sorts: [{ property: "updated_at", direction: "descending" }],
          page_size: 5
        })
      );
      const limitations: NativeReviewDiscoveryResult["coverage"]["limitations"] = [];
      if (sessions.has_more) limitations.push("session-limit");
      const instructions: NativeReviewInstruction[] = [];
      const seenSessions = new Set<string>(),
        seenEvents = new Set<string>();
      for (const session of sessions.results) {
        if (
          session.agent_id !== agentId ||
          seenSessions.has(session.id) ||
          Date.parse(session.updated_at) < Date.parse(window.windowStart)
        )
          throw unavailable();
        seenSessions.add(session.id);
        const events = pageSchema(
          "session_event",
          z
            .object({
              object: z.literal("session_event"),
              id: uuid,
              session_id: uuid,
              sequence: z.number().int().positive(),
              created_at: z.string().datetime(),
              type: z.literal("user.message")
            })
            .passthrough(),
          20
        ).parse(
          await request(`sessions/${session.id}/events/query`, false, {
            filter: {
              and: [
                { property: "type", event_type: { equals: "user.message" } },
                ...timestamp("created_at")
              ]
            },
            sorts: [{ property: "sequence", direction: "descending" }],
            page_size: 20
          })
        );
        if (events.has_more && !limitations.includes("event-limit"))
          limitations.push("event-limit");
        for (const event of events.results) {
          if (
            event.session_id !== session.id ||
            seenEvents.has(event.id) ||
            !within(event.created_at, window)
          )
            throw unavailable();
          seenEvents.add(event.id);
          // Attachments, generated/bot/null authors and unrelated text never become requests.
          const parsed = eventSchema.safeParse(event);
          const match = parsed.success
            ? instruction(parsed.data, session.id, recipients)
            : null;
          if (match) instructions.push(match);
        }
      }
      instructions.sort(
        (a, b) =>
          (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0) ||
          (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
      );
      if (instructions.length > 10) limitations.push("result-limit");
      if (JSON.stringify(await audience()) !== JSON.stringify(recipients))
        throw unavailable();
      const result: NativeReviewDiscoveryResult = {
        requests: instructions.slice(0, 10).map((item) => ({
          sessionId: item.sessionId,
          eventId: item.eventId,
          createdAt: item.createdAt,
          actorLabel: founderLabels[item.actor.personId] ?? "Founder"
        })),
        coverage: { ...window, complete: limitations.length === 0, limitations }
      };
      // Bind final delivery to exact original authorship/text/audience, not just visible locators.
      return { result, instructions, recipients };
    }, true);
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new NativeReviewUnavailable("stopped"));
    return track(operation());
  };
  return {
    read,
    async requireCurrent(original) {
      if (JSON.stringify(await read(original)) !== JSON.stringify(original))
        throw unavailable();
    },
    discovery: {
      discover: () =>
        admit(async () => {
          const end = (input.now ?? (() => new Date()))();
          const window = {
            windowEnd: end.toISOString(),
            windowStart: new Date(end.getTime() - 7 * 86_400_000).toISOString()
          };
          const original = await scan(window);
          return {
            result: original.result,
            requireCurrent: () =>
              admit(async () => {
                if (JSON.stringify(await scan(window)) !== JSON.stringify(original))
                  throw unavailable();
              })
          };
        }),
      async stop() {
        stopped = true;
        while (pending.size) await Promise.allSettled([...pending]);
      }
    }
  };
}

const founderLabels: Readonly<Record<string, string>> = {
  person_jakob: "Jakob",
  person_fabius: "Fabius",
  person_philipp: "Philipp",
  person_julius: "Julius"
};
function pageSchema<T extends z.ZodTypeAny>(type: string, item: T, max: number) {
  return z
    .object({
      object: z.literal("list"),
      type: z.literal(type),
      results: z.array(item).max(max),
      has_more: z.boolean(),
      next_cursor: z.string().min(1).nullable()
    })
    .refine((page) => page.has_more === (page.next_cursor !== null));
}
function within(
  value: string,
  window: { windowStart: string; windowEnd: string }
): boolean {
  return (
    Date.parse(value) >= Date.parse(window.windowStart) &&
    Date.parse(value) <= Date.parse(window.windowEnd)
  );
}

function reviewPage(text: string): string | null {
  const match =
    /^Luma review (https:\/\/(?:www\.notion\.so|notion\.so|app\.notion\.com)\/\S+)$/u.exec(
      text
    );
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    if (url.username || url.password || url.port || url.hash) return null;
    const last = url.pathname.split("/").at(-1) ?? "";
    return canonicalNotionObjectId(last) ?? canonicalNotionObjectId(last.slice(-32));
  } catch {
    return null;
  }
}
function unavailable() {
  return new NativeReviewUnavailable("access-unavailable");
}
async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(unavailable());
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
