import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Exercise the actual entrypoint with a programmable server in a child process. */
async function shutdown({
  failClose = false,
  startup = "ready",
  secondSignal = "SIGTERM"
}: {
  failClose?: boolean;
  startup?: "ready" | "cancel" | "delayed-ready" | "fail";
  secondSignal?: "SIGTERM" | "SIGINT";
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "luma-shutdown-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, "runtime-health.js"),
      "export function startRuntimeHealthReporter() { return () => Promise.resolve(); }"
    );
    await writeFile(
      join(directory, "main.ts"),
      await readFile(new URL("../../src/app/main.ts", import.meta.url), "utf8")
    );
    await writeFile(
      join(directory, "server.js"),
      `export class LumaStartupCancelledError extends Error {}
      export async function startServer(_env, _dependencies, signal) {
        setInterval(() => {}, 1000);
        const startup = ${JSON.stringify(startup)};
        if (startup === "cancel") {
          console.log("starting");
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          console.log("stopping");
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (${String(failClose)}) throw new Error("private-startup-cleanup-failure");
          console.log("closed");
          throw new LumaStartupCancelledError();
        }
        if (startup === "delayed-ready" || startup === "fail") {
          console.log("starting");
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (startup === "fail") {
            console.log("startup-cleanup");
            throw new Error("private-startup-failure");
          }
        } else {
          setImmediate(() => console.log("ready"));
        }
        return { async stop() {
          console.log("stopping");
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (${String(failClose)}) throw new Error("private-provider-failure");
          console.log("closed");
        }};
      }`
    );
    const child = spawn(process.execPath, [join(directory, "main.ts")], {
      env: { PATH: process.env["PATH"] },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let firstSignal = false;
    let secondSignalSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (
        startup !== "fail" &&
        !firstSignal &&
        (stdout.includes("ready") || stdout.includes("starting"))
      ) {
        firstSignal = true;
        child.kill("SIGTERM");
      }
      if (!secondSignalSent && stdout.includes("stopping")) {
        secondSignalSent = true;
        child.kill(secondSignal);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Shutdown child did not exit"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    return { code, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("executable shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "waits for one successful close when SIGTERM is followed by %s",
    async (secondSignal) => {
      const result = await shutdown({ secondSignal });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("closed");
      expect(result.stdout.match(/stopping/gu)).toHaveLength(1);
    }
  );

  it("reports failed close as exit 1 without exposing raw provider errors", async () => {
    const result = await shutdown({ failClose: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Luma shutdown failed");
    expect(result.stderr).not.toContain("private-provider-failure");
  });

  it("cancels stalled startup and waits for cleanup despite repeated SIGTERM", async () => {
    const result = await shutdown({ startup: "cancel" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("closed");
    expect(result.stdout.match(/stopping/gu)).toHaveLength(1);
    expect(result.stderr).toBe("");
  });

  it("does not report successful cancellation when startup cleanup fails", async () => {
    const result = await shutdown({ startup: "cancel", failClose: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Luma shutdown failed");
    expect(result.stderr).not.toContain("private-startup-cleanup-failure");
  });

  it("closes an app that finishes startup after the stop request", async () => {
    const result = await shutdown({ startup: "delayed-ready" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("closed");
    expect(result.stdout.match(/stopping/gu)).toHaveLength(1);
  });

  it("reports failed startup after its cleanup without exposing raw errors", async () => {
    const result = await shutdown({ startup: "fail" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("startup-cleanup");
    expect(result.stderr).toContain("Luma startup failed");
    expect(result.stderr).not.toContain("private-startup-failure");
  });
});
