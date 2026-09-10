import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runAiAccountingMaintenance } from "../../src/app/ai-accounting-maintenance.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";

const host = vi.hoisted(() => ({ policyPath: "", policy: "" }));
// The test runner is not root. Model the root-owned file/identity boundary;
// input permissions, output creation, datastore, transactions and owner lease are real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      if (args[0] !== host.policyPath) {
        const file = await original.open(...args);
        const stat = file.stat.bind(file);
        Object.defineProperty(file, "stat", {
          value: async () => Object.assign(await stat(), { uid: 0 })
        });
        return file;
      }
      return {
        stat: () =>
          Promise.resolve({
            isFile: () => true,
            uid: 0,
            nlink: 1,
            mode: 0o600,
            size: host.policy.length
          }),
        readFile: () => Promise.resolve(host.policy),
        close: () => Promise.resolve()
      };
    }
  };
});

it("completes inspect, prepare, reviewed apply and idempotent retry using only private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "luma-accounting-command-"));
  const store = join(root, "store");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no network during accounting maintenance"));
  const originalGeteuid = process.geteuid;
  process.geteuid = () => 0;
  vi.stubEnv("SUDO_UID", "1001");
  host.policyPath = join(root, "root-policy.json");
  host.policy = JSON.stringify({
    operators: [{ localUid: 1001, personId: "person_jakob" }]
  });
  let database = await createPgliteDatabase(store);
  try {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve({
      workspaceId: "dayova",
      workflowId: "interrupted",
      capability: "context-ask",
      model: "gpt-5.6-luna",
      inputTokenUpperBound: 1000,
      maxOutputTokens: 200
    });
    await budget.markUnknown(reservationId);
    await database.close();
    async function command(name: string, input: unknown, suffix: string) {
      const inputPath = join(root, `${suffix}-input.json`);
      const outputPath = join(root, `${suffix}-output.json`);
      await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
      await runAiAccountingMaintenance([
        name,
        store,
        host.policyPath,
        inputPath,
        outputPath
      ]);
      return JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    }
    const report = (await command("inspect", { workspaceId: "dayova" }, "inspect")) as {
      requests: { requestDigest: string }[];
    };
    const prepared = (await command(
      "prepare",
      {
        kind: "charge",
        workspaceId: "dayova",
        reservationId,
        expectedRequestDigest: report.requests[0]?.requestDigest,
        verifiedAmountUsd: "0.02",
        reason: "Private billing review with an identified receipt.",
        evidence: {
          kind: "provider-billing",
          reference: "private-invoice-reference",
          sha256: "a".repeat(64)
        }
      },
      "prepare"
    )) as { preparationId: string; digest: string };
    const approval = {
      preparationId: prepared.preparationId,
      digest: prepared.digest,
      reviewed: true
    };
    const applied = await command("apply", approval, "apply");
    expect(applied).toMatchObject({
      operator: { localUid: 1001, personId: "person_jakob" }
    });
    expect(await command("apply", approval, "retry")).toEqual(applied);
    await expect(
      runAiAccountingMaintenance([
        "apply",
        store,
        host.policyPath,
        join(root, "apply-input.json"),
        join(root, "apply-output.json")
      ])
    ).rejects.toThrow();
    database = await createPgliteDatabase(store);
    expect(await createAiUsageBudget({ database }).getStatus("dayova")).toMatchObject({
      spentUsd: 0.02,
      unknownUsd: 0,
      requestCount: 1
    });
    expect(network).not.toHaveBeenCalled();
    expect(stdout.mock.calls.flat().join(" ")).not.toContain("private-invoice-reference");
    expect(stdout.mock.calls.flat().join(" ")).not.toContain("Private billing review");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
    stdout.mockRestore();
    network.mockRestore();
    if (originalGeteuid) process.geteuid = originalGeteuid;
    else delete process.geteuid;
    vi.unstubAllEnvs();
  }
}, 30_000);
