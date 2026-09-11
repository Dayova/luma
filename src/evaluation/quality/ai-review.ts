import { z } from "zod";
import {
  meetingAnalysisSchema,
  meetingAnalysisJsonSchema,
  MEETING_INTELLIGENCE_INSTRUCTIONS
} from "../../ai/meeting-analysis-contract.js";
import { qualityCaseSchema, semanticReviewSchema, digest, gradeCase } from "./grading.js";
import { parseQualityRun } from "./artifacts.js";
import { prepareReviewPacket } from "./report.js";
import type { QualityRun } from "./runner.js";

const id = z.string().min(1).max(160),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewContextSchema = z
  .object({
    version: z.literal(1),
    id,
    revision: id,
    retrievedAt: z.string().datetime(),
    sources: z
      .array(
        z
          .object({
            id,
            title: z.string(),
            url: z.string().url().startsWith("https://"),
            observedEditedAt: z.string().datetime(),
            verification: z.object({ state: z.string() }).strict().nullable(),
            contentSha256: hash,
            coverage: z.string()
          })
          .strict()
      )
      .min(1),
    principles: z
      .array(
        z
          .object({
            id,
            scope: z.enum(["answer", "pipeline"]),
            statement: z.string().min(1),
            sourceIds: z.array(id).min(1)
          })
          .strict()
      )
      .min(1),
    limitations: z.array(z.string()).min(1)
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length ||
      new Set(c.principles.map((p) => p.id)).size !== c.principles.length ||
      c.principles.some((p) =>
        p.sourceIds.some((id) => !c.sources.some((s) => s.id === id))
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Unknown or duplicate context references"
      });
  });
// Semantic controls intentionally have no legacy automated predicates. Their expected labels stay out of the packet.
const semanticControlCase = z
  .object({
    ...qualityCaseSchema.innerType().shape,
    fixture: z
      .object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        language: z.enum(["de", "en", "mixed"]),
        occurredAt: z.string().datetime(),
        timezone: z.literal("Europe/Berlin"),
        utterances: z
          .array(z.object({ speakerId: id, text: z.string().min(1) }).strict())
          .min(1),
        checks: z.array(z.never()).length(0),
        manualReview: z.string().min(1)
      })
      .strict(),
    rules: z.array(z.never()).length(0),
    split: z.literal("development"),
    independentReview: z.null()
  })
  .strict();
const expectation = z
  .object({ rubricId: id, verdict: z.enum(["pass", "fail"]) })
  .strict();
