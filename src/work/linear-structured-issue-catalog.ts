import { LinearClient } from "@linear/sdk";
import { z } from "zod";
import type { LinearApiIssue } from "./linear-work-item.js";

const id = z.string().min(1).max(256);
const issueSchema = z.object({
  id,
  identifier: id,
  title: z.string().min(1).max(1024),
  description: z.string().max(64000).nullable(),
  url: z.string().url().max(2000),
  updatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.null(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .nullable(),
  team: z.object({ id }),
  project: z.object({ id }).nullable(),
  parent: z.object({ id }).nullable(),
  state: z.object({
    type: z.enum([
      "triage",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "duplicate"
    ]),
    name: z.string().min(1).max(256)
  }),
  assignee: z
    .object({
      id,
      displayName: z.string().min(1).max(256),
      email: z.string().max(512)
    })
    .nullable(),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string().min(1).max(256) })).max(51),
    pageInfo: z.object({ hasNextPage: z.boolean() })
  })
});
const schema = z.object({
  team: z.object({ id }),
  issues: z.object({
    nodes: z.array(issueSchema).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean() })
  })
});
const query = `query LumaStructuredWorkCatalog($teamId: ID!, $teamSelector: String!, $first: Int!) {
  team(id: $teamSelector) { id }
  issues(first: $first, includeArchived: false, filter: {team: {id: {eq: $teamId}}}) {
    pageInfo { hasNextPage }
    nodes {
      id identifier title description url updatedAt archivedAt dueDate
      team { id } project { id } parent { id }
      state { type name }
      assignee { id displayName email }
      labels(first: 51) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;

/** One exact bounded query replaces SDK lazy relationship reads for every issue. */
export function createLinearStructuredIssueCatalog(config: {
  apiKey: string;
  teamId: string;
  apiUrl?: string;
}) {
  return {
    async listIssues(input: {
      teamId: string;
      limit: number;
    }): Promise<{ items: LinearApiIssue[]; complete: boolean }> {
      if (
        input.teamId !== config.teamId ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new Error(
          "The complete Linear scope must select 1–100 issues in its configured team"
        );
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A scoped SDK instance carries cancellation to fetch without changing the
        // shared writer client's transport, credentials or other concurrent calls.
        const client = new LinearClient({
          apiKey: config.apiKey,
          ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
          signal: controller.signal,
          redirect: "error"
        });
        const response = await Promise.race([
          client.client.rawRequest<
            unknown,
            { teamId: string; teamSelector: string; first: number }
          >(query, {
            teamId: config.teamId,
            teamSelector: config.teamId,
            first: input.limit
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Linear catalog deadline reached"));
            }, 15000);
          })
        ]);
        const envelope = schema.parse(response.data);
        if (envelope.team.id !== config.teamId)
          throw new Error("The configured team is not readable");
        const parsed = envelope.issues;
        if (
          parsed.nodes.length > input.limit ||
          parsed.nodes.some((issue) => issue.team.id !== config.teamId) ||
          new Set(parsed.nodes.map((issue) => issue.id)).size !== parsed.nodes.length ||
          new Set(parsed.nodes.map((issue) => issue.identifier)).size !==
            parsed.nodes.length
        )
          throw new Error(
            "The current Linear catalog has inconsistent identities or scope"
          );
        if (
          parsed.nodes.some(
            (issue) => issue.labels.pageInfo.hasNextPage || issue.labels.nodes.length > 50
          )
        )
          return { items: [], complete: false };
        const items = parsed.nodes
          .map((issue): LinearApiIssue => ({
            id: issue.id,
            identifier: issue.identifier,
            teamId: issue.team.id,
            title: issue.title,
            description: issue.description ?? "",
            stateType: issue.state.type,
            stateName: issue.state.name,
            assignee: issue.assignee
              ? {
                  id: issue.assignee.id,
                  displayName: issue.assignee.displayName,
                  email: issue.assignee.email
                }
              : null,
            dueDate: issue.dueDate,
            labels: issue.labels.nodes.map((label) => label.name),
            projectId: issue.project?.id ?? null,
            parentId: issue.parent?.id ?? null,
            url: issue.url,
            updatedAt: new Date(issue.updatedAt).toISOString()
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { items, complete: !parsed.pageInfo.hasNextPage };
      } catch {
        // SDK errors contain the original query and response. Do not expose private
        // issue data or mistake HTTP-200 partial GraphQL success for complete absence.
        throw new Error(
          "The complete current Linear catalog is unavailable; no absence or mutation is authorized"
        );
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }
  };
}
