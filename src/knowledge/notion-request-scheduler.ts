import { createHash } from "node:crypto";

export const NOTION_OPERATION_TIMEOUT_MS = 240_000;
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 180;
const BACKGROUND_REQUESTS_PER_WINDOW = 156;
const CONCURRENT_REQUESTS = 4;
type Waiter = () => void;

export class NotionRequestUnavailableError extends Error {
  constructor() {
    super(
      "The bounded Notion request could not complete; retry only safe reads or recover an uncertain write."
    );
  }
}

/** Shared by actual clients using the same credential; never stores or exposes its raw token. */
const schedules = new Map<string, NotionRequestScheduler>();
export function sharedNotionRequestScheduler(token: string): NotionRequestScheduler {
  const key = createHash("sha256").update(token).digest("hex");
  const prior = schedules.get(key);
  if (prior) return prior;
  const scheduler = createNotionRequestScheduler();
  schedules.set(key, scheduler);
  return scheduler;
}

export interface NotionRequestScheduler {
  request<T>(input: {
    signal: AbortSignal;
    readOnly: boolean;
    priority?: "background";
    /** Runs after a queued wait and again if proof itself exhausts capacity. */
    beforeDispatch?: () => Promise<void>;
    send: () => Promise<T>;
  }): Promise<T>;
}

export function createNotionRequestScheduler(): NotionRequestScheduler {
  const started: number[] = [];
  const waiters = new Set<Waiter>();
  let active = 0;
  let pauseUntil = 0;
  const check = (signal: AbortSignal) => {
    if (signal.aborted) throw new NotionRequestUnavailableError();
  };
  const delay = (priority?: "background") => {
    const now = Date.now();
    while (started.length && started[0]! <= now - WINDOW_MS) started.shift();
    const limit =
      priority === "background" ? BACKGROUND_REQUESTS_PER_WINDOW : REQUESTS_PER_WINDOW;
    return Math.max(
      0,
      pauseUntil - now,
      started.length >= limit ? started[started.length - limit]! + WINDOW_MS - now : 0
    );
  };
  const ready = (priority?: "background") =>
    delay(priority) === 0 && active < CONCURRENT_REQUESTS;
  const wait = (signal: AbortSignal, priority?: "background"): Promise<void> => {
    check(signal);
    if (ready(priority)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        waiters.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        clear();
        reject(new NotionRequestUnavailableError());
      };
      const wake = () => {
        if (signal.aborted) return abort();
        if (timer) clearTimeout(timer);
        if (ready(priority)) {
          clear();
          resolve();
          return;
        }
        const milliseconds = delay(priority);
        if (milliseconds > 0) timer = setTimeout(wake, milliseconds);
      };
      waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      wake();
    });
  };
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  return {
    async request(input) {
      for (let attempt = 0; ;) {
        check(input.signal);
        await wait(input.signal, input.priority);
        // Do not hold a request slot while a source proof makes its own reads.
        await input.beforeDispatch?.();
        check(input.signal);
        if (!ready(input.priority)) continue;
        active += 1;
        started.push(Date.now());
        try {
          return await abortable(input.signal, input.send);
        } catch (error) {
          const retry = retryInformation(error);
          if (retry) {
            pauseUntil = Math.max(
              pauseUntil,
              Date.now() + (retry.retryAfterMs ?? Math.min(4000, 500 * 2 ** attempt))
            );
          }
          // A dispatched mutation stays unknown even for an overload response.
          if (!input.readOnly || !retry || attempt >= 2 || input.signal.aborted)
            throw new NotionRequestUnavailableError();
          attempt += 1;
        } finally {
          active -= 1;
          notify();
        }
      }
    }
  };
}

function abortable<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new NotionRequestUnavailableError());
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new NotionRequestUnavailableError();
        return send();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function retryInformation(error: unknown): { retryAfterMs?: number } | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  if (![429, 529, 500, 502, 503, 504].includes(Number(error.status))) return null;
  if ("headers" in error && error.headers instanceof Headers) {
    const value = error.headers.get("retry-after");
    if (value !== null && /^\d+$/u.test(value)) {
      const seconds = Number(value);
      if (Number.isSafeInteger(seconds) && seconds >= 0)
        return { retryAfterMs: seconds * 1000 };
    }
  }
  return {};
}
