# Separate Speaker and Ownership Attribution

Accepted. Speaker Attribution answers who produced an Utterance; Ownership
Attribution answers who, if anyone, is responsible for an Action Item. They are
separate, evidence-grounded claims because a German utterance such as a
proposal, question, or acknowledgement can identify neither responsibility nor
a certain speaker. Source claims remain immutable with their original wording,
basis, confidence, and Evidence. A durable Human Attribution Resolution
overlays the effective result and outranks later inference without rewriting the
source record.

This is deliberately stricter than a single mutable `owner` field or mapping a
source label directly to a Linear account. Only `confirmed` ownership may map
to a Linear user, and only explicitly `intentionally-unassigned` ownership may create work
without an assignee. `proposed` and `unresolved` ownership require targeted
clarification, preventing silent, missing, or falsely certain assignees.
