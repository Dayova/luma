/**
 * The single production default for Luma's current OpenAI reasoning
 * capabilities. Capability-specific routing is a separate product decision.
 */
export const DEFAULT_OPENAI_REASONING_MODEL = "gpt-5.6-luna";

/**
 * Resolves the backwards-compatible environment override once at application
 * composition. Blank values intentionally fall back to the documented default.
 */
export function openAIReasoningModelNameFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env["LUMA_REASONING_MODEL_NAME"]?.trim() || DEFAULT_OPENAI_REASONING_MODEL;
}
