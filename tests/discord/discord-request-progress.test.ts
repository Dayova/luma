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

it("updates one temporary message and removes it without touching the final answer", async () => {
  vi.useFakeTimers();
  const chat = new Map<string, string>();
  const progress = startDiscordRequestProgress({
    send: ({ content }) => {
      chat.set("status", content);
      return Promise.resolve({
        edit: (text: string) => {
          chat.set("status", text);
          return Promise.resolve();
        },
        remove: () => {
          chat.delete("status");
          return Promise.resolve();
        }
      });
    }
  });
  await progress.ready;
  await vi.advanceTimersByTimeAsync(45_000);
  expect(chat.size).toBe(1);
  expect(chat.get("status")).toContain("45 Sekunden");
  await progress.stop();
  expect(chat.has("status")).toBe(true);
  chat.set("final", "Here is the answer and its relevant caveat.");
  await progress.clear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect([...chat.values()]).toEqual(["Here is the answer and its relevant caveat."]);
});

it("drains a late edit before cleanup and never removes the same receipt twice", async () => {
  vi.useFakeTimers();
  let release = () => {};
  const remove = vi.fn(() => Promise.resolve());
  const edit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const send = vi.fn(() => Promise.resolve({ edit, remove }));
  const progress = startDiscordRequestProgress({ send });
  await progress.ready;
  await vi.advanceTimersByTimeAsync(15_000);
  const clearing = progress.clear();
  expect(remove).not.toHaveBeenCalled();
  release();
  await clearing;
  await progress.clear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(remove).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});

it("retires a status compactly if Discord refuses deletion, without failing the answer", async () => {
  const edit = vi.fn(() => Promise.resolve());
  const progress = startDiscordRequestProgress({
    send: () =>
      Promise.resolve({ edit, remove: () => Promise.reject(new Error("cannot delete")) })
  });
  await progress.ready;
  await expect(progress.clear()).resolves.toBeUndefined();
  expect(edit).toHaveBeenCalledWith("Bearbeitung beendet.");
});
