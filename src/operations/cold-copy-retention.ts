import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Keeps the latest failed attempt; removes only older managed temporary copies. */
export async function pruneOldColdCopies(directory: string): Promise<void> {
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^cold-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink())
      candidates.push({ path, modifiedAt: info.mtimeMs });
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  for (const old of candidates.slice(1)) await rm(old.path, { recursive: true });
}
