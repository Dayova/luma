import { loadAppConfigFromEnv } from "./env.js";

export function startServer(): void {
  const config = loadAppConfigFromEnv();
  console.log(`Luma booted in ${config.nodeEnv} mode`);
}
