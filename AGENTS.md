# Agent Instructions

## Agent skills

### Issue tracker

Linear is the canonical tracker for executable work. GitHub Issues are compatibility mirrors where the Dayova sync creates them. See `docs/agents/issue-tracker.md`.

### Triage labels

The default Matt Pocock triage vocabulary maps onto Linear workflow states and labels. See `docs/agents/triage-labels.md`.

### Matt Pocock skill updates

When installing or updating `mattpocock/skills`, refresh the lock and revalidate the Linear triage and Wayfinder compatibility overlay. See `docs/agents/matt-pocock-skills.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and root `docs/adr/`. See `docs/agents/domain.md`.

## Architecture Rules

- Treat Meeting Intelligence as the deepest Module in the system.
- Its public Interface is `observe`, `query`, and `conclude`.
- Do not expose extraction stages such as topic extraction, action extraction, summary generation, context retrieval, or reconciliation as caller-orchestrated public Interfaces.
- Test observable behaviour through public Interfaces.
- Do not import Discord SDKs, provider SDKs, MCP/plugin types, or agent framework types into public domain models.
- Keep Confluence/Notion behind the KnowledgeProvider Interface.
- Keep GitHub Issues/Linear behind the WorkProvider Interface.
- Keep GitHub code context behind the CodeProvider Interface; Linear and Notion do not replace GitHub code context.
- Put model SDKs and Agent SDKs behind owned ports. They must not define Meeting Intelligence state.
- Original speech is canonical Evidence. Translations are presentation and retrieval aids.
- Human Judgment outranks AI inference.
- External mutations require approved Follow-up Intents.

## How To Test

- Prefer behavioural tests through `meetingIntelligence.observe(...)`, `meetingIntelligence.query(...)`, and `meetingIntelligence.conclude(...)`.
- Use deterministic programmable Adapters for true external dependencies.
- Use realistic persistence behaviour where uniqueness, transactions, and revisions matter.
- Do not assert private helper call order or prompt text.

## Adding Observation Types

- Add the domain type in `src/domain/model.ts`.
- Add deterministic validation and reconciliation in the Meeting Intelligence Implementation.
- Add behavioural tests through the Meeting Intelligence Interface.
- Preserve idempotency by `observationId`.

## Adding Provider Adapters

- Implement the provider-neutral capability Interface first.
- Keep provider IDs and external references opaque to Meeting Intelligence.
- Add a test Adapter and a production Adapter together when the seam is real.

## Adding Follow-up Intents

- Add a provider-independent Follow-up Intent type.
- Teach Follow-up Execution how to map the intent to the active provider capability.
- Record the outcome as a `follow-up-execution-recorded` Observation.
- Emit provider-independent receipt events for Discord rendering.

## Multilingual Behaviour

- Preserve German, English, and mixed German-English source utterances.
- Never normalize modality away: `might` is not `will`, and `could` is not `must`.
- Preserve technical terms, repository names, branch names, issue identifiers, PR identifiers, framework names, and code identifiers.
- Normalize relative dates using the workspace timezone, not the machine timezone.
