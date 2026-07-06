# Luma

Luma is a Discord-native AI meeting intelligence system. Its language describes durable, evidence-grounded meeting memory and approved follow-up across Discord, knowledge providers, work providers, and code providers.

## Language

**Meeting**:
A time-bounded team conversation whose evidence and follow-up can continue evolving after the live call ends.
_Avoid_: Call, recording, session

**Observation**:
An idempotently ingestible fact that may affect Meeting understanding.
_Avoid_: Event, webhook, transcript row

**Utterance**:
A versioned piece of original speech attributed to a participant and a time range.
_Avoid_: Transcript line, message

**Evidence**:
A stable, addressable, version-aware source capable of supporting a claim.
_Avoid_: Citation, source text

**Human Judgment**:
An explicit participant confirmation, rejection, correction, merge, split, or override.
_Avoid_: Feedback, annotation

**Meeting Item**:
A structured part of the Meeting understanding, such as a topic, proposal, decision, action item, open question, or risk.
_Avoid_: Extract, insight, bullet

**Decision**:
A Meeting Item describing a choice considered or made.
_Avoid_: Agreement, conclusion

**Action Item**:
A Meeting Item describing work that may have an owner, deadline, status, evidence, and external work representation.
_Avoid_: Task, todo

**Meeting State**:
The current, revisable understanding of a Meeting at a specific Revision.
_Avoid_: Projection, snapshot

**Revision**:
A monotonically increasing version of committed Meeting understanding.
_Avoid_: Version, checkpoint

**Conclusion**:
A versioned post-Meeting representation containing summaries, decisions, action items, questions, risks, participant briefs, and follow-up intentions.
_Avoid_: Summary, minutes

**Follow-up Intent**:
A provider-independent description of an external mutation the system recommends or is approved to perform.
_Avoid_: Tool call, provider request

**Execution Record**:
The recorded outcome of attempting an approved Follow-up Intent.
_Avoid_: Result, receipt

**External Activity**:
A provider-normalized event connected to a Meeting Item, external object, or Follow-up.
_Avoid_: Webhook payload, provider event

**Organizational Context**:
Permission-filtered, normalized knowledge, work, code, and previous-Meeting information retrieved to understand or answer questions about a Meeting.
_Avoid_: RAG result, search result
