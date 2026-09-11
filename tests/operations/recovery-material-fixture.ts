import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function recoveryMaterialFixture(root: string) {
  const productionEnvPath = join(root, "production.env"),
    keyPath = join(root, "credential.key"),
    authorityPath = join(root, "authority.json"),
    sharingPath = join(root, "sharing.json"),
    structuredPath = join(root, "structured-targets.json"),
    key = randomBytes(32),
    authenticationSecret = randomBytes(48);
  const environment =
    [
      "NODE_ENV=production",
      "LUMA_WORKSPACE_ID=dayova",
      "LUMA_GRANOLA_OAUTH_ENABLED=0",
      `LUMA_GRANOLA_CREDENTIAL_KEY_PATH=${keyPath}`,
      `LUMA_CONTEXT_SHARING_POLICY_PATH=${sharingPath}`,
      `LUMA_DECISION_AUTHORITY_POLICY_PATH=${authorityPath}`,
      `LUMA_STRUCTURED_WORK_TARGETS_PATH=${structuredPath}`,
      `LUMA_STRUCTURED_WORK_SIGNING_KEY=${"structured-secret-".repeat(4)}`,
      `LUMA_DECISION_RECORDS_SIGNING_KEY=${"decision-secret-".repeat(4)}`,
      `LUMA_SYNTHESIS_SIGNING_KEY=${"synthesis-secret-".repeat(4)}`,
      "DISCORD_TOKEN=private-bot-token",
      "OPENAI_API_KEY=private-ai-token"
    ].join("\n") + "\n";
  await writeFile(productionEnvPath, environment, { mode: 0o600 });
  await writeFile(keyPath, key, { mode: 0o600 });
  await writeFile(
    authorityPath,
    JSON.stringify({ schemaVersion: 1, workspaceId: "dayova", grants: [] }),
    { mode: 0o600 }
  );
  await writeFile(
    sharingPath,
    JSON.stringify({ version: 1, workspaceId: "dayova", grants: [] }),
    { mode: 0o600 }
  );
  await writeFile(
    structuredPath,
    JSON.stringify({ version: 1, workspaceId: "dayova", targets: [] }),
    { mode: 0o600 }
  );
  return {
    productionEnvPath,
    keyPath,
    authorityPath,
    sharingPath,
    structuredPath,
    key,
    authenticationSecret,
    environment
  };
}
