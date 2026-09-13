import { AsyncLocalStorage } from "node:async_hooks";

/** An owned operation can impose fresh disclosure proof on every paid call in its async lifetime. */
const guards = new AsyncLocalStorage<() => Promise<void>>();
export function withAiRequestGuard<T>(
  guard: () => Promise<void>,
  operation: () => Promise<T>
): Promise<T> {
  const parent = guards.getStore();
  return guards.run(async () => {
    await parent?.();
    await guard();
  }, operation);
}
export async function requireAiRequestGuardCurrent(): Promise<void> {
  await guards.getStore()?.();
}
