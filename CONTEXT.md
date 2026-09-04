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

**Logical Meeting**:
A Luma-owned, provider-neutral identity for one real-world Meeting that can relate independently observed Meeting Captures without making any provider capture canonical.
_Avoid_: Provider meeting, source page, transcript

**Meeting Capture**:
A connection-scoped, provider-specific record of material observed about a Meeting, retaining its capability, availability, eligibility, and source provenance across immutable Capture Revisions.
_Avoid_: Logical Meeting, merged transcript, universal meeting record

**Capture Revision**:
An immutable version of a Meeting Capture whose content, capability, availability, eligibility, and source provenance describe exactly what that provider exposed at that time. A later private/policy eligibility withdrawal is an append-only admission fence, not a rewrite of that revision.
_Avoid_: Rewritten source, inferred transcript, current truth

**Capture Binding**:
A durable Luma relationship between a Meeting Capture and a Logical Meeting, carrying deterministic matching evidence or Human Judgment and never rewriting the capture's provider source.
_Avoid_: Automatic merge, source rewrite, deduplication guess

**Conversation**:
An ordered, bounded, provider-native discussion that Luma can preserve as Evidence without treating it as a Meeting or creating a Meeting Note.
_Avoid_: Meeting, transcript dump, chat log

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

**Luma Synthesis**:
A provider-neutral, Evidence-grounded understanding of a Logical Meeting that retains each contributing capture's provenance, capability gaps, and uncertainty rather than fabricating a combined raw transcript.
_Avoid_: Transcript merge, source replacement, Operational Outcome

**Revision**:
A monotonically increasing version of committed Meeting understanding.
_Avoid_: Version, checkpoint

**Conclusion**:
A versioned post-Meeting representation containing summaries, decisions, action items, questions, risks, participant briefs, and follow-up intentions, which may be informed by a Luma Synthesis.
_Avoid_: Raw source note, Operational Outcome, minutes

**Follow-up Intent**:
A provider-independent description of an external mutation the system recommends or is approved to perform.
_Avoid_: Tool call, provider request

**Execution Record**:
The recorded outcome of attempting an approved Follow-up Intent.
_Avoid_: Result, receipt

**Operational Outcome**:
A compact Luma-owned record of authorized reconciliation and execution against canonical organizational surfaces, distinct from raw Meeting Captures and a Luma Synthesis.
_Avoid_: Meeting Notes, source evidence, synthesis

**External Activity**:
A provider-normalized event connected to a Meeting Item, external object, or Follow-up.
_Avoid_: Webhook payload, provider event

**Organizational Context**:
Permission-filtered, normalized knowledge, work, code, and prior Luma information retrieved to understand or answer questions about a Meeting or Conversation.
_Avoid_: RAG result, search result
