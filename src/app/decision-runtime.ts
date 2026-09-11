import { isAbsolute } from "node:path";
import { createConversationDecisionEvidenceSource } from "../decision-intelligence/conversation-evidence-source.js";
import { createImportedMeetingDecisionEvidenceSource } from "../decision-intelligence/imported-meeting-evidence-source.js";
import {
  LOGICAL_CAPTURE_DECISION_REVISION_PREFIX,
  type LogicalMeetingDecisionEvidenceSource
} from "../decision-intelligence/logical-meeting-evidence-source.js";
import {
  createDecisionStandingPolicy,
  type DecisionPermissionSourceAccess,
  type ManagedDecisionStandingPolicy
} from "../decision-intelligence/standing-permission.js";
import type { ImportedSourceHistoryAccess } from "../meeting-intelligence/imported-source-analysis.js";
import { createNotionDecisionAuthority } from "../decision-intelligence/notion-decision-authority.js";
import { createDecisionHumanReviewAccess } from "../decision-intelligence/human-review.js";
import {
  createOpenAIDecisionInterpreter,
  createOpenAIAutomaticDecisionDetector
} from "../decision-intelligence/openai-decision-interpreter.js";
import { createProcessedConversationSources } from "../context-intelligence/processed-conversation-source.js";
import {
  createNotionDecisionRecords,
  createNotionDecisionRecordCatalog,
  type NotionDecisionRecordsConfig
} from "../knowledge/notion-decision-records.js";
import { createDecisionRecallRuntime } from "../organizational-context/decision-recall-runtime.js";
import { createNotionReadOnlyKnowledgeCatalog } from "../knowledge/notion-read-only-knowledge-catalog.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";
import { dayovaFounderPersonIds } from "./founder-access.js";
import type { DecisionIntelligenceConfiguration } from "../decision-intelligence/decision-intelligence.js";
import type { ConversationEvidenceSource } from "../context-intelligence/conversation-evidence-source.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { AiUsageBudget } from "../ai/ai-usage-budget.js";
import type { AiRequestLimits } from "../ai/ai-request.js";

export type DecisionRuntimeConfig = {
  automatic?: boolean;
  dataSourceId: string;
  destinationCredentialScopeId: string;
  authorityPolicyPath: string;
  sharingPolicyPath: string;
  knowledgePageIds: string[];
  knowledgeCredentialScopeId: string;
};
/** Validate configuration before acquiring persistence or native transport resources. */
export function decisionRuntimeConfig(
  env: NodeJS.ProcessEnv,
  enabled: boolean
): DecisionRuntimeConfig | undefined {
  const automatic = env["LUMA_AUTOMATIC_DECISIONS_ENABLED"]?.trim();
  if (automatic && automatic !== "0" && automatic !== "1")
    throw new Error("LUMA_AUTOMATIC_DECISIONS_ENABLED must be 0 or 1");
  if (automatic === "1" && !enabled)
    throw new Error(
      "Automatic Decisions require the founder Decision Records configuration and review commands"
    );
  if (!enabled) return undefined;
  const dataSourceId = canonicalNotionObjectId(
    env["LUMA_DECISION_RECORDS_DATA_SOURCE_ID"] ?? ""
  );
  const authorityPolicyPath = env["LUMA_DECISION_AUTHORITY_POLICY_PATH"]?.trim();
  const sharingPolicyPath = env["LUMA_CONTEXT_SHARING_POLICY_PATH"]?.trim();
  const destinationCredentialScopeId =
    env["LUMA_DECISION_RECORDS_CREDENTIAL_SCOPE_ID"]?.trim();
  const knowledgeCredentialScopeId =
    env["LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID"]?.trim();
  const pages = (env["LUMA_CONTEXT_NOTION_PAGE_IDS"] ?? "")
    .split(",")
    .map((value) => canonicalNotionObjectId(value.trim()));
  if (
    !dataSourceId ||
    !authorityPolicyPath ||
    !isAbsolute(authorityPolicyPath) ||
    !sharingPolicyPath ||
    !isAbsolute(sharingPolicyPath) ||
    !destinationCredentialScopeId ||
    !knowledgeCredentialScopeId ||
    !pages.length ||
    pages.some((page) => !page) ||
    new Set(pages).size !== pages.length ||
    !env["LUMA_DECISION_RECORDS_NOTION_API_TOKEN"]?.trim() ||
    !env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"]?.trim() ||
    !env["OPENAI_API_KEY"]?.trim() ||
    Buffer.byteLength(env["LUMA_DECISION_RECORDS_SIGNING_KEY"] ?? "") < 32
  )
    throw new Error(
      "Decision Records require an exact Notion data source, protected source-backed authority/sharing policies, dedicated read-only knowledge scope, write credential scope, signing key and shared AI configuration."
    );
  return {
    ...(automatic === "1" ? { automatic: true } : {}),
    dataSourceId,
    destinationCredentialScopeId,
    authorityPolicyPath,
    sharingPolicyPath,
    knowledgeCredentialScopeId,
    knowledgePageIds: pages.filter((page): page is string => page !== null)
  };
}