export const controlsSchema = z
  .object({
    version: z.literal(1),
    provenance: z.literal("agent-authored-calibration-not-human-gold"),
    controls: z
      .array(
        z
          .object({
            case: semanticControlCase,
            output: meetingAnalysisSchema,
            expectations: z.array(expectation).min(1)
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict();
type Entry = Omit<ReturnType<typeof prepareReviewPacket>["entries"][number], "reference">;
export type AIReviewPacket = {
  version: 1;
  benchmarkHash: string;
  contextHash: string;
  context: z.infer<typeof reviewContextSchema>;
  contract: { instructions: string; schema: Record<string, unknown> };
  entries: Entry[];
  packetHash: string;
};
export type AIReviewController = {
  version: 1;
  packetHash: string;
  benchmarkHash: string;
  contextHash: string;
  evaluationAnswerIds: string[];
  controls: { answerId: string; rubricId: string; verdict: "pass" | "fail" }[];
};

/** The reviewer receives neither candidate identities nor author-written reference answers or control labels. */
export function createAIReviewPacket(
  input: QualityRun,
  contextInput: unknown,
  controlsInput: unknown
): { packet: AIReviewPacket; controller: AIReviewController } {
  const run = structuredClone(parseQualityRun(input)),
    context = reviewContextSchema.parse(contextInput),
    controls = controlsSchema.parse(controlsInput);
  const entries: Entry[] = prepareReviewPacket(run).entries.map((e) => ({
    answerId: e.answerId,
    caseId: e.caseId,
    occurredAt: e.occurredAt,
    timezone: e.timezone,
    language: e.language,
    utterances: e.utterances,
    rubric: e.rubric,
    output: e.output
  }));
  const evaluationAnswerIds = entries.map((e) => e.answerId);
  const expected: AIReviewController["controls"] = [];
  for (const c of controls.controls) {
    if (new Set(c.case.rubric.map((r) => r.id)).size !== c.case.rubric.length)
      throw new Error("Duplicate calibration rubric");
    const answerId = gradeCase(c.case, c.output).answerId;
    if (
      c.expectations.some((e) => !c.case.rubric.some((r) => r.id === e.rubricId)) ||
      new Set(c.expectations.map((e) => e.rubricId)).size !== c.expectations.length
    )
      throw new Error("Unknown or duplicate calibration rubric");
    entries.push({
      answerId,
      caseId: c.case.fixture.id,
      occurredAt: c.case.fixture.occurredAt,
      timezone: c.case.fixture.timezone,
      language: c.case.fixture.language,
      utterances: c.case.fixture.utterances,
      rubric: c.case.rubric,
      output: c.output
    });
    expected.push(...c.expectations.map((e) => ({ answerId, ...e })));
  }
  if (new Set(entries.map((e) => e.answerId)).size !== entries.length)
    throw new Error("Duplicate control or evaluated answer");
  const base = {
    version: 1 as const,
    benchmarkHash: run.benchmarkHash,
    contextHash: digest(context),
    context,
    contract: {
      instructions: MEETING_INTELLIGENCE_INSTRUCTIONS,
      schema: meetingAnalysisJsonSchema
    },
    entries: entries.sort((a, b) => a.answerId.localeCompare(b.answerId))
  };
  const packet = { ...base, packetHash: digest(base) };
  return {
    packet,
    controller: {
      version: 1,
      packetHash: packet.packetHash,
      benchmarkHash: run.benchmarkHash,
      contextHash: packet.contextHash,
      evaluationAnswerIds,
      controls: expected
    }
  };
}
const reviewerSchema = z
  .object({
    id,
    system: z.string().min(1),
    model: z.string().min(1),
    freshContext: z.boolean(),
    metadataBlinded: z.boolean()
  })
  .strict();
export const aiReviewRoundSchema = z
  .object({
    version: z.literal(1),
    packetHash: hash,
    reviewer: reviewerSchema,
    reviews: z.array(semanticReviewSchema),
    findings: z.array(
      z
        .object({
          answerId: hash,
          kind: z.enum(["answer-error", "rubric-concern", "capability-gap"]),
          rubricId: id,
          explanation: z.string().min(1),
          evidenceIds: z.array(id),
          principleIds: z.array(id).min(1)
        })
        .strict()
    )
  })
  .strict();
export type AIReviewRound = z.infer<typeof aiReviewRoundSchema>;
function validatePacket(packet: AIReviewPacket) {
  const { packetHash, ...content } = packet;
  if (digest(content) !== packetHash || digest(packet.context) !== packet.contextHash)
    throw new Error("Changed AI review packet or context");
}
export function validateAIReviewRound(
  packet: AIReviewPacket,
  input: unknown
): AIReviewRound {
  validatePacket(packet);
  const round = aiReviewRoundSchema.parse(input);
  if (
    round.packetHash !== packet.packetHash ||
    round.reviews.length !== packet.entries.length ||
    new Set(round.reviews.map((r) => r.answerId)).size !== round.reviews.length
  )
    throw new Error("Stale review or incomplete/duplicate coverage");
  const validateRefs = (answerId: string, rubricId: string, evidenceIds: string[]) => {
    const e = packet.entries.find((e) => e.answerId === answerId);
    if (
      !e ||
      !e.rubric.some((r) => r.id === rubricId) ||
      evidenceIds.some(
        (id) => !e.utterances.some((_, i) => id === `evidence:${e.caseId}:${i + 1}`)
      )
    )
      throw new Error("Unknown answer, rubric or source Evidence");
  };
  for (const review of round.reviews) {
    const e = packet.entries.find((e) => e.answerId === review.answerId);
    if (
      !e ||
      review.reviewer.kind !== "agent" ||
      review.reviewer.id !== round.reviewer.id ||
      review.judgments.length !== e.rubric.length ||
      new Set(review.judgments.map((j) => j.rubricId)).size !== review.judgments.length
    )
      throw new Error("AI reviews need complete agent-attributed judgments");
    for (const j of review.judgments)
      validateRefs(review.answerId, j.rubricId, j.evidenceIds);
  }
  for (const finding of round.findings) {
    validateRefs(finding.answerId, finding.rubricId, finding.evidenceIds);
    if (
      finding.principleIds.some(
        (id) => !packet.context.principles.some((p) => p.id === id)
      )
    )
      throw new Error("Unknown product principle");
  }
  return round;
}
function verdict(round: AIReviewRound, answerId: string) {
  const judgments = round.reviews.find((r) => r.answerId === answerId)!.judgments;
  return judgments.some((j) => j.verdict === "fail")
    ? "fail"
    : judgments.every((j) => j.verdict === "pass")
      ? "pass"
      : "uncertain";
}
/** AI judgments are an additional read-only view. They never replace a human label or the recorded automatic checks. */
export function summarizeAIReviews(
  input: QualityRun,
  packet: AIReviewPacket,
  controller: AIReviewController,
  inputs: unknown[]
) {
  const run = parseQualityRun(input);
  validatePacket(packet);
  if (
    run.benchmarkHash !== controller.benchmarkHash ||
    packet.benchmarkHash !== run.benchmarkHash ||
    controller.packetHash !== packet.packetHash ||
    controller.contextHash !== packet.contextHash
  )
    throw new Error("Review controller does not match run and context");
  const actual = prepareReviewPacket(run).entries;
  if (
    digest([...controller.evaluationAnswerIds].sort()) !==
      digest(actual.map((e) => e.answerId).sort()) ||
    actual.some(({ reference, ...e }) => {
      void reference;
      return digest(e) !== digest(packet.entries.find((p) => p.answerId === e.answerId));
    })
  )
    throw new Error("Review packet does not contain the evaluated answers");
  const controlKeys = controller.controls.map((c) => `${c.answerId}:${c.rubricId}`);
  const controlIds = new Set(controller.controls.map((c) => c.answerId));
  if (
    !controlKeys.length ||
    new Set(controlKeys).size !== controlKeys.length ||
    controller.evaluationAnswerIds.some((id) => controlIds.has(id)) ||
    packet.entries.some(
      (e) =>
        !controller.evaluationAnswerIds.includes(e.answerId) &&
        !controlIds.has(e.answerId)
    ) ||
    controller.controls.some(
      (c) =>
        !["pass", "fail"].includes(c.verdict) ||
        !packet.entries
          .find((e) => e.answerId === c.answerId)
          ?.rubric.some((r) => r.id === c.rubricId)
    )
  )
    throw new Error("Invalid calibration controller");
  const rounds = inputs.map((r) => validateAIReviewRound(packet, r));
  if (
    rounds.length < 1 ||
    rounds.length > 8 ||
    new Set(rounds.map((r) => r.reviewer.id)).size !== rounds.length
  )
    throw new Error("Duplicate or missing reviewer");
  const reviewers = rounds.map((r) => {
    const checks = controller.controls.map((c) => {
      const observed = r.reviews
        .find((a) => a.answerId === c.answerId)
        ?.judgments.find((j) => j.rubricId === c.rubricId)?.verdict;
      if (!observed) throw new Error("Missing control judgment");
      return { ...c, observed, passed: observed === c.verdict };
    });
    return {
      ...r.reviewer,
      calibrationPassed: checks.length > 0 && checks.every((c) => c.passed),
      calibrationChecks: checks.length,
      calibrationCorrect: checks.filter((c) => c.passed).length,
      checks
    };
  });
  const candidates = run.models.map((m) => {
    const rows = run.rows.filter((r) => r.candidate === m.label),
      valid = rows.filter((r) => r.status === "completed" && r.grade);
    return {
      candidate: m.label,
      attempts: rows.filter((r) => r.status === "completed" || r.status === "error")
        .length,
      validAnswers: valid.length,
      operationalErrors: rows.filter((r) => r.status === "error").length,
      unrun: rows.filter((r) => !["completed", "error"].includes(r.status)).length,
      humanReviewedPasses: valid.filter((r) => r.grade?.verdict === "passed").length,
      judges: rounds.map((round) => ({
        reviewer: round.reviewer.id,
        semanticPasses: valid.filter((r) => verdict(round, r.grade!.answerId) === "pass")
          .length,
        semanticFailures: valid.filter(
          (r) => verdict(round, r.grade!.answerId) === "fail"
        ).length,
        semanticUncertain: valid.filter(
          (r) => verdict(round, r.grade!.answerId) === "uncertain"
        ).length,
        automaticAndAIPasses: valid.filter(
          (r) =>
            r.grade!.automated.every((a) => a.passed) &&
            verdict(round, r.grade!.answerId) === "pass"
        ).length,
        criticalSemanticFailures: valid.filter((r) =>
          round.reviews
            .find((a) => a.answerId === r.grade!.answerId)!
            .judgments.some(
              (j) =>
                j.verdict === "fail" &&
                packet.entries
                  .find((e) => e.answerId === r.grade!.answerId)!
                  .rubric.some((x) => x.id === j.rubricId && x.severity === "critical")
            )
        ).length
      }))
    };
  });
  const disagreements: {
    answerId: string;
    caseId: string;
    rubricId: string;
    left: string;
    right: string;
    leftVerdict: string;
    rightVerdict: string;
  }[] = [];
  let compared = 0,
    agreed = 0;
  for (let i = 0; i < rounds.length; i++)
    for (let j = i + 1; j < rounds.length; j++)
      for (const answerId of controller.evaluationAnswerIds) {
        const left = rounds[i]!,
          right = rounds[j]!,
          l = left.reviews.find((r) => r.answerId === answerId)!,
          r = right.reviews.find((r) => r.answerId === answerId)!;
        for (const judgment of l.judgments) {
          const other = r.judgments.find((j) => j.rubricId === judgment.rubricId)!;
          compared++;
          if (judgment.verdict === other.verdict) agreed++;
          else
            disagreements.push({
              answerId,
              caseId: packet.entries.find((e) => e.answerId === answerId)!.caseId,
              rubricId: judgment.rubricId,
              left: left.reviewer.id,
              right: right.reviewer.id,
              leftVerdict: judgment.verdict,
              rightVerdict: other.verdict
            });
        }
      }
  return {
    version: 1,
    benchmarkHash: run.benchmarkHash,
    packetHash: packet.packetHash,
    contextHash: packet.contextHash,
    calibrationHash: digest(controller.controls),
    reviewers,
    candidates,
    answers: run.rows
      .filter((r) => r.status === "completed" && r.grade)
      .map((r) => ({
        candidate: r.candidate,
        caseId: r.caseId,
        answerId: r.grade!.answerId,
        judgments: rounds.map((round) => ({
          reviewer: round.reviewer.id,
          verdict: verdict(round, r.grade!.answerId)
        }))
      })),
    agreement: {
      compared,
      agreed,
      disagreements: disagreements.length,
      rate: compared ? agreed / compared : null
    },
    disagreements,
    findings: rounds.flatMap((r) =>
      r.findings
        .filter((f) => controller.evaluationAnswerIds.includes(f.answerId))
        .map((f) => ({ reviewer: r.reviewer.id, ...f }))
    ),
    interpretation:
      "AI semantic opinions, not human labels or an automatic winner. Calibration is agent-authored and limited; do not hide a failed control. Fresh sessions and metadata blinding are procedural attestations, not access isolation or statistical independence. Same-family reviewers can share bias. Agreement is descriptive across correlated rubric judgments, not an accuracy estimate. Operational failures remain separate, and product/pipeline gaps do not by themselves establish answer errors."
  };
}
