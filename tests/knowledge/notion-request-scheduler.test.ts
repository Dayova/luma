import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotionRequestScheduler } from "../../src/knowledge/notion-request-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("bounded Notion connection scheduling", () => {
  it("shares a conservative 180-request window and cancels queued work without sending it", async () => {
    vi.useFakeTimers();
    const scheduler = createNotionRequestScheduler();
    const controller = new AbortController();
    const sent = vi.fn(() => Promise.resolve("read"));
    await Promise.all(
      Array.from({ length: 180 }, () =>
        scheduler.request({ signal: controller.signal, readOnly: true, send: sent })
      )
    );
    expect(sent).toHaveBeenCalledTimes(180);
    const queued = scheduler.request({
      signal: controller.signal,
      readOnly: true,
      send: sent
    });
    const refused = expect(queued).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sent).toHaveBeenCalledTimes(180);
    controller.abort();
    await refused;
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveBeenCalledTimes(180);
  });

  it("reserves foreground capacity while background discovery waits", async () => {
    vi.useFakeTimers();
    const scheduler = createNotionRequestScheduler();
    const signal = new AbortController().signal;
    await Promise.all(
      Array.from({ length: 156 }, () =>
        scheduler.request({
          signal,
          readOnly: true,
          priority: "background",
          send: () => Promise.resolve()
        })
      )
    );
    const background = vi.fn(() => Promise.resolve());
    const queued = scheduler.request({
      signal,
      readOnly: true,
      priority: "background",
      send: background
    });
    const foreground = vi.fn(() => Promise.resolve());
    await Promise.all(
      Array.from({ length: 24 }, () =>
        scheduler.request({ signal, readOnly: true, send: foreground })
      )
    );
    expect(foreground).toHaveBeenCalledTimes(24);
    expect(background).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await queued;
    expect(background).toHaveBeenCalledTimes(1);
  });
  it("rechecks mutation proof when its own reads consume the remaining request window", async () => {
    vi.useFakeTimers();
    const scheduler = createNotionRequestScheduler();
    const signal = new AbortController().signal;
    let revoked = false;
    const proof = vi.fn(async () => {
      if (revoked) throw new Error("Current grant revoked");
      await Promise.all(
        Array.from({ length: 180 }, () =>
          scheduler.request({ signal, readOnly: true, send: () => Promise.resolve() })
        )
      );
      revoked = true;
    });
    const send = vi.fn(() => Promise.resolve());
    const pending = scheduler.request({
      signal,
      readOnly: false,
      beforeDispatch: proof,
      send
    });
    const refused = expect(pending).rejects.toThrow("revoked");
    await vi.advanceTimersByTimeAsync(60_001);
    await refused;
    expect(proof).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([429, 529])(
    "respects Retry-After on safe reads and never retries an uncertain %s mutation",
    async (status) => {
      vi.useFakeTimers();
      const scheduler = createNotionRequestScheduler();
      const signal = new AbortController().signal;
      const error = { status, headers: new Headers({ "retry-after": "2" }) };
      const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("current");
      const pending = scheduler.request({ signal, readOnly: true, send: read });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("current");
      const write = vi.fn().mockRejectedValue(error);
      await expect(
        scheduler.request({ signal, readOnly: false, send: write })
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(write).toHaveBeenCalledTimes(1);
    }
  );

  it("bounds active requests and settles a stalled transport when its operation is cancelled", async () => {
    const scheduler = createNotionRequestScheduler();
    const controller = new AbortController();
    const send = vi.fn(() => new Promise<void>(() => {}));
    const requests = Promise.allSettled(
      Array.from({ length: 5 }, () =>
        scheduler.request({ signal: controller.signal, readOnly: true, send })
      )
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    controller.abort();
    expect((await requests).every((result) => result.status === "rejected")).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
