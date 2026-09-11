import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@notionhq/client";
import { sharedNotionRequestScheduler } from "./notion-request-scheduler.js";

/** SDK types remain inside the Notion adapter; queued/cancelled work never starts a late HTTP call. */
export function createScheduledNotionClient(token: string) {
  const currentSignal = new AsyncLocalStorage<AbortSignal>();
  const scheduler = sharedNotionRequestScheduler(token);
  const client = new Client({
    auth: token,
    notionVersion: "2026-03-11",
    timeoutMs: 4_000,
    retry: false,
    logger: () => undefined,
    fetch: (url, init) => {
      const signal = currentSignal.getStore();
      if (!signal || signal.aborted)
        return Promise.reject(new Error("Notion request expired"));
      return fetch(url, {
        ...init,
        signal
      });
    }
  });
  return {
    client,
    request<T>(
      this: void,
      input: {
        signal: AbortSignal;
        readOnly: boolean;
        priority?: "background";
        beforeDispatch?: () => Promise<void>;
        send: () => Promise<T>;
      }
    ): Promise<T> {
      return scheduler.request({
        ...input,
        send: async () => {
          const controller = new AbortController();
          const signal = AbortSignal.any([input.signal, controller.signal]);
          const timer = setTimeout(() => controller.abort(), 4_000);
          let rejectTimeout = () => {};
          const timeout = new Promise<never>((_, reject) => {
            rejectTimeout = () => reject(new Error("Notion request expired"));
            if (signal.aborted) rejectTimeout();
            else signal.addEventListener("abort", rejectTimeout, { once: true });
          });
          try {
            return await Promise.race([
              Promise.resolve().then(() => {
                if (signal.aborted) throw new Error("Notion request expired");
                return currentSignal.run(signal, input.send);
              }),
              timeout
            ]);
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", rejectTimeout);
            controller.abort();
          }
        }
      });
    }
  };
}
