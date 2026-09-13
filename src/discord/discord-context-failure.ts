import { ContextIntelligenceError } from "../context-intelligence/context-intelligence.js";

export function renderContextVerificationFailure(error: unknown): string | undefined {
  if (!(error instanceof ContextIntelligenceError)) return undefined;
  if (error.code === "context-inquiry-verification-timeout")
    return "Luma’s source check timed out. I could not finish verifying the current sources, so I have not delivered an answer. This does not mean the conversation changed. Please try again shortly; you do not need to narrow your question.";
  if (error.code === "context-inquiry-corrupt")
    return "Luma could not verify its saved answer because of an internal consistency error. This is a Luma error, not a problem with your question.";
  return undefined;
}