/** Production factories at true provider seams; no caller-selected execution stages. */
export type DecisionRuntimeDependencies = {
  createKnowledge?: typeof createNotionReadOnlyKnowledgeCatalog;
  createRecords?: typeof createNotionDecisionRecords;
  createRecordCatalog?: typeof createNotionDecisionRecordCatalog;
  createInterpreter?: typeof createOpenAIDecisionInterpreter;
  createDetector?: typeof createOpenAIAutomaticDecisionDetector;
};
export async function createDecisionRuntime(
  input: {
    config: DecisionRuntimeConfig;
    env: NodeJS.ProcessEnv;
    workspaceId: string;
    database: LumaDatabase;
    ledger: ObservedSourceLedger;
    conversationEvidenceSource: ConversationEvidenceSource;
    importedSourceAccess?: ImportedSourceHistoryAccess;
    logicalMeetingEvidenceSource?: LogicalMeetingDecisionEvidenceSource;
    standingPermissionSourceAccess?: DecisionPermissionSourceAccess;
    accessPolicy: WorkspaceAccessPolicy;
    budget: AiUsageBudget;
    limits: AiRequestLimits;
    model: string;
  },
  dependencies: DecisionRuntimeDependencies = {}
): Promise<
  DecisionIntelligenceConfiguration & {
    recall: Awaited<ReturnType<typeof createDecisionRecallRuntime>>;
    standingPolicy?: ManagedDecisionStandingPolicy;
  }
