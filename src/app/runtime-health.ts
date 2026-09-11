import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const runtimeCapabilityProblemSchema = z.enum([
  "ai-budget-near-limit",
  "ai-budget-exhausted",
  "ai-unavailable",
  "source-ingestion-degraded",
  "decision-recall-degraded",
  "automatic-decisions-need-attention",
  "capability-status-unavailable"
]);
export type RuntimeCapabilityProblem = z.infer<typeof runtimeCapabilityProblemSchema>;

export const runtimeHealthSchema = z
  .object({
    format: z.literal("luma-runtime-health-v1"),
    pid: z.number().int().positive(),
    checkedAt: z.string().datetime(),
    gatewayConnected: z.boolean(),
    capabilityProblems: z.array(runtimeCapabilityProblemSchema).max(7).optional()
  })
  .strict();

/** Private local liveness receipt, containing no source data or credentials. */
export async function publishRuntimeHealth(
  path: string,
  gatewayConnected: boolean,
  now = new Date(),
  capabilityProblems?: RuntimeCapabilityProblem[]
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
          gatewayConnected,
          ...(capabilityProblems
            ? { capabilityProblems: [...new Set(capabilityProblems)].sort() }
            : {})
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
  capabilityProblems?(): Promise<RuntimeCapabilityProblem[]>;
}): () => Promise<void> {
  let stopped = false;
  let pending = Promise.resolve();
  function publish() {
    pending = pending.then(async () => {
      if (stopped) return;
      try {
        let problems: RuntimeCapabilityProblem[] | undefined;
        try {
          problems = await input.capabilityProblems?.();
        } catch {
          problems = ["capability-status-unavailable"];
        }
        if (!stopped)
          await publishRuntimeHealth(
            input.path,
            input.gatewayConnected(),
            new Date(),
            problems
          );
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
