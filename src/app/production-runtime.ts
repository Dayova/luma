import { organizationalContextRuntimeConfig } from "./organizational-context-runtime.js";
import { notionWebhookRuntimeConfig } from "./notion-webhook-runtime.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { aiRequestLimitsFromEnv } from "../ai/ai-request.js";
import { aiUsageBudgetSettingsFromEnv, isAiModelPriced } from "../ai/ai-usage-budget.js";
import { openAIReasoningModelNameFromEnv } from "../ai/openai-model-config.js";
import { discordAllowedParentChannelIdsFromEnv } from "../discord/discord-channel-scope.js";
import { discordContextAskConfigFromEnv } from "../discord/discord-context-ask-runtime.js";
import { discordConsultationConfigFromEnv } from "../discord/discord-consultation-runtime.js";
import { createWorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "./founder-access.js";

const developmentDiscordApplicationId = "1526147284822392952";

export class ProductionPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionPreflightError";
  }
}

/** One literal KEY=value subset shared by systemd EnvironmentFile and Node. */
export function parseProductionEnvironmentFile(content: string): NodeJS.ProcessEnv {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const assignment = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    const key = assignment?.[1];
    const value = assignment?.[2];
    check(
      Boolean(key) &&
        value !== undefined &&
        !/\s/u.test(value) &&
        ![...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ) &&
        !["'", '"', "\\", "#", "$", "`"].some((character) => value.includes(character)),
      "Use literal unquoted KEY=value lines without whitespace, control characters, escapes, interpolation, or inline comments."
    );
    check(!keys.has(key ?? ""), "The production environment must not repeat a key.");
    keys.add(key ?? "");
  }
  return parseEnv(content);
}

/** Validates deployment configuration without opening a store or calling a provider. */
export async function validateProductionEnvironment(
  env: NodeJS.ProcessEnv,
  releaseDirectory: string
): Promise<void> {
  check(env["NODE_ENV"] === "production", "NODE_ENV must be production.");
  const dataDirectory = required(env, "LUMA_PGLITE_DATA_DIR");
  check(isAbsolute(dataDirectory), "The production data directory must be absolute.");
  const canonicalDirectory = resolve(dataDirectory);
  check(
    canonicalDirectory !== sep &&
      !isWithin(canonicalDirectory, releaseDirectory) &&
      !["/tmp", "/var/tmp", "/run", "/dev", "/proc", "/sys"].some((parent) =>
        isWithin(canonicalDirectory, parent)
      ),
    "The production data directory must be durable and outside the release directory."
  );
  for (const key of ["DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"] as const) {
    check(/^\d{17,20}$/u.test(required(env, key)), `${key} must be a Discord ID.`);
  }
  check(
    env["DISCORD_CLIENT_ID"] !== developmentDiscordApplicationId,
    "The development Discord application cannot run in production."
  );
  required(env, "DISCORD_TOKEN");
  required(env, "OPENAI_API_KEY");
  check(
    (env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() || "openai") === "openai",
    "Production requires the configured OpenAI capability."
  );
  // The separate observer cannot share this process's credentials or budget store.
  check(
    !Object.entries(env).some(
      ([key, value]) =>
        Boolean(value?.trim()) &&
        (key.startsWith("LUMA_NOTION_OBSERVATION_") ||
          key.startsWith("LUMA_NATIVE_") ||
          key === "LUMA_OBSERVATION_WORKSPACE_ID")
    ),
    "Observer and native-review configuration must remain outside this deployment."
  );

  try {
    const parents = discordAllowedParentChannelIdsFromEnv(env);
    check(parents.length > 0, "Production requires an explicit Discord channel scope.");
    const context = discordContextAskConfigFromEnv(env);
    check(
      !context?.parentChannelIds.some((id) => !parents.includes(id)),
      "Context Ask parents must be within the configured Discord channel scope."
    );
    const consultation = discordConsultationConfigFromEnv(env);
    check(
      !consultation?.capture.parentChannelIds.some((id) => !parents.includes(id)),
      "Consultation parents must be within the configured Discord channel scope."
    );
    const workspaceId = required(env, "LUMA_WORKSPACE_ID");
    const access = createWorkspaceAccessPolicy({
      workspaceId,
      identityDirectory: createIdentityDirectoryFromEnv(env),
      authorizedPersonIds: dayovaFounderPersonIds
    });
    for (const providerUserId of context?.allowedDiscordUserIds ?? []) {
      check(
        Boolean(
          await access.authorize({ workspaceId, providerId: "discord", providerUserId })
        ),
        "Context Ask users must each uniquely identify an authorized founder."
      );
    }
    if (consultation) {
      const admitted = [];
      for (const providerUserId of consultation.capture.allowedDiscordUserIds) {
        const person = await access.authorize({
          workspaceId,
          providerId: "discord",
          providerUserId
        });
        if (person) admitted.push(person.personId);
      }
      check(
        admitted.length === consultation.capture.allowedDiscordUserIds.length &&
          JSON.stringify([...admitted].sort()) ===
            JSON.stringify([...dayovaFounderPersonIds].sort()),
        "Consultations require the exact four uniquely mapped founders."
      );
    }
    const budget = aiUsageBudgetSettingsFromEnv(env);
    check(
      budget.monthlyLimitUsd >= 0 && budget.monthlyLimitUsd <= 30,
      "The production monthly AI limit must be from USD 0 through the approved USD 30 cap."
    );
    check(
      budget.timezone === "Europe/Berlin",
      "The production AI budget must use Europe/Berlin."
    );
    check(
      isAiModelPriced(openAIReasoningModelNameFromEnv(env)),
      "The selected production model needs an audited price entry."
    );
    aiRequestLimitsFromEnv(env);
    const organizational = organizationalContextRuntimeConfig(env);
    if (notionWebhookRuntimeConfig(env, workspaceId)) {
      required(env, "NOTION_API_TOKEN");
      check(
        organizational?.providers.includes("notion") === true,
        "Notion webhook intake requires granted imported-source analysis configuration."
      );
    }
  } catch (error) {
    if (error instanceof ProductionPreflightError) throw error;
    // Adapter configuration errors may include supplied values. Never print them.
    throw new ProductionPreflightError(
      "Production channel, identity, model, budget, or organizational context configuration is invalid."
    );
  }
}

