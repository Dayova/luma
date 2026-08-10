import type { Issue } from "@linear/sdk";
import type { LinearApiIssue } from "./linear-work-item.js";

/**
 * Reads the fields Luma normalizes from a Linear SDK Issue. Both concrete
 * Linear adapters use this read-only conversion; it does not know about a
 * writer-capable provider Interface.
 */
export async function linearSdkIssueToApiIssue(
  issue: Issue,
  options: { labelLimit?: number } = {}
): Promise<LinearApiIssue> {
  const labelLimit = options.labelLimit ?? 100;
  const [assignee, state, labels] = await Promise.all([
    issue.assignee ?? Promise.resolve(undefined),
    issue.state ?? Promise.resolve(undefined),
    issue.labels({ first: labelLimit })
  ]);

  return {
    id: issue.id,
    teamId: issue.teamId ?? "",
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    stateType: state?.type ?? "backlog",
    stateName: state?.name ?? "Backlog",
    assignee: assignee
      ? {
          id: assignee.id,
          displayName: assignee.displayName,
          email: assignee.email
        }
      : null,
    dueDate: optionalString(issue.dueDate as unknown),
    labels: labels.nodes.map((label) => label.name),
    projectId: issue.projectId ?? null,
    parentId: issue.parentId ?? null,
    url: issue.url,
    updatedAt: issue.updatedAt.toISOString()
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
