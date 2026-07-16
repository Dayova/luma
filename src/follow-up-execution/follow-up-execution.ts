import type { KnowledgeProvider } from "../knowledge/interface.js";
import type { WorkProvider } from "../work/interface.js";
import type { CodeProvider } from "../code/interface.js";
import type { IdentityDirectory } from "../identity/interface.js";
import {
  resolveProviderUserId,
  resolveProviderUserIds
} from "../identity/static-identity-directory.js";
import type {
  ExternalReference,
  FollowUpExecutionRecorded,
  FollowUpIntent,
  MeetingIntelligenceEvent
} from "../domain/model.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ExecuteFollowUpInput,
  ExecuteFollowUpResult,
  FollowUpExecution
} from "./interface.js";

export type CreateFollowUpExecutionInput = {
  database: LumaDatabase;
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
  const executionLocks = new Map<string, Promise<void>>();
  const now = input.now ?? (() => new Date());

  return {
    async execute(executeInput) {
      const idempotencyKey = createIdempotencyKey(
        executeInput.workspace.workspaceId,
        executeInput.meetingId,
        executeInput.intent,
        "execute"
      );
      return withExecutionLock(executionLocks, idempotencyKey, async () => {
        const previous = await loadCompletedExecution(input.database, idempotencyKey);

        if (previous) {
          return previous;
        }

        if (executeInput.intent.status !== "approved") {
          throw new Error(
            `Follow-up Intent ${executeInput.intent.id} must be approved before execution`
          );
        }

        await reserveExecution(input.database, executeInput, idempotencyKey, now());
        const observation = await executeIntent(input, executeInput, idempotencyKey, now);
        const update = await input.meetingIntelligence.observe({
          workspace: executeInput.workspace,
          observations: [observation]
        });
        const result: ExecuteFollowUpResult = {
          observation,
          events:
            update.events.length > 0
              ? update.events
              : receiptEventsFromObservation(observation),
          idempotencyKey
        };
        await completeExecution(input.database, result, now());
        return result;
      });
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

      const conclusion = await dependencies.meetingIntelligence.conclude({
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId
      });
      const participantProviderUserIds = await resolveProviderUserIds({
        identityDirectory: dependencies.identityDirectory,
        workspaceId: input.workspace.workspaceId,
        providerId:
          dependencies.knowledgeProvider.identityProviderId ??
          dependencies.knowledgeProvider.providerId,
        personIds: conclusion.participantBriefs.map((brief) => brief.participantId)
      });
      const reference = await dependencies.knowledgeProvider.createDocument({
        title: intent.title,
        contentMarkdown: renderMeetingRecord(intent.title, conclusion, intent.id),
        parentId: null,
        participantProviderUserIds,
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

      const assigneeProviderUserId = await resolveProviderUserId({
        identityDirectory: dependencies.identityDirectory,
        workspaceId: input.workspace.workspaceId,
        providerId:
          dependencies.workProvider.identityProviderId ??
          dependencies.workProvider.providerId,
        personId: intent.assigneeId
      });
      const mentionProviderUserIds = await resolveMentionProviderUserIds(
        dependencies.identityDirectory,
        input.workspace.workspaceId,
        dependencies.workProvider.identityProviderId ??
          dependencies.workProvider.providerId,
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

function renderMeetingRecord(
  title: string,
  conclusion: Awaited<ReturnType<MeetingIntelligence["conclude"]>>,
  intentId: string
): string {
  return [
    `# ${title}`,
    `## Summary\n\n${conclusion.summary.brief}`,
    conclusion.summary.detailed,
    renderMeetingRecordSection(
      "Decisions",
      conclusion.decisions.map(
        (decision) => `- **${decision.status}**: ${decision.statement}`
      )
    ),
    renderMeetingRecordSection(
      "Action Items",
      conclusion.actionItems.map((item) =>
        [
          `- **${item.status}**: ${item.description}`,
          item.ownerId ? `owner ${item.ownerId}` : "owner unconfirmed",
          item.dueDate ? `due ${item.dueDate}` : "due date unconfirmed"
        ].join("; ")
      )
    ),
    renderMeetingRecordSection(
      "Open Questions",
      conclusion.openQuestions.map(
        (question) => `- **${question.status}**: ${question.question}`
      )
    ),
    renderMeetingRecordSection(
      "Risks",
      conclusion.risks.map(
        (risk) =>
          `- **${risk.severity}**: ${risk.statement}${risk.mitigation ? `; mitigation: ${risk.mitigation}` : ""}`
      )
    ),
    `Generated from approved Luma Follow-up Intent \`${intentId}\` at Meeting Revision ${conclusion.revision}.`
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
}

function renderMeetingRecordSection(title: string, lines: string[]): string {
  return lines.length > 0 ? `## ${title}\n\n${lines.join("\n")}` : "";
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
  providerId: string,
  intent: Extract<FollowUpIntent, { type: "create-work-item" }>
): Promise<string[]> {
  const personIds = [intent.assigneeId, ...(intent.mentionPersonIds ?? [])].filter(
    (personId): personId is string => Boolean(personId)
  );
  return resolveProviderUserIds({
    identityDirectory,
    workspaceId,
    providerId,
    personIds
  });
}

type FollowUpExecutionRow = {
  result_json: string | null;
};

async function loadCompletedExecution(
  database: LumaDatabase,
  idempotencyKey: string
): Promise<ExecuteFollowUpResult | null> {
  const result = await database.query<FollowUpExecutionRow>(
    `SELECT result_json
       FROM follow_up_executions
      WHERE idempotency_key = $1 AND status = 'completed'
      LIMIT 1`,
    [idempotencyKey]
  );
  const resultJson = result.rows[0]?.result_json;

  if (!resultJson) {
    return null;
  }

  const completed = JSON.parse(resultJson) as ExecuteFollowUpResult;
  return completed.observation.outcome.status === "failed" ? null : completed;
}

async function reserveExecution(
  database: LumaDatabase,
  input: ExecuteFollowUpInput,
  idempotencyKey: string,
  now: Date
): Promise<void> {
  const timestamp = now.toISOString();
  await database.query(
    `INSERT INTO follow_up_executions (
       workspace_id, meeting_id, intent_id, operation, idempotency_key,
       status, attempts, result_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $5)
     ON CONFLICT (idempotency_key)
     DO UPDATE SET
       status = 'executing',
       attempts = follow_up_executions.attempts + 1,
       result_json = NULL,
       updated_at = EXCLUDED.updated_at`,
    [
      input.workspace.workspaceId,
      input.meetingId,
      input.intent.id,
      idempotencyKey,
      timestamp
    ]
  );
}

function receiptEventsFromObservation(
  observation: FollowUpExecutionRecorded
): MeetingIntelligenceEvent[] {
  switch (observation.outcome.status) {
    case "succeeded":
      return [
        {
          type: "follow-up-execution-succeeded",
          intentId: observation.intentId,
          externalReferences: observation.outcome.externalReferences,
          summary: observation.outcome.summary ?? "Follow-up succeeded."
        }
      ];
    case "partially-succeeded":
      return [
        {
          type: "follow-up-execution-partially-succeeded",
          intentId: observation.intentId,
          externalReferences: observation.outcome.externalReferences,
          message: observation.outcome.message
        }
      ];
    case "failed":
      return [
        {
          type: "follow-up-execution-failed",
          intentId: observation.intentId,
          message: observation.outcome.message,
          retryable: observation.outcome.retryable
        }
      ];
  }
}

async function completeExecution(
  database: LumaDatabase,
  result: ExecuteFollowUpResult,
  now: Date
): Promise<void> {
  await database.query(
    `UPDATE follow_up_executions
        SET status = 'completed', result_json = $2, updated_at = $3
      WHERE idempotency_key = $1`,
    [result.idempotencyKey, JSON.stringify(result), now.toISOString()]
  );
}

async function withExecutionLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}
