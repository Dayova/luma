import { isAbsolute } from "node:path";
import { createConversationDecisionEvidenceSource } from "../decision-intelligence/conversation-evidence-source.js";
import { createImportedMeetingDecisionEvidenceSource } from "../decision-intelligence/imported-meeting-evidence-source.js";
import type { ImportedSourceHistoryAccess } from "../meeting-intelligence/imported-source-analysis.js";
import { createNotionDecisionAuthority } from "../decision-intelligence/notion-decision-authority.js";
import { createOpenAIDecisionInterpreter } from "../decision-intelligence/openai-decision-interpreter.js";
import { createNotionDecisionRecords } from "../knowledge/notion-decision-records.js";
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
  createInterpreter?: typeof createOpenAIDecisionInterpreter;
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
    accessPolicy: WorkspaceAccessPolicy;
    budget: AiUsageBudget;
    limits: AiRequestLimits;
    model: string;
  },
  dependencies: DecisionRuntimeDependencies = {}
): Promise<DecisionIntelligenceConfiguration> {
  const { workspaceId } = input;
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
    recipientPersonIds: dayovaFounderPersonIds
  });
  const meetingEvidenceSource = input.importedSourceAccess
    ? createImportedMeetingDecisionEvidenceSource({
        database: input.database,
        ledger: input.ledger,
        sourceAccess: input.importedSourceAccess
      })
    : undefined;
  const records = (dependencies.createRecords ?? createNotionDecisionRecords)({
    workspaceId,
    dataSourceId: config.dataSourceId,
    token: env["LUMA_DECISION_RECORDS_NOTION_API_TOKEN"]!,
    signingKey: env["LUMA_DECISION_RECORDS_SIGNING_KEY"]!,
    authorize: ({ audience, dataSourceId }) =>
      policy.authorize({
        audience,
        provider: "notion",
        credentialScopeId: config.destinationCredentialScopeId,
        resource: dataSourceId
      }),
    authorizeRetainedSource: (request) =>
      request.source.subject.type === "meeting"
        ? (meetingEvidenceSource?.authorizeRetained(request) ?? Promise.resolve(false))
        : evidenceSource.authorizeRetained(request),
    authorizeRetainedAuthority: (request) => authority.authorizeRetainedAuthority(request)
  });
  return {
    authority,
    records,
    evidenceSource,
    ...(meetingEvidenceSource ? { meetingEvidenceSource } : {}),
    accessPolicy: input.accessPolicy,
    audience: (requestedWorkspaceId) =>
      Promise.resolve(
        requestedWorkspaceId === workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      ),
    interpreter: (dependencies.createInterpreter ?? createOpenAIDecisionInterpreter)({
      apiKey: env["OPENAI_API_KEY"]!,
      model: input.model,
      budget: input.budget,
      limits: input.limits
    })
  };
}
