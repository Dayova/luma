import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createNotionStructuredRecords,
  type NotionStructuredTarget
} from "../knowledge/notion-structured-records.js";
import { createStructuredWorkEvidenceSource } from "../structured-work/evidence-source.js";
import { createOpenAIStructuredWorkInterpreter } from "../structured-work/openai-structured-work-interpreter.js";
import { structuredFieldValueSchema } from "../structured-work/schemas.js";
import { operationDigest } from "../structured-work/persistence.js";
import type { StructuredWorkConfiguration } from "../structured-work/structured-work.js";
import type {
  StructuredWorkIntelligence,
  StructuredWorkExecution
} from "../structured-work/interface.js";
import type { ConversationEvidenceSource } from "../context-intelligence/conversation-evidence-source.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import type { ImportedSourceHistoryAccess } from "../meeting-intelligence/imported-source-analysis.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { IdentityDirectory } from "../identity/interface.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { WorkProvider } from "../work/interface.js";
import type { AiUsageBudget } from "../ai/ai-usage-budget.js";
import type { AiRequestLimits } from "../ai/ai-request.js";
import {
  discordStructuredWorkConfigFromEnv,
  type DiscordStructuredWorkRuntime
} from "../discord/discord-structured-work-runtime.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";
import { dayovaFounderPersonIds } from "./founder-access.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";

const short = z.string().trim().min(1).max(160);
const targetSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/u),
    label: short,
    dataSourceId: short.refine((id) => canonicalNotionObjectId(id) !== null),
    titleField: short,
    fields: z.record(
      short,
      z
        .object({
          property: short,
          type: z.enum(["text", "choice", "number", "boolean", "url", "date"]),
          required: z.boolean().optional()
        })
        .strict()
    ),
    defaults: z.record(short, structuredFieldValueSchema).optional(),
    sourceProperty: short.optional(),
    ownerProperty: short.optional(),
    workLinkProperty: short.optional(),
    active: z
      .object({ property: short, values: z.array(short).min(1).max(30) })
      .strict()
      .optional(),
    authorizedPersonIds: z.array(z.enum(dayovaFounderPersonIds)).min(1).max(4)
  })
  .strict();
const targetPolicySchema = z
  .object({
    version: z.literal(1),
    workspaceId: short,
    targets: z.array(targetSchema).min(1).max(10)
  })
  .strict();
