# Luma

Luma is Dayova's organizational context and execution agent. Its language
describes durable, evidence-grounded understanding and execution across
conversation sources, canonical work in Linear, canonical knowledge and raw
Meeting Notes in Notion, and implementation evidence in GitHub. Meetings are
the first narrow vertical; Discord chats and threads are also first-class
sources and interaction surfaces over the shared Luma core.

## Language

**Meeting**:
A time-bounded team conversation whose evidence and follow-up can continue evolving after the live call ends.
_Avoid_: Call, recording, session

**Observation**:
An idempotently ingestible fact that may affect Meeting understanding.
_Avoid_: Event, webhook, transcript row

**Utterance**:
A versioned piece of original speech with a Speaker Attribution claim and a time range.
_Avoid_: Transcript line, message

**Evidence**:
A stable, addressable, version-aware source capable of supporting a claim.
_Avoid_: Citation, source text

**Human Judgment**:
An explicit participant confirmation, rejection, correction, merge, split, or override that always outranks later model inference.
_Avoid_: Feedback, annotation

**Person**:
An internal participant identity that can be linked to provider-specific accounts such as Discord users, GitHub logins, Atlassian accounts, Notion users, and Linear users.
_Avoid_: Display name, account

**Speaker Attribution**:
A claim about which Person produced an Utterance, retaining its basis, confidence, and Evidence. It answers who spoke; it does not establish responsibility for work.
_Avoid_: Speaker identity, inferred owner

**Ownership Attribution**:
A claim about which Person, if any, is responsible for an Action Item, retaining its basis, confidence, and Evidence. It is distinct from Speaker Attribution: a participant can mention, propose, or ask another Person to do work without that Person owning it.
_Avoid_: Speaker attribution, assignee guess

**Attribution Claim**:
An immutable, Evidence-grounded statement about a speaker or an Action Item owner as supplied by a source or inference.
_Avoid_: Mutable owner field, resolved fact

**Attribution Resolution**:
A durable Human Judgment overlay that confirms, corrects, intentionally unassigns, or keeps an Attribution Claim unresolved without altering the original claim.
_Avoid_: Source rewrite, feedback

**Meeting Item**:
A structured part of the Meeting understanding, such as a topic, proposal, decision, action item, open question, or risk.
_Avoid_: Extract, insight, bullet

**Decision**:
A Meeting Item describing a choice considered or made.
_Avoid_: Agreement, conclusion

**Action Item**:
A Meeting Item describing work with Ownership Attribution, deadline, status, Evidence, and an optional external work representation.
_Avoid_: Task, todo

**Imported Action Item Candidate**:
A source-derived proposal for possible work that retains its original wording, modality, uncertainty, and source Evidence until Human Judgment resolves it.
_Avoid_: Confirmed Action Item, task

**Ownership State**:
The effective state of an Ownership Attribution: `confirmed`, `proposed`, `intentionally-unassigned`, or `unresolved`. Only a confirmed owner may map to a Linear user; only a Human-intentionally-unassigned item may be created without one.
_Avoid_: Missing owner, best-effort assignee

**Action Item Reconciliation**:
A reviewable, immutable proposal that relates an Imported Action Item Candidate to canonical work as an existing link, an update, genuinely new work, not work, or a clarification need. Its current view may be blocked by a competing candidate until Human Judgment resolves it.
_Avoid_: Automatic task creation, duplicate detector

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
