Status: ready-for-agent

# Observe and Query Tracer Bullet

## What to build

Implement the first vertical Meeting Intelligence path: observe a mixed-language utterance, persist Evidence, validate deterministic model proposals, reconcile an Action Item, and query the snapshot.

## Acceptance criteria

- [ ] Tests use `meetingIntelligence.observe(...)` and `meetingIntelligence.query(...)`
- [ ] Original speech remains canonical Evidence
- [ ] Owner and deadline are represented without creating provider-specific work
- [ ] Duplicate Observations do not duplicate Evidence or Meeting Items

## Blocked by

01-foundation-and-design
