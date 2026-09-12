import { request } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCorpus } from "../../evals/corpus.js";
import { createSandboxSession } from "../../src/local-sandbox/session.js";
import { startSandboxServer } from "../../src/local-sandbox/server.js";

describe("local offline sandbox", () => {
  let session: Awaited<ReturnType<typeof createSandboxSession>>;
  let server: Awaited<ReturnType<typeof startSandboxServer>>;
  const evaluate = vi.fn(() => Promise.resolve({ summary: { passed: 1 } }));
  beforeAll(async () => {
    const { corpus, samples } = await loadCorpus(
      resolve("evals/fixtures/meeting-corpus.json"),
      resolve("evals/fixtures/meeting-samples.json")
    );
    session = await createSandboxSession(corpus, samples);
    server = await startSandboxServer({ session, evaluate });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("keeps Human ownership after a conflicting synthetic proposal and duplicate replay", async () => {
    // Any accidental fetch in the core path fails instead of reaching a paid provider.
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected outbound request"));
    try {
      await session.execute({ type: "load", scenario: "jakob-owns-luma-human-judgment" });
      await session.execute({
        type: "judge",
        itemId: "action:luma",
        action: "owner",
        owner: "person_julius"
      });
      await session.execute({ type: "next" }); // Fixture's explicit Human correction selects Jakob.
      await session.execute({ type: "next" }); // Snapshot.
      const later = await session.execute({ type: "next" }); // Conflicting synthetic model proposal.
      expect(
        later.state?.actionItems.find((item) => item.id === "action:luma")?.ownerId
      ).toBe("person_jakob");
      const replay = await session.execute({ type: "replay" });
      expect(replay.result).toMatchObject({
        acceptedObservationIds: [],
        duplicateObservationIds: expect.arrayContaining([
          expect.stringMatching(/:later:1$/)
        ]) as unknown
      });
      expect(replay.state?.actionItems).toEqual(later.state?.actionItems);
      const answer = await session.execute({
        type: "ask",
        text: "What are my action items?"
      });
      expect(answer.result).toMatchObject({
        type: "freeform",
        answer: { text: expect.stringContaining("Build Luma") as unknown }
      });
      expect(answer.paidRequests).toBe(0);
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
  });

  it("retains a rejected proposal and exposes uncertainty for unsupported questions", async () => {
    await session.execute({ type: "load", scenario: "uncertain-proposal" });
    const before = await session.view();
    const item = before.state?.decisions[0];
    expect(item).toBeDefined();
    const rejected = await session.execute({
      type: "judge",
      itemId: item!.id,
      action: "reject"
    });
    expect(rejected.state?.decisions[0]?.status).toBe("rejected");
    expect(rejected.state?.decisions[0]?.provenance.evidence).toEqual(
      expect.arrayContaining(item!.provenance.evidence)
    );
    const answer = await session.execute({
      type: "ask",
      text: "What is tomorrow's weather in Tokyo?"
    });
    expect(answer.result).toMatchObject({
      type: "freeform",
      answer: { uncertainty: "insufficient-evidence" }
    });
    await expect(
      session.execute({
        type: "judge",
        itemId: item!.id,
        action: "owner",
        owner: "person_jakob"
      })
    ).rejects.toThrow("action and owner");
    await expect(
      session.execute({ type: "load", scenario: "../../.env" })
    ).rejects.toThrow("Unknown scenario");
  });

  it("runs every interactive scenario with independent observations and a real conclusion", async () => {
    const initial = await session.view();
    for (const scenario of initial.scenarios) {
      let view = await session.execute({ type: "load", scenario: scenario.id });
      while (view.position < scenario.steps.length) {
        view = await session.execute({ type: "next" });
        if (view.result && typeof view.result === "object" && "errors" in view.result)
          expect(view.result.errors).toEqual([]);
      }
      expect(view.state).not.toBeNull();
      const conclusion = await session.execute({ type: "conclude" });
      expect(conclusion.result).toBeTruthy();
    }
  });

  it("serves a local page but refuses foreign origins, rebinding hosts and unbounded input", async () => {
    const page = await fetch(server.origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(
      "AI proposals and external sources are simulated"
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    const post = (headers: Record<string, string>, body = "{}") =>
      fetch(`${server.origin}/api/checks`, { method: "POST", headers, body });
    for (const headers of [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Origin: "https://foreign.invalid" }
    ])
      expect((await post(headers)).status).toBe(403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        server.origin,
        { headers: { Host: "rebound.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(reboundStatus).toBe(403);
    expect(evaluate).not.toHaveBeenCalled();
    const headers = { "Content-Type": "application/json", Origin: server.origin };
    expect((await post(headers, JSON.stringify("x".repeat(9000)))).status).toBe(400);
    expect((await post(headers, "{")).status).toBe(400);
    expect(evaluate).not.toHaveBeenCalled();
    const response = await post(headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: { passed: 1 } });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
