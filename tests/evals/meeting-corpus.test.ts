import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { loadCorpus, validateCoverage, type SemanticCheck } from "../../evals/corpus.js";
import { evaluateCorpus } from "../../evals/runner.js";
import { reportExitCode, score } from "../../evals/scorer.js";

const load = () =>
  loadCorpus(
    resolve("evals/fixtures/meeting-corpus.json"),
    resolve("evals/fixtures/meeting-samples.json")
  );
afterEach(() => {
  vi.restoreAllMocks();
});

describe("versioned Meeting product evaluation", () => {
  it("consumes every named expectation, measures public behavior, and cannot turn missing retrieval into product readiness", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden in deterministic evaluation"));
    const { corpus, samples } = await load();
    const report = await evaluateCorpus(corpus, samples);
    expect(report.fixtures.map((fixture) => fixture.id)).toEqual(
      [...corpus.fixtures, ...corpus.retrievalFixtures].map((fixture) => fixture.id)
    );
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBeGreaterThan(40);
    const missing = report.fixtures
      .flatMap((fixture) => fixture.checks)
      .filter((check) => check.status === "missing");
    expect(missing.map((check) => check.id)).toEqual([
      "code-context-can-be-linked",
      "cross-meeting-current-recall",
      "cross-provider-stale-inclusion"
    ]);
    expect(report.knowledgeSelection.relevantCurrentRecall).toEqual({
      recalled: 3,
      relevant: 3,
      ratio: 1
    });
    expect(report.knowledgeSelection.staleClaimInclusion).toEqual({
      included: 0,
      annotatedStaleOrUnaccepted: 2,
      unobserved: 0,
      ratio: 0
    });
    const meetingContextEntries = report.fixtures
      .filter(
        (fixture) => fixture.surface === "MeetingIntelligence.observe/query/conclude"
      )
      .reduce((sum, fixture) => sum + fixture.contextUse.contextEntries, 0);
    expect(report.knowledgeSelection.contextUse.additionalContextEntries).toBe(
      meetingContextEntries
    );
    expect(report.knowledgeSelection.contextUse.inputCharacters).toBeGreaterThan(0);
    expect(report.retrievalKnowledgeSelection.relevantCurrentRecall).toEqual({
      recalled: 5,
      relevant: 5,
      ratio: 1
    });
    expect(report.retrievalKnowledgeSelection.staleClaimInclusion).toEqual({
      included: 0,
      annotatedStaleOrUnaccepted: 6,
      unobserved: 0,
      ratio: 0
    });
    expect(
      report.retrievalKnowledgeSelection.contextUse.additionalContextEntries
    ).toBeGreaterThan(0);
    expect(report.productReadiness).toBe("not-demonstrated");
    expect(report.usage).toMatchObject({
      paidRequests: 0,
      actualCostUsd: 0,
      inputTokens: null,
      outputTokens: null
    });
    expect(report.model.liveQuality).toBe("unmeasured");
    expect(network).not.toHaveBeenCalled();
    const checks = report.fixtures.flatMap((fixture) => fixture.checks);
    expect(reportExitCode(checks)).toBe(0);
    expect(reportExitCode(checks, true)).toBe(1);
  }, 20_000);

  it("detects wrong ownership, erased modality, invented claims and stale current answers rather than trusting fixture output", async () => {
    const { corpus, samples } = await load();
    const mixed = samples.samples["mixed"]?.actionItems[0];
    const proposal = samples.samples["uncertain"]?.decisions[0];
    const code = samples.samples["code"];
    const retained = corpus.fixtures.find(
      (fixture) => fixture.id === "retained-current-and-historical-decisions"
    );
    const stale = retained?.steps.find((step) => step.id === "supersede");
    if (!mixed || !proposal || !code || stale?.type !== "judge")
      throw new Error("Expected versioned mutation targets");
    mixed.ownerId = "person_fabius";
    proposal.statement = "Wir werden Linear verwenden.";
    proposal.status = "confirmed";
    code.risks.push({
      stableKey: "invented",
      statement: "The token refresh worker has already been fixed in production.",
      severity: "high",
      mitigation: null,
      evidenceIds: ["$0"],
      confidence: "high"
    });
    stale.correction.status = "confirmed";
    const report = await evaluateCorpus(corpus, samples);
    const checks = report.fixtures.flatMap((fixture) => fixture.checks);
    const failed = checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).toEqual(
      expect.arrayContaining([
        "owner-is-jakob",
        "decision-status-candidate",
        "modality-preserved",
        "unsupported-implementation-claim-rate-zero",
        "only-source-supported-claims",
        "superseded-fact-excluded-from-current"
      ])
    );
    expect(report.knowledgeSelection.staleClaimInclusion.included).toBe(1);
    expect(reportExitCode(checks)).toBe(1);
  }, 20_000);

  it("rejects silent missing expectations and unversioned/missing samples before running", async () => {
    const { corpus, samples } = await load();
    const first = corpus.fixtures[0];
    if (!first) throw new Error("Expected original corpus");
    first.expected.checks.push("undeclared-product-requirement");
    expect(() => validateCoverage(corpus, samples)).toThrow("Every expected check");
    first.expected.checks.pop();
    delete samples.samples["german"];
    expect(() => validateCoverage(corpus, samples)).toThrow("Missing sample german");
  });

  it("rejects a missing linked retrieval assertion instead of silently resolving an original product gap", async () => {
    const { corpus, samples } = await load();
    const duplicate = corpus.retrievalFixtures.find(
      (fixture) => fixture.id === "organizational-duplicate-context"
    );
    if (!duplicate) throw new Error("Expected retrieval corpus");
    duplicate.assertions = duplicate.assertions.filter(
      (check) => check.id !== "duplicate-context"
    );
    expect(() => validateCoverage(corpus, samples)).toThrow(
      "Missing executable retrieval coverage duplicate-context"
    );
  });

  it("fails when catalog authority, duplicate selection, excerpt budgets or source invalidation regress", async () => {
    const { corpus, samples } = await load();
    const get = (id: string) => {
      const fixture = corpus.retrievalFixtures.find((entry) => entry.id === id);
      if (!fixture) throw new Error(`Missing mutation fixture ${id}`);
      return fixture;
    };
    const ranked = get("organizational-current-ranking").sources[0];
    const copy = get("organizational-duplicate-context").sources[1];
    if (!ranked || !copy) throw new Error("Missing mutation source");
    ranked.source.standing = "superseded";
    copy.source.content = "Fabius owns Luma.";
    get("organizational-bounded-context").limits.maxCharacters = 8_000;
    for (const id of [
      "organizational-revoked-derived-answers",
      "organizational-deleted-derived-answers",
      "organizational-new-discovery"
    ])
      get(id).steps = get(id).steps.filter((step) => step.type !== "change");
    const midflight = get("organizational-midflight-revocation").steps[0];
    if (midflight?.type !== "inquire") throw new Error("Missing midflight step");
    delete midflight.duringAnswer;
    const report = await evaluateCorpus(corpus, samples);
    const failed = report.fixtures
      .flatMap((fixture) => fixture.checks)
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).toEqual(
      expect.arrayContaining([
        "old-valid-organizational-recall",
        "human-owner-outranks-provisional-cto",
        "newer-unaccepted-owner-not-promoted",
        "duplicate-context",
        "duplicate-source-not-extra-authority",
        "bounded-organizational-input-output",
        "truncation-explicit",
        "revoked-source-derived-views",
        "revoked-delivery-denied",
        "revoked-fresh-answer-no-stale-claim",
        "deleted-source-derived-views",
        "deleted-delivery-denied",
        "deleted-fresh-answer-no-stale-claim",
        "new-discovery-invalidates-replay",
        "midflight-result-cached-nondeliverable"
      ])
    );
    expect(
      report.retrievalKnowledgeSelection.relevantCurrentRecall.recalled
    ).toBeLessThan(5);
    expect(
      report.retrievalKnowledgeSelection.staleClaimInclusion.included
    ).toBeGreaterThan(0);
    expect(reportExitCode(report.fixtures.flatMap((fixture) => fixture.checks))).toBe(1);
  }, 20_000);
});