export type StructuredWorkTargetPolicy = z.infer<typeof targetPolicySchema>;
export type StructuredWorkRuntimeConfig = {
  targetsPath: string;
  sharingPolicyPath: string;
  notionCredentialScopeId: string;
  linearCredentialScopeId: string;
  linearTeamId: string;
  discord: NonNullable<ReturnType<typeof discordStructuredWorkConfigFromEnv>>;
};
export function structuredWorkRuntimeConfig(
  env: NodeJS.ProcessEnv
): StructuredWorkRuntimeConfig | undefined {
  const discord = discordStructuredWorkConfigFromEnv(env);
  if (!discord) return undefined;
  const targetsPath = env["LUMA_STRUCTURED_WORK_TARGETS_PATH"]?.trim();
  const sharingPolicyPath = env["LUMA_CONTEXT_SHARING_POLICY_PATH"]?.trim();
  const notionCredentialScopeId =
    env["LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID"]?.trim();
  const linearCredentialScopeId =
    env["LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID"]?.trim();
  const linearTeamId = env["LINEAR_TEAM_ID"]?.trim();
  const parents = (env["LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim());
  if (
    !targetsPath ||
    !isAbsolute(targetsPath) ||
    !sharingPolicyPath ||
    !isAbsolute(sharingPolicyPath) ||
    !notionCredentialScopeId ||
    !linearCredentialScopeId ||
    !linearTeamId ||
    !env["LINEAR_API_KEY"]?.trim() ||
    !env["LUMA_STRUCTURED_WORK_NOTION_API_TOKEN"]?.trim() ||
    !env["OPENAI_API_KEY"]?.trim() ||
    Buffer.byteLength(env["LUMA_STRUCTURED_WORK_SIGNING_KEY"] ?? "") < 32 ||
    discord.parentChannelIds.some((id) => !parents.includes(id))
  )
    throw configurationError();
  return {
    targetsPath,
    sharingPolicyPath,
    notionCredentialScopeId,
    linearCredentialScopeId,
    linearTeamId,
    discord
  };
}
export async function readStructuredWorkTargetPolicy(
  path: string,
  workspaceId: string
): Promise<StructuredWorkTargetPolicy> {
  try {
    if (!isAbsolute(path)) throw configurationError();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 65536 ||
        (stat.mode & 0o022) !== 0 ||
        (stat.uid !== 0 && stat.uid !== process.geteuid?.())
      )
        throw configurationError();
      const policy = targetPolicySchema.parse(
        JSON.parse(await file.readFile("utf8")) as unknown
      );
      if (
        policy.workspaceId !== workspaceId ||
        new Set(policy.targets.map((t) => t.key)).size !== policy.targets.length ||
        new Set(policy.targets.map((t) => canonicalNotionObjectId(t.dataSourceId)))
          .size !== policy.targets.length
      )
        throw configurationError();
      for (const target of policy.targets) {
        if (
          new Set(target.authorizedPersonIds).size !==
            target.authorizedPersonIds.length ||
          Object.keys(target.fields).length > 30 ||
          !target.fields[target.titleField] ||
          target.fields[target.titleField]?.type !== "text"
        )
          throw configurationError();
        const properties = [
          ...Object.values(target.fields).map((f) => f.property),
          ...[
            target.sourceProperty,
            target.ownerProperty,
            target.workLinkProperty
          ].filter((p): p is string => !!p)
        ];
        if (
          new Set(properties).size !== properties.length ||
          Object.entries(target.defaults ?? {}).some(
            ([key, value]) =>
              !target.fields[key] || target.fields[key]?.type !== value.type
          )
        )
          throw configurationError();
      }
      return policy;
    } finally {
      await file.close();
    }
  } catch {
    throw configurationError();
  }
}
export async function validateStructuredWorkFounderScope(input: {
  config: StructuredWorkRuntimeConfig;
  workspaceId: string;
  identityDirectory: IdentityDirectory;
  accessPolicy: WorkspaceAccessPolicy;
}): Promise<void> {
  const founders = await input.identityDirectory.getPeople({
    workspaceId: input.workspaceId,
    personIds: [...dayovaFounderPersonIds]
  });
  const ids = founders.map((person) => person.discordUserId);
  if (
    founders.length !== 4 ||
    new Set(founders.map((p) => p.personId)).size !== 4 ||
    ids.some((id) => !id) ||
    new Set(ids).size !== 4 ||
    operationDigest([...ids].sort()) !==
      operationDigest([...input.config.discord.allowedDiscordUserIds].sort())
  )
    throw configurationError();
  for (const person of founders) {
    const actor = await input.accessPolicy.authorize({
      workspaceId: input.workspaceId,
      providerId: "discord",
      providerUserId: person.discordUserId!
    });
    if (actor?.personId !== person.personId) throw configurationError();
  }
}
export type StructuredWorkRuntimeDependencies = {
  createRecords?: typeof createNotionStructuredRecords;
  createInterpreter?: typeof createOpenAIStructuredWorkInterpreter;
};
/** Composition only: one store, source reader, WorkProvider and budget from the main runtime. */
export async function createStructuredWorkRuntime(
  input: {
    config: StructuredWorkRuntimeConfig;
    env: NodeJS.ProcessEnv;
    workspaceId: string;
    database: LumaDatabase;
    ledger: ObservedSourceLedger;
    conversationEvidenceSource: ConversationEvidenceSource;
    importedSourceAccess?: ImportedSourceHistoryAccess;
    identityDirectory: IdentityDirectory;
    accessPolicy: WorkspaceAccessPolicy;
    work: WorkProvider;
    budget: AiUsageBudget;
    limits: AiRequestLimits;
    model: string;
  },
  dependencies: StructuredWorkRuntimeDependencies = {}
): Promise<{
  configuration: StructuredWorkConfiguration;
  /** After bot drain, retain timed-out proof work until the shared store may close. */
  stop(): Promise<void>;
  discord(input: {
    meetingIntelligence: StructuredWorkIntelligence;
    execution: StructuredWorkExecution;
  }): DiscordStructuredWorkRuntime;
}> {
  const config = structuredClone(input.config),
    env = { ...input.env };
  let stopped = false;
  const proofs = new Set<Promise<unknown>>();
  function ownedProof<T>(work: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(new Error("Structured work runtime is stopped"));
    const pending = Promise.resolve()
      .then(work)
      .finally(() => proofs.delete(pending));
    proofs.add(pending);
    return pending;
  }
  await validateStructuredWorkFounderScope({ ...input, config });
  if (input.work.providerId !== "linear") throw configurationError();
  const targetPolicy = await readStructuredWorkTargetPolicy(
    config.targetsPath,
    input.workspaceId
  );
  const digest = operationDigest(targetPolicy);
  const targetPolicyCurrent = async () => {
    try {
      return (
        !stopped &&
        operationDigest(
          await readStructuredWorkTargetPolicy(config.targetsPath, input.workspaceId)
        ) === digest
      );
    } catch {
      return false;
    }
  };
  const sharing = createContextSharingPolicy({
    path: config.sharingPolicyPath,
    workspaceId: input.workspaceId
  });
  await sharing.validate();
  const targets: NotionStructuredTarget[] = targetPolicy.targets.map((target) => ({
    key: target.key,
    label: target.label,
    dataSourceId: target.dataSourceId,
    titleField: target.titleField,
    fields: Object.fromEntries(
      Object.entries(target.fields).map(([key, value]) => [
        key,
        {
          property: value.property,
          type: value.type,
          ...(value.required === undefined ? {} : { required: value.required })
        }
      ])
    ),
    ...(target.defaults ? { defaults: target.defaults } : {}),
    ...(target.sourceProperty ? { sourceProperty: target.sourceProperty } : {}),
    ...(target.ownerProperty ? { ownerProperty: target.ownerProperty } : {}),
    ...(target.workLinkProperty ? { workLinkProperty: target.workLinkProperty } : {}),
    ...(target.active ? { active: target.active } : {})
  }));
  const nativeRecords = (dependencies.createRecords ?? createNotionStructuredRecords)({
    apiToken: env["LUMA_STRUCTURED_WORK_NOTION_API_TOKEN"]!,
    signingKey: env["LUMA_STRUCTURED_WORK_SIGNING_KEY"]!,
    identityDirectory: input.identityDirectory,
    targets,
    authorize: async (request) =>
      !request.signal.aborted &&
      (await targetPolicyCurrent()) &&
      (await sharing.authorize({
        audience: request.audience,
        provider: "notion",
        credentialScopeId: config.notionCredentialScopeId,
        resource: request.dataSourceId
      })) &&
      !request.signal.aborted
  });
  const records = {
    ...nativeRecords,
    create: (request: Parameters<typeof nativeRecords.create>[0]) =>
      ownedProof(() =>
        nativeRecords.create({
          ...request,
          requireCurrent: () => ownedProof(request.requireCurrent)
        })
      )
  };
  const nativeInterpreter = (
    dependencies.createInterpreter ?? createOpenAIStructuredWorkInterpreter
  )({
    apiKey: env["OPENAI_API_KEY"]!,
    budget: input.budget,
    limits: input.limits,
    model: input.model
  });
  const nativeSource = createStructuredWorkEvidenceSource({
    conversation: {
      workspaceId: input.workspaceId,
      ledger: input.ledger,
      conversationEvidenceSource: input.conversationEvidenceSource,
      accessPolicy: input.accessPolicy,
      recipientPersonIds: dayovaFounderPersonIds
    },
    ...(input.importedSourceAccess
      ? {
          importedMeetings: {
            database: input.database,
            ledger: input.ledger,
            sourceAccess: input.importedSourceAccess
          }
        }
      : {})
  });
  const configuration: StructuredWorkConfiguration = {
    evidenceSource: {
      capture: (request) => ownedProof(() => nativeSource.capture(request)),
      requireCurrent: (source) => ownedProof(() => nativeSource.requireCurrent(source))
    },
    interpreter: {
      interpret: (request, access) =>
        ownedProof(() =>
          nativeInterpreter.interpret(request, {
            requireCurrent: () => ownedProof(access.requireCurrent)
          })
        )
    },
    records,
    work: input.work,
    identityDirectory: input.identityDirectory,
    accessPolicy: input.accessPolicy,
    workAuthorization: {
      scopeId: config.linearCredentialScopeId,
      resource: config.linearTeamId,
      authorize: async (audience) =>
        (await targetPolicyCurrent()) &&
        (await sharing.authorize({
          audience,
          provider: "linear",
          credentialScopeId: config.linearCredentialScopeId,
          resource: config.linearTeamId
        }))
    },
    audience: (workspaceId) =>
      Promise.resolve(
        !stopped && workspaceId === input.workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      ),
    targets: targetPolicy.targets.map(({ key, authorizedPersonIds }) => ({
      key,
      authorizedPersonIds
    }))
  };
  return {
    configuration,
    async stop() {
      stopped = true;
      while (proofs.size) await Promise.allSettled([...proofs]);
    },
    discord: ({ meetingIntelligence, execution }) => ({
      config: structuredClone(config.discord),
      targetKeys: targets.map((target) => target.key),
      targets: targets.map(({ key, label }) => ({ key, label })),
      source: input.conversationEvidenceSource,
      meetingIntelligence,
      execution
    })
  };
}
function configurationError(): Error {
  return new Error(
    "Structured work requires protected exact target mappings, founder scope, Notion/Linear sharing grants, dedicated credentials and the shared AI budget configuration."
  );
}
