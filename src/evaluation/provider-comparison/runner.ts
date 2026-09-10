import { createHash } from "node:crypto";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel
} from "../../ai/reasoning-model.js";
import {
  requestForFixture,
  scoreProposal,
  type Corpus,
  type CheckResult
} from "./corpus.js";
import {
  candidates,
  candidateKey,
  googleEndpoint,
  type GoogleEndpoint,
  comparisonPayload,
  createComparisonReasoningModel,
  ComparisonError,
  defaultLimits,
  comparisonPromptVersion,
  type Candidate,
  type Limits,
  type ResponseFacts
} from "./providers.js";

export type Row = {
  provider: string;
  model: string;
  fixture: string;
  repetition: number;
  requestHash: string;
  status: "not-run" | "missing-credential" | "request-limit" | "completed" | "error";
  latencyMs: number | null;
  errorCode: string | null;
  response: ResponseFacts | null;
  checks: CheckResult[] | null;
  output: MeetingAnalysisProposalBatch | null;
};
export type Report = {
  version: 1;
  createdAt: string;
  gitRevision: string;
  corpusHash: string;
  promptVersion: string;
  corpusProvenance: Corpus["provenance"];
  mode: "preflight" | "live";
  limits: Limits & { maxRequests: number; repeats: number };
  candidateConfig: readonly Candidate[];
  googleEndpoint: GoogleEndpoint;
  googlePricingSource: string;
  pricingVerifiedAt: string;
  pricingNotes: string;
  interpretation: string;
  rows: Row[];
};
export type RunnerOptions = {
  corpus: Corpus;
  env: NodeJS.ProcessEnv;
  live: boolean;
  maxRequests: number;
  repeats: number;
  gitRevision: string;
  selected: readonly Candidate[];
  limits?: Limits;
  beforeRequest?: (row: Row) => Promise<void>;
  checkpoint?: (report: Report) => Promise<void>;
  modelFactory?: (
    candidate: Candidate,
    apiKey: string,
    onResponse: (facts: ResponseFacts) => void
  ) => ReasoningModel;
};

export async function runComparison(options: RunnerOptions): Promise<Report> {
  if (
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests < 1 ||
    options.maxRequests > 200 ||
    !Number.isSafeInteger(options.repeats) ||
    options.repeats < 1 ||
    options.repeats > 5 ||
    options.selected.length < 1 ||
    new Set(options.selected.map((c) => c.id)).size !== options.selected.length ||
    options.selected.some((c) => !candidates.includes(c))
  )
    throw new ComparisonError("invalid-run-options");
  const limits = options.limits ?? defaultLimits;
  const report: Report = {
    version: 1,
    createdAt: new Date().toISOString(),
    gitRevision: options.gitRevision,
    corpusHash: createHash("sha256").update(JSON.stringify(options.corpus)).digest("hex"),
    corpusProvenance: options.corpus.provenance,
    promptVersion: comparisonPromptVersion,
    mode: options.live ? "live" : "preflight",
    limits: { ...limits, maxRequests: options.maxRequests, repeats: options.repeats },
    candidateConfig: options.selected,
    googleEndpoint: googleEndpoint(options.env),
    googlePricingSource:
      googleEndpoint(options.env).backend === "vertex"
        ? "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
        : "https://ai.google.dev/gemini-api/docs/pricing",
    pricingVerifiedAt: "2026-09-10",
    pricingNotes:
      "USD estimates use uncached input and billed output at published standard rates; DeepSeek peak rates, Google promotional rates through 2026-12-31. Cache discounts and actual invoice adjustments are not modeled. Missing usage is unknown, never zero. Request and output caps are enforced; USD estimates are not a provider billing cap.",
    interpretation:
      "Component comparison through ReasoningModel, not an end-to-end product or retrieval evaluation. Synthetic expectations are agent-authored and require human review. Automated checks do not prove citation entailment, complete recall, or overall semantic correctness. No automatic winner. Compare matched fixture/repetition coverage; missing and failed requests are not passes. Provider-specific reasoning settings are recorded in the request implementation and are not equivalent compute budgets.",
    rows: []
  };
  for (let repetition = 1; repetition <= options.repeats; repetition++)
    for (const fixture of options.corpus.fixtures)
      for (const candidate of options.selected) {
        const request = requestForFixture(fixture);
        report.rows.push({
          provider: candidate.id,
          model: candidate.model,
          fixture: fixture.id,
          repetition,
          requestHash: comparisonPayload(request).hash,
          status: candidateKey(candidate, options.env) ? "not-run" : "missing-credential",
          latencyMs: null,
          errorCode: null,
          response: null,
          checks: null,
          output: null
        });
      }
  await options.checkpoint?.(report);
  let dispatched = 0;
  if (options.live)
    for (const row of report.rows) {
      if (row.status === "missing-credential") continue;
      if (dispatched >= options.maxRequests) {
        row.status = "request-limit";
        continue;
      }
      const candidate = options.selected.find((c) => c.id === row.provider)!;
      const fixture = options.corpus.fixtures.find((f) => f.id === row.fixture)!;
      const onResponse = (facts: ResponseFacts) => {
        row.response = facts;
      };
      const model =
        options.modelFactory?.(
          candidate,
          candidateKey(candidate, options.env)!,
          onResponse
        ) ??
        createComparisonReasoningModel({
          candidate,
          apiKey: candidateKey(candidate, options.env)!,
          limits,
          googleEndpoint: report.googleEndpoint,
          onResponse
        });
      // Journal dispatch before the network call. Interrupted attempts may have been billed.
      await options.beforeRequest?.(row);
      dispatched++;
      const start = performance.now();
      try {
        const result = await model.generateStructured<MeetingAnalysisProposalBatch>(
          requestForFixture(fixture)
        );
        row.output = result.value;
        row.checks = scoreProposal(fixture, result.value);
        row.status = "completed";
      } catch (error) {
        row.status = "error";
        row.errorCode =
          error instanceof ComparisonError ? error.code : "evaluation-error";
      }
      row.latencyMs = Math.round(performance.now() - start);
      await options.checkpoint?.(report);
    }
  await options.checkpoint?.(report);
  return report;
}

