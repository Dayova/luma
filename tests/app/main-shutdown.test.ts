import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Exercise the actual entrypoint with a programmable server in a child process. */
async function shutdown(fail: boolean): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "luma-shutdown-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, "main.ts"),
      await readFile(new URL("../../src/app/main.ts", import.meta.url), "utf8")
    );
    await writeFile(
      join(directory, "server.js"),
      `export async function startServer() {
        setInterval(() => {}, 1000);
        setImmediate(() => console.log("ready"));
        return { async stop() {
          console.log("stopping");
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (${String(fail)}) throw new Error("private-provider-failure");
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
    let secondSignal = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!firstSignal && stdout.includes("ready")) {
        firstSignal = true;
        child.kill("SIGTERM");
      }
      if (!secondSignal && stdout.includes("stopping")) {
        secondSignal = true;
        child.kill("SIGINT");
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
  it("waits for the same successful close even when both stop signals arrive", async () => {
    const result = await shutdown(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("closed");
    expect(result.stdout.match(/stopping/gu)).toHaveLength(1);
  });

  it("reports failed close as exit 1 without exposing raw provider errors", async () => {
    const result = await shutdown(true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Luma shutdown failed");
    expect(result.stderr).not.toContain("private-provider-failure");
  });
});
