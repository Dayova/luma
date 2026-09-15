import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the process alive when an abandoned Gateway handshake times out", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/gateway-handshake.cjs", import.meta.url))],
    { timeout: 5000 }
  );
  expect(result.stdout.trim()).toBe("retired-handshake-closed");
});
