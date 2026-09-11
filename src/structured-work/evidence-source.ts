import { createConversationDecisionEvidenceSource } from "../decision-intelligence/conversation-evidence-source.js";
import { createImportedMeetingDecisionEvidenceSource } from "../decision-intelligence/imported-meeting-evidence-source.js";
import type { StructuredWorkEvidenceSource } from "./interface.js";
import { structuredWorkSourceSchema } from "./schemas.js";
import { operationDigest } from "./persistence.js";

/** Original capture verification is shared; no Decision requests or records are created. */
export function createStructuredWorkEvidenceSource(input: {
  conversation: Omit<
    Parameters<typeof createConversationDecisionEvidenceSource>[0],
    "capturePurpose"
  >;
  importedMeetings?: Parameters<typeof createImportedMeetingDecisionEvidenceSource>[0];
}): StructuredWorkEvidenceSource {
  const conversation = createConversationDecisionEvidenceSource({
    ...input.conversation,
    capturePurpose: "structured-work"
  });
  const meetings = input.importedMeetings
    ? createImportedMeetingDecisionEvidenceSource(input.importedMeetings)
    : null;
  const source: StructuredWorkEvidenceSource = {
    async capture(request) {
      request = structuredClone(request);
      if (request.subject.type === "conversation-thread") {
        if (request.instructionSubject)
          throw new Error("A Conversation cannot select a separate instruction");
        const captured = structuredWorkSourceSchema.parse(
          await conversation.capture(request)
        );
        await source.requireCurrent(captured);
        return captured;
      }
      if (!meetings || !request.instructionSubject)
        throw new Error(
          "Select the actual imported Meeting and original authenticated command"
        );
      const instruction = await conversation.capture({
        ...request,
        subject: request.instructionSubject
      });
      if (instruction.subject.type !== "conversation-thread")
        throw new Error("The original command was not a Conversation");
      const imported = await meetings.capture(request);
      const captured = structuredWorkSourceSchema.parse({
        ...imported,
        instructionSource: instruction
      });
      await source.requireCurrent(captured);
      return captured;
    },
    async requireCurrent(value) {
      const captured = structuredWorkSourceSchema.parse(value);
      if (operationDigest(captured) !== operationDigest(value))
        throw new Error("The exact original structured source was changed");
      const { instructionSource, ...original } = captured;
      if (original.subject.type === "conversation-thread") {
        if (instructionSource) throw new Error("Unexpected alternate command source");
        await conversation.requireCurrent(original);
      } else {
        if (!meetings || !instructionSource)
          throw new Error("The original Meeting command proof is missing");
        await conversation.requireCurrent(instructionSource);
        await meetings.requireCurrent(original);
        // Revalidate the command after the imported provider proof's async reads.
        await conversation.requireCurrent(instructionSource);
      }
    }
  };
  return source;
}
