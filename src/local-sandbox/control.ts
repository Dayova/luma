import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const directory = join(homedir(), ".luma", "local-services");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const services = [
  { name: "offline", main: "main.js", port: 58099 },
  { name: "ai", main: "live-main.js", port: 59383 }
];
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !["up", "down", "status"].includes(command ?? ""))
    throw new Error("Use pnpm local:up, pnpm local:down, or pnpm local:status.");
  if (process.platform !== "darwin" || !process.getuid)
    throw new Error(
      "Background control currently supports macOS. Elsewhere, keep pnpm local or pnpm local:ai running in a terminal."
    );
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const domain = `gui/${process.getuid()}`;
  for (const service of services) {
    const label = `com.dayova.luma.local-${service.name}`;
    const target = `${domain}/${label}`;
    const loaded = await exec("/bin/launchctl", ["print", target]).then(
      () => true,
      () => false
    );
    if (command === "down") {
      if (loaded) {
        await exec("/bin/launchctl", ["bootout", target]);
        // bootout may return before launchd removes a draining job. Wait so an
        // immediate up cannot mistake the departing service for a live one.
        let removed = false;
        for (let attempt = 0; attempt < 480; attempt++) {
          removed = await exec("/bin/launchctl", ["print", target]).then(
            () => false,
            () => true
          );
          if (removed) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!removed) throw new Error("Local service is still draining");
      }
      console.log(`${service.name}: stopped`);
      continue;
    }
    if (command === "up" && !loaded) {
      const path = join(directory, `${service.name}.plist`);
      // Loaded for this login session only. No automatic crash restart or key persistence.
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, "dist/src/local-sandbox", service.main))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>120</integer>
<key>StandardOutPath</key><string>${xml(join(directory, `${service.name}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, `${service.name}.log`))}</string>
</dict></plist>`,
        { mode: 0o600 }
      );
      await exec("/bin/launchctl", ["bootstrap", domain, path]);
    }
    const url = `http://127.0.0.1:${service.port}`;
    let online = false;
    for (let attempt = 0; attempt < (command === "up" ? 40 : 1); attempt++) {
      online = await fetch(url, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false
      );
      if (online) break;
      if (command === "up") await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log(
      `${service.name}: ${online ? url : `not responding; inspect ${join(directory, `${service.name}.log`)}`}`
    );
    if (!online) process.exitCode = 1;
  }
}
void main().catch(() => {
  console.error(
    "Local service command failed. Inspect ~/.luma/local-services logs and the local-testing guide; no store is reset automatically."
  );
  process.exitCode = 1;
});
