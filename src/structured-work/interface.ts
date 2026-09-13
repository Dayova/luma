import type {
  ConcludeStructuredWork,
  ObserveStructuredWork,
  QueryStructuredWork,
  StructuredWorkActor,
  StructuredWorkConversationSubject,
  StructuredWorkAudience,
  StructuredWorkInterpretation,
  StructuredWorkModelInput,
  StructuredWorkSource,
  StructuredWorkState,
  StructuredWorkSubject
} from "../domain/structured-work.js";
import type { WorkspaceConfig } from "../domain/model.js";

export interface StructuredWorkIntelligence {
  observe(
    input: ObserveStructuredWork
  ): Promise<StructuredWorkState & { duplicate: boolean }>;
  query(input: QueryStructuredWork): Promise<StructuredWorkState>;
  conclude(
    input: ConcludeStructuredWork
  ): Promise<{ request: StructuredWorkState; summary: string }>;
}
export interface StructuredWorkEvidenceSource {
  capture(input: {
    workspace: WorkspaceConfig;
    subject: StructuredWorkSubject;
    instructionSubject?: StructuredWorkConversationSubject;
    instruction: string;
    actor: StructuredWorkActor;
    audience: StructuredWorkAudience;
  }): Promise<StructuredWorkSource>;
  requireCurrent(source: StructuredWorkSource): Promise<void>;
}
export interface StructuredWorkInterpreter {
  interpret(
    input: StructuredWorkModelInput,
    access: { requireCurrent(this: void): Promise<void> }
  ): Promise<StructuredWorkInterpretation>;
}
export type ExecuteStructuredWork = {
  workspace: WorkspaceConfig;
  subject: StructuredWorkSubject;
  structuredWorkRequestId: string;
  intentId: string;
};
export interface StructuredWorkExecution {
  execute(input: ExecuteStructuredWork): Promise<StructuredWorkState>;
  recover(input: ExecuteStructuredWork): Promise<StructuredWorkState>;
}
