import type { WorkItem } from "./interface.js";

/**
 * Provider-shaped read data shared by the separate Linear read and write
 * adapters. It deliberately contains no mutation inputs or SDK types.
 */
export type LinearApiIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType: string;
  stateName: string;
  assignee: {
    id: string;
    displayName: string;
    email: string;
  } | null;
  dueDate: string | null;
  labels: string[];
  projectId: string | null;
  parentId: string | null;
  url: string;
  updatedAt: string;
};

export function toLinearWorkItem(issue: LinearApiIssue, providerId: string): WorkItem {
  return {
    id: issue.id,
    providerId,
    externalId: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: normalizeLinearStatus(issue),
    assignees: issue.assignee
      ? [
          {
            id: issue.assignee.id,
            displayName: issue.assignee.displayName,
            username: issue.assignee.email
          }
        ]
      : [],
    dueDate: issue.dueDate,
    labels: issue.labels,
    projectId: issue.projectId,
    parentId: issue.parentId,
    url: issue.url,
    updatedAt: issue.updatedAt
  };
}

function normalizeLinearStatus(issue: LinearApiIssue): WorkItem["status"] {
  if (issue.labels.some((label) => label.toLowerCase() === "blocked")) {
    return "blocked";
  }

  switch (issue.stateType) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "planned";
    case "started":
      return "active";
    case "completed":
      return "completed";
    case "canceled":
    case "duplicate":
      return "cancelled";
    default:
      return "planned";
  }
}
