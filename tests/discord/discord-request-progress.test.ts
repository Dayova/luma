import { afterEach, describe, expect, it, vi } from "vitest";
import { startDiscordRequestProgress } from "../../src/discord/discord-request-progress.js";

afterEach(() => vi.useRealTimers());

describe("Discord text progress", () => {
  it("acknowledges immediately, reports a long wait, and stops before the final answer", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const progress = startDiscordRequestProgress({
      send: ({ content }) => {
        sent.push(content);
        return Promise.resolve();
      }
    });
    await progress.ready;
    expect(sent).toEqual(["Nachricht erhalten. Ich prüfe deine Anfrage."]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent.at(-1)).toContain("15 Sekunden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.at(-1)).toContain("45 Sekunden");
    await progress.stop();
    sent.push("Final answer");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toBe("Final answer");
  });

  it("drains an in-flight receipt and does not schedule more updates after stop", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const sent: number[] = [];
    const progress = startDiscordRequestProgress({
      send: ({ sequence }) => {
        sent.push(sequence);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    let stopped = false;
    const stopping = progress.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([0]);
  });

  it("does not retry an ambiguous receipt or block the request when a receipt fails", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.reject(new Error("Discord unavailable")));
    const progress = startDiscordRequestProgress({ send });
    await expect(progress.ready).resolves.toBeUndefined();
    await progress.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
