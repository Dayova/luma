import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const runtimeHealthSchema = z
  .object({
    format: z.literal("luma-runtime-health-v1"),
    pid: z.number().int().positive(),
    checkedAt: z.string().datetime(),
    gatewayConnected: z.boolean()
  })
  .strict();

/** Private local liveness receipt, containing no source data or credentials. */
export async function publishRuntimeHealth(
  path: string,
  gatewayConnected: boolean,
  now = new Date()
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Runtime health path must be absolute");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        runtimeHealthSchema.parse({
          format: "luma-runtime-health-v1",
          pid: process.pid,
          checkedAt: now.toISOString(),
          gatewayConnected
        })
      ) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function startRuntimeHealthReporter(input: {
  path: string;
  gatewayConnected(): boolean;
}): () => Promise<void> {
  let stopped = false;
  let pending = Promise.resolve();
  function publish() {
    pending = pending.then(async () => {
      if (stopped) return;
      try {
        await publishRuntimeHealth(input.path, input.gatewayConnected());
      } catch {
        // The independent monitor detects missing/stale receipts. Do not leak paths.
        console.error("Luma could not publish its local health receipt.");
      }
    });
  }
  publish();
  const timer = setInterval(publish, 15_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    await publishRuntimeHealth(input.path, false);
  };
}