/** Read-only startup proof, before Discord command registration or Gateway login. */
export async function verifyProductionDiscordApplication(
  env: NodeJS.ProcessEnv,
  fetchApplication: typeof fetch = fetch
): Promise<void> {
  try {
    const response = await fetchApplication(
      "https://discord.com/api/v10/oauth2/applications/@me",
      {
        headers: { Authorization: `Bot ${required(env, "DISCORD_TOKEN")}` },
        signal: AbortSignal.timeout(15_000)
      }
    );
    check(response.ok, "Production Discord credentials could not be verified.");
    const application = z
      .object({ id: z.string(), flags: z.number().int().nonnegative() })
      .parse(await response.json());
    check(
      application.id === env["DISCORD_CLIENT_ID"] &&
        application.id !== developmentDiscordApplicationId,
      "Discord credentials must belong to the configured production application."
    );
    // Discord application flags, not the Gateway identify intent bitfield.
    // https://docs.discord.com/developers/resources/application#application-flags
    check(
      (application.flags & ((1 << 14) | (1 << 15))) !== 0,
      "Enable Server Members intent for the production application so Luma can verify channel readers, even when Context Ask is disabled."
    );
    if (discordContextAskConfigFromEnv(env) || discordConsultationConfigFromEnv(env)) {
      check(
        (application.flags & ((1 << 18) | (1 << 19))) !== 0,
        "Enable Message Content intent for the production application before Context Ask or consultations."
      );
    }
  } catch (error) {
    if (error instanceof ProductionPreflightError) throw error;
    throw new ProductionPreflightError(
      "Production Discord application verification failed; no runtime was started."
    );
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  check(Boolean(value), `${key} is required for production.`);
  return value ?? "";
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProductionPreflightError(message);
}

function isWithin(directory: string, parent: string): boolean {
  const difference = relative(resolve(parent), directory);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}
