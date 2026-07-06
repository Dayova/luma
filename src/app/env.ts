import { defaultAppConfig, type AppConfig } from "./config.js";

export function loadAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ...defaultAppConfig,
    nodeEnv:
      env["NODE_ENV"] === "production"
        ? "production"
        : env["NODE_ENV"] === "test"
          ? "test"
          : "development",
    defaultWorkspaceTimezone:
      env["LUMA_DEFAULT_WORKSPACE_TIMEZONE"] ?? defaultAppConfig.defaultWorkspaceTimezone
  };
}