export function renderReport(report: Report): string {
  const lines = [
    "# Luma provider comparison",
    "",
    `Mode: **${report.mode}**. Corpus: **${report.corpusProvenance}**.`,
    "",
    report.interpretation,
    "",
    "| Provider / model | Completed / planned | Failed | Missing key | Automated checks passed | Observed latency p50 | Known token-cost estimate |",
    "|---|---:|---:|---:|---:|---:|---:|"
  ];
  for (const candidate of report.candidateConfig) {
    const rows = report.rows.filter((r) => r.provider === candidate.id),
      completed = rows.filter((r) => r.status === "completed");
    const checks = completed.flatMap((r) => r.checks ?? []),
      latencies = completed.map((r) => r.latencyMs!).sort((a, b) => a - b);
    const dispatched = rows.filter(
      (r) => r.status === "completed" || r.status === "error"
    );
    const knownCosts = dispatched
      .map((r) => r.response?.estimatedUncachedCostUsd)
      .filter((v): v is number => typeof v === "number");
    lines.push(
      `| ${candidate.id} / ${candidate.model} | ${completed.length} / ${rows.length} | ${rows.filter((r) => r.status === "error").length} | ${rows.filter((r) => r.status === "missing-credential").length} | ${checks.length ? `${checks.filter((c) => c.passed).length} / ${checks.length}` : "not measured"} | ${latencies.length ? `${latencies[Math.floor((latencies.length - 1) / 2)]} ms` : "not measured"} | ${knownCosts.length ? `$${knownCosts.reduce((sum, v) => sum + v, 0).toFixed(6)} (${knownCosts.length}/${dispatched.length} requests)` : "unknown / not run"} |`
    );
  }
  lines.push(
    "",
    "## Reproduction",
    "",
    `- Git revision: ${report.gitRevision}`,
    `- Corpus SHA-256: ${report.corpusHash}`,
    `- Prompt version: ${report.promptVersion}`,
    `- Google backend: ${report.googleEndpoint.backend}${report.googleEndpoint.backend === "vertex" ? (report.googleEndpoint.projectId ? " (project-scoped, global)" : " (express, global)") : ""}; pricing: ${report.googlePricingSource}.`,
    `- Maximum requests: ${report.limits.maxRequests}; repetitions: ${report.limits.repeats}; output tokens/request: ${report.limits.maxOutputTokens}; timeout: ${report.limits.timeoutMs} ms.`,
    "",
    report.pricingNotes,
    "",
    "The JSON report retains each synthetic output and failed check for manual review. The dispatch journal records attempted requests even if the run was interrupted. No model recommendation can be inferred from a preflight or mocked test run.",
    ""
  );
  return lines.join("\n");
}