describe("semantic annotation scorer", () => {
  const check: SemanticCheck = {
    id: "preserve-fact",
    metric: "grounding",
    path: ["answer"],
    operation: "equals",
    expected: null
  };
  it("distinguishes an absent result from an explicitly unresolved value", () => {
    expect(score(check, {}).status).toBe("failed");
    expect(score(check, { answer: null }).status).toBe("passed");
    expect(score({ ...check, operation: "excludes", expected: "stale" }, {}).status).toBe(
      "failed"
    );
  });
  it("does not accept duplicate output as complete claim coverage", () => {
    expect(
      score(
        { ...check, operation: "set-equals", expected: ["current", "history"] },
        { answer: ["current", "current"] }
      ).status
    ).toBe("failed");
    expect(
      score(
        { ...check, operation: "set-equals", expected: ["current", "history"] },
        { answer: ["history", "current"] }
      ).status
    ).toBe("passed");
  });
  it("requires a real comparison surface for non-destructive history checks", () => {
    expect(
      score({ ...check, operation: "same-as", expected: ["before"] }, { answer: {} })
        .status
    ).toBe("failed");
    expect(
      score(
        { ...check, operation: "same-as", expected: ["before"] },
        { answer: { retained: true }, before: { retained: true } }
      ).status
    ).toBe("passed");
  });
});
