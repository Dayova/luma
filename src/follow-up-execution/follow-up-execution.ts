import type { KnowledgeProvider } from "../knowledge/interface.js";
import type { WorkProvider } from "../work/interface.js";
import type { CodeProvider } from "../code/interface.js";
import type { IdentityDirectory } from "../identity/interface.js";
import {
  renderGitHubMentions,
  resolveGitHubLogin
} from "../identity/static-identity-directory.js";
import type {
  ExternalReference,
  FollowUpExecutionRecorded,
  FollowUpIntent,
  MeetingIntelligenceEvent
} from "../domain/model.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type {
  ExecuteFollowUpInput,
  ExecuteFollowUpResult,
  FollowUpExecution
} from "./interface.js";

export type CreateFollowUpExecutionInput = {
  meetingIntelligence: MeetingIntelligence;
  identityDirectory?: IdentityDirectory;
  knowledgeProvider?: KnowledgeProvider;
  workProvider?: WorkProvider;
  codeProvider?: CodeProvider;
  now?: () => Date;
};

export function createFollowUpExecution(
  input: CreateFollowUpExecutionInput
): FollowUpExecution {
  const executed = new Map<string, ExecuteFollowUpResult>();
  const now = input.now ?? (() => new Date());

  return {
    async execute(executeInput) {
      const idempotencyKey = createIdempotencyKey(
        executeInput.workspace.workspaceId,
        executeInput.meetingId,
        executeInput.intent,
        "execute"
      );
      const previous = executed.get(idempotencyKey);

      if (previous) {
        return previous;
      }

      const observation = await executeIntent(input, executeInput, idempotencyKey, now);
      const update = await input.meetingIntelligence.observe({
        workspace: executeInput.workspace,
        observations: [observation]
      });
      const result: ExecuteFollowUpResult = {
        observation,
        events: update.events,
        idempotencyKey
      };
      executed.set(idempotencyKey, result);
      return result;
    }
  };
}

async function executeIntent(
  dependencies: CreateFollowUpExecutionInput,
  input: ExecuteFollowUpInput,
  idempotencyKey: string,
  now: () => Date
): Promise<FollowUpExecutionRecorded> {
  const occurredAt = now().toISOString();

  try {
    const externalReferences = await runProviderMutation(
      dependencies,
      input,
      idempotencyKey
    );
    return {
      type: "follow-up-execution-recorded",
      observationId: `follow-up-execution:${input.intent.id}:succeeded`,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      occurredAt,
      observedAt: occurredAt,
      intentId: input.intent.id,
      outcome: {
        status: "succeeded",
        externalReferences,
        summary: summarizeSuccess(input.intent, externalReferences)
      }
    };
  } catch (error) {
    return {
      type: "follow-up-execution-recorded",
      observationId: `follow-up-execution:${input.intent.id}:failed`,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      occurredAt,
      observedAt: occurredAt,
      intentId: input.intent.id,
      outcome: {
        status: "failed",
        errorCode: "provider-mutation-failed",
        message: error instanceof Error ? error.message : "Provider mutation failed",
        retryable: true
      }
    };
  }
}

async function runProviderMutation(
  dependencies: CreateFollowUpExecutionInput,
  input: ExecuteFollowUpInput,
  idempotencyKey: string
): Promise<ExternalReference[]> {
  const { intent } = input;

  switch (intent.type) {
    case "record-meeting": {
      if (!dependencies.knowledgeProvider) {
        throw new Error("KnowledgeProvider is not configured");
      }

      const reference = await dependencies.knowledgeProvider.createDocument({
        title: intent.title,
        contentMarkdown: renderMeetingRecordPlaceholder(intent),
        parentId: null,
        idempotencyKey
      });
      return [reference];
    }
    case "update-knowledge": {
      if (!dependencies.knowledgeProvider) {
        throw new Error("KnowledgeProvider is not configured");
      }

      const reference = await dependencies.knowledgeProvider.createDocument({
        title: intent.title,
        contentMarkdown: intent.bodyMarkdown,
        parentId: null,
        idempotencyKey
      });
      return [reference];
    }
    case "create-work-item": {
      if (!dependencies.workProvider) {
        throw new Error("WorkProvider is not configured");
      }

      const assigneeProviderUserId = await resolveGitHubLogin({
        identityDirectory: dependencies.identityDirectory,
        workspaceId: input.workspace.workspaceId,
        personId: intent.assigneeId
      });
      const mentionProviderUserIds = await resolveMentionProviderUserIds(
        dependencies.identityDirectory,
        input.workspace.workspaceId,
        intent
      );
      const reference = await dependencies.workProvider.createWorkItem({
        title: intent.title,
        description: intent.description,
        assigneeProviderUserId,
        mentionProviderUserIds,
        dueDate: intent.dueDate,
        labels: [],
        idempotencyKey
      });
      return [reference];
    }
    case "update-work-item": {
      if (!dependencies.workProvider) {
        throw new Error("WorkProvider is not configured");
      }

      const reference = await dependencies.workProvider.updateWorkItem(
        intent.externalReference.externalId,
        {
          description: intent.description,
          idempotencyKey
        }
      );
      return [reference];
    }
    case "comment-on-code-change": {
      if (!dependencies.codeProvider) {
        throw new Error("CodeProvider is not configured");
      }

      return [intent.externalReference];
    }
  }
}

function createIdempotencyKey(
  workspaceId: string,
  meetingId: string,
  intent: FollowUpIntent,
  operation: string
): string {
  return `${workspaceId}:${meetingId}:${intent.id}:${operation}`;
}

function renderMeetingRecordPlaceholder(intent: FollowUpIntent): string {
  return `# ${intent.type}\n\nGenerated from approved Follow-up Intent ${intent.id}.`;
}

function summarizeSuccess(
  intent: FollowUpIntent,
  externalReferences: ExternalReference[]
): string {
  const links = externalReferences.map((reference) => reference.url).join(", ");
  return `${intent.type} succeeded${links.length > 0 ? `: ${links}` : "."}`;
}

export function renderDiscordReceiptEvents(
  result: ExecuteFollowUpResult
): MeetingIntelligenceEvent[] {
  return result.events;
}

async function resolveMentionProviderUserIds(
  identityDirectory: IdentityDirectory | undefined,
  workspaceId: string,
  intent: Extract<FollowUpIntent, { type: "create-work-item" }>
): Promise<string[]> {
  const personIds = [intent.assigneeId, ...(intent.mentionPersonIds ?? [])].filter(
    (personId): personId is string => Boolean(personId)
  );
  const mentions = await renderGitHubMentions({
    identityDirectory,
    workspaceId,
    personIds
  });

  return mentions.map((mention) => mention.slice(1));
}
