Status: ready-for-agent

# Follow-up Execution Tracer Bullet

## What to build

Implement provider-independent Follow-up Intent approval and an execution success path through KnowledgeProvider or WorkProvider Adapters.

## Acceptance criteria

- [ ] Approved intents can be executed idempotently
- [ ] Execution results are recorded as Observations
- [ ] Discord receipt events are provider-independent
- [ ] Partial failure preserves created links and failure reason

## Blocked by

03-corrections-and-human-judgment
