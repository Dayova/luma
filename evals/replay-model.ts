import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../src/ai/reasoning-model.js";
import { batchSchema, type SampleArchive } from "./corpus.js";

export type RequestRecord = {
  sampleId: string;
  promptVersion: string;
  schema: string;
  input: Record<string, unknown>;
  evidenceExcerpts: (string | undefined)[];
  context: string[];
  inputCharacters: number;
  contextCharacters: number;
  contextEntries: number;
};

export class ReplayModel implements ReasoningModel {
  sampleId = "";
  readonly requests: RequestRecord[] = [];
  constructor(private readonly archive: SampleArchive) {}
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const sample = this.archive.samples[this.sampleId];
    if (!sample) return Promise.reject(new Error(`No sample selected: ${this.sampleId}`));
    const batch: MeetingAnalysisProposalBatch = batchSchema.parse(
      structuredClone(sample)
    );
    for (const item of [
      ...batch.actionItems,
      ...batch.decisions,
      ...batch.openQuestions,
      ...batch.risks,
      ...batch.followUpIntentions
    ]) {
      item.evidenceIds = item.evidenceIds.map((reference) => {
        if (!reference.startsWith("$")) return reference;
        const evidence = request.evidence[Number(reference.slice(1))];
        if (!evidence)
          throw new Error(
            `Sample ${this.sampleId} references absent Evidence ${reference}`
          );
        return evidence.evidenceId;
      });
    }
    this.requests.push({
      sampleId: this.sampleId,
      promptVersion: request.promptVersion,
      schema: request.schemaName,
      input: structuredClone(request.input),
      evidenceExcerpts: request.evidence.map((reference) => reference.excerpt),
      context: [...request.context],
      inputCharacters: JSON.stringify(request).length,
      contextCharacters: request.context.reduce((sum, value) => sum + value.length, 0),
      contextEntries: request.context.length
    });
    return Promise.resolve({
      value: batch as T,
      metadata: {
        provider: "synthetic",
        model: this.archive.model,
        promptVersion: request.promptVersion
      }
    });
  }
}
