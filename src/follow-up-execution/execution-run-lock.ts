import type { LumaDatabase } from "../persistence/db.js";
const locksByDatabase = new WeakMap<LumaDatabase, Set<string>>();

/** The owned single-process store shares one run mutex across execution facades. */
export async function withExecutionRunLock<T>(
  database: LumaDatabase,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  let locks = locksByDatabase.get(database);
  if (!locks) {
    locks = new Set();
    locksByDatabase.set(database, locks);
  }
  if (locks.has(key))
    throw new Error(
      "Follow-up Intent already has an execution in progress; wait for it to finish before retrying."
    );
  locks.add(key);
  try {
    return await operation();
  } finally {
    locks.delete(key);
  }
}
