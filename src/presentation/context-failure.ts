import { ContextIntelligenceError } from "../context-intelligence/context-intelligence.js";

export function renderContextVerificationFailure(error: unknown): string | undefined {
  if (!(error instanceof ContextIntelligenceError)) return undefined;
  if (error.code === "context-inquiry-verification-timeout")
    return "Luma’s source check timed out. I could not finish verifying the current sources, so I have not delivered an answer. This does not mean the conversation changed. Check usage before trying again; the answer may already have incurred an AI charge.";
  if (error.code === "context-inquiry-corrupt")
    return "Luma could not verify its saved answer because of an internal consistency error. Check the saved request and usage; a founder needs to investigate before another paid attempt.";
  if (
    error.code === "context-inquiry-source-changed" ||
    error.code === "context-inquiry-context-changed"
  )
    return CONTEXT_VERIFICATION_UNCONFIRMED;
  if (
    error.code === "conversation-capture-invalid" ||
    error.code === "conversation-capture-unavailable"
  )
    return "Luma could not capture verified conversation evidence. Check that the source and its original messages are readable by Luma. If they are, a founder should inspect the capture failure before you retry.";
  if (error.code === "context-answer-invalid")
    return "Luma could not validate the generated answer against its evidence. No unverified answer is being displayed. Check usage before another attempt; this is an answer-validation failure.";
  if (
    error.code === "context-answer-unavailable" ||
    error.code === "context-answer-already-attempted"
  )
    return "Luma has no deliverable answer for this saved request and has not repeated the possible paid attempt. Check the saved request and usage before posting a new question for another attempt.";
  if (
    error.code === "context-inquiry-id-conflict" ||
    error.code === "context-inquiry-invalid" ||
    error.code === "context-inquiry-replay-unavailable"
  )
    return "Luma could not validate or recover this request. A founder should inspect any retained record and usage before another attempt; its outcome has not been verified.";
  return undefined;
}

export const CONTEXT_VERIFICATION_UNCONFIRMED =
  "Luma could not verify the current conversation or linked sources, so the answer was withheld. A source may have changed, access may have been lost, or verification may have failed. Check source access and usage before trying a new question; a founder should inspect the diagnostics if it persists.";