> {
  const { workspaceId } = input;
  const audience: DecisionIntelligenceConfiguration["audience"] = (
    requestedWorkspaceId
  ) =>
    Promise.resolve(
      requestedWorkspaceId === workspaceId
        ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
        : null
    );
  const config = structuredClone(input.config);
  const env = { ...input.env };
  const policy = createContextSharingPolicy({
    path: config.sharingPolicyPath,
    workspaceId
  });
  await policy.validate();
  const knowledge = (
    dependencies.createKnowledge ?? createNotionReadOnlyKnowledgeCatalog
  )({
    workspaceId,
    credentialScopeId: config.knowledgeCredentialScopeId,
    pageIds: config.knowledgePageIds,
    readOnlyApiToken: env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"]!,
    authorize: (request) =>
      policy.authorize({
        audience: request.audience,
        provider: "notion",
        credentialScopeId: request.credentialScopeId,
        resource: request.source.provider === "notion" ? request.source.pageId : ""
      })
  });
  const authority = createNotionDecisionAuthority({
    database: input.database,
    workspaceId,
    policyPath: config.authorityPolicyPath,
    knowledge,
    recipientPersonIds: dayovaFounderPersonIds
  });
  const evidenceSource = createConversationDecisionEvidenceSource({
    workspaceId,
    conversationEvidenceSource: input.conversationEvidenceSource,
    ledger: input.ledger,
    accessPolicy: input.accessPolicy,
    processedSources: createProcessedConversationSources({
      database: input.database,
      ledger: input.ledger
    }),
    recipientPersonIds: dayovaFounderPersonIds
  });
  const importedMeetingEvidenceSource = input.importedSourceAccess
    ? createImportedMeetingDecisionEvidenceSource({
        database: input.database,
        ledger: input.ledger,
        sourceAccess: input.importedSourceAccess
      })
    : undefined;
  const logical = input.logicalMeetingEvidenceSource;
  const meetingEvidenceSource =
    importedMeetingEvidenceSource || logical
      ? {
          async capture(request: Parameters<typeof evidenceSource.capture>[0]) {
            // An imported request keeps its original identity. Only an actual
            // LogicalMeeting ID can select the capture-backed source capability.
            if (
              logical &&
              request.subject.type === "meeting" &&
              (await logical.resolveMeeting({
                workspaceId,
                meetingId: request.subject.meetingId,
                audience: request.audience
              })) === request.subject.meetingId
            )
              return logical.capture(request);
            if (!importedMeetingEvidenceSource)
              throw new Error("The Decision Meeting source is unavailable");
            return importedMeetingEvidenceSource.capture(request);
          },
          async captureProcessed(
            request: Parameters<typeof evidenceSource.captureProcessed>[0]
          ) {
            if (
              logical &&
              request.subject.type === "meeting" &&
              (await logical.resolveMeeting({
                workspaceId,
                meetingId: request.subject.meetingId,
                audience: request.audience
              })) === request.subject.meetingId
            )
              return logical.captureProcessed(request);
            if (!importedMeetingEvidenceSource)
              throw new Error("The processed Decision Meeting source is unavailable");
            return importedMeetingEvidenceSource.captureProcessed(request);
          },
          requireCurrent(source: Parameters<typeof evidenceSource.requireCurrent>[0]) {
            const provider = source.revision.startsWith(
              LOGICAL_CAPTURE_DECISION_REVISION_PREFIX
            )
              ? logical
              : importedMeetingEvidenceSource;
            if (!provider)
              return Promise.reject(new Error("The Decision source is unavailable"));
            return provider.requireCurrent(source);
          },
          authorizeRetained(
            request: Parameters<typeof evidenceSource.authorizeRetained>[0]
          ) {
            const provider = request.source.revision.startsWith(
              LOGICAL_CAPTURE_DECISION_REVISION_PREFIX
            )
              ? logical
              : importedMeetingEvidenceSource;
            return provider?.authorizeRetained(request) ?? Promise.resolve(false);
          }
        }
      : undefined;
  const humanReviewAccess = createDecisionHumanReviewAccess({
    database: input.database,
    accessPolicy: input.accessPolicy,
    audience
  });
  // A provider deadline can cancel the caller before a source port has finished
  // its own ledger reads. Retain those owned promises until the store may close.
  const retainedProofs = new Set<Promise<boolean>>();
  const retained = (signal: AbortSignal | undefined, work: () => Promise<boolean>) => {
    const pending = (async () => {
      if (signal?.aborted) return false;
      const allowed = await work();
      return !signal?.aborted && allowed;
    })().finally(() => retainedProofs.delete(pending));
    retainedProofs.add(pending);
    return pending;
  };
  const recordPolicy: Omit<NotionDecisionRecordsConfig, "token" | "transport"> = {
    workspaceId,
    dataSourceId: config.dataSourceId,
    signingKey: env["LUMA_DECISION_RECORDS_SIGNING_KEY"]!,
    authorize: ({ audience, dataSourceId }) =>
      policy.authorize({
        audience,
        provider: "notion",
        credentialScopeId: config.destinationCredentialScopeId,
        resource: dataSourceId
      }),
    authorizeRetainedSource: (request) =>
      retained(request.signal, () =>
        request.source.subject.type === "meeting"
          ? (meetingEvidenceSource?.authorizeRetained(request) ?? Promise.resolve(false))
          : evidenceSource.authorizeRetained(request)
      ),
    authorizeRetainedAuthority: (request) =>
      retained(request.signal, () => authority.authorizeRetainedAuthority(request)),
    authorizeRetainedHumanReview: (request) =>
      retained(request.signal, () =>
        humanReviewAccess.authorizeRetainedHumanReview(request)
      )
  };
  const records = (dependencies.createRecords ?? createNotionDecisionRecords)({
    ...recordPolicy,
    token: env["LUMA_DECISION_RECORDS_NOTION_API_TOKEN"]!
  });
  const catalog = (dependencies.createRecordCatalog ?? createNotionDecisionRecordCatalog)(
    {
      ...recordPolicy,
      readOnlyApiToken: env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"]!,
      authorize: ({ audience, dataSourceId }) =>
        policy.authorize({
          audience,
          provider: "notion",
          credentialScopeId: config.knowledgeCredentialScopeId,
          resource: dataSourceId
        })
    }
  );
  const recall = await createDecisionRecallRuntime({
    database: input.database,
    workspaceId,
    catalogId: "canonical-decisions",
    records: catalog,
    audience: () => audience(workspaceId)
  });
  const standingPolicy =
    config.automatic && input.standingPermissionSourceAccess
      ? await createDecisionStandingPolicy({
          database: input.database,
          workspaceId,
          audience: { workspaceId, personIds: [...dayovaFounderPersonIds] },
          accessPolicy: input.accessPolicy,
          authority,
          sourceAccess: input.standingPermissionSourceAccess
        })
      : undefined;
  const beforeInvoke: NonNullable<
    Parameters<typeof createOpenAIDecisionInterpreter>[0]["beforeInvoke"]
  > = async (request, signal) => {
    const allowed = await retained(signal, async () => {
      const source = request.source;
      if (source.subject.type === "meeting") {
        if (!meetingEvidenceSource)
          throw new Error("Imported Decision source is not configured");
        await meetingEvidenceSource.requireCurrent(source);
      } else await evidenceSource.requireCurrent(source);
      if (signal.aborted) return false;
      if (request.authority)
        await authority.requireCurrent({
          audience: source.audience,
          snapshot: request.authority
        });
      if (signal.aborted) return false;
      // Every retained record sent to the model carries its own source and Human
      // review proof. The current request's permission cannot stand in for them.
      if (request.catalog)
        await records.requireCurrent({
          audience: source.audience,
          snapshot: request.catalog
        });
      return (
        !signal.aborted &&
        (await policy.authorize({
          audience: source.audience,
          provider: "notion",
          credentialScopeId: config.destinationCredentialScopeId,
          resource: config.dataSourceId
        }))
      );
    });
    if (!allowed)
      throw new Error(
        "Current Decision source disclosure could not be verified before AI dispatch"
      );
  };
  return {
    ...(config.automatic
      ? {
          automatic: {
            ...(standingPolicy ? { policy: standingPolicy } : {}),
            evidenceSource: {
              captureProcessed: (
                request: Parameters<typeof evidenceSource.captureProcessed>[0]
              ) =>
                request.subject.type === "meeting"
                  ? (meetingEvidenceSource?.captureProcessed(request) ??
                    Promise.reject(
                      new Error("Imported Decision source is not configured")
                    ))
                  : evidenceSource.captureProcessed(request),
              requireCurrent: (
                source: Parameters<typeof evidenceSource.requireCurrent>[0]
              ) =>
                source.subject.type === "meeting"
                  ? (meetingEvidenceSource?.requireCurrent(source) ??
                    Promise.reject(
                      new Error("Imported Decision source is not configured")
                    ))
                  : evidenceSource.requireCurrent(source)
            },
            detector: (
              dependencies.createDetector ?? createOpenAIAutomaticDecisionDetector
            )({
              apiKey: env["OPENAI_API_KEY"]!,
              model: input.model,
              budget: input.budget,
              limits: input.limits,
              beforeInvoke
            })
          }
        }
      : {}),
    recall: {
      ...recall,
      async stop() {
        await recall.stop();
        await Promise.allSettled([...retainedProofs]);
      }
    },
    authority,
    ...(standingPolicy ? { standingPolicy } : {}),
    records,
    evidenceSource,
    ...(meetingEvidenceSource ? { meetingEvidenceSource } : {}),
    accessPolicy: input.accessPolicy,
    audience,
    interpreter: (dependencies.createInterpreter ?? createOpenAIDecisionInterpreter)({
      apiKey: env["OPENAI_API_KEY"]!,
      model: input.model,
      budget: input.budget,
      limits: input.limits,
      beforeInvoke
    })
  };
}
