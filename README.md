# Luma

Luma is a Discord-native AI meeting intelligence system. The current repository contains the first evidence-first TypeScript foundation: a durable Meeting Intelligence Module, provider-neutral capability Interfaces, and a Follow-up Execution tracer bullet.

## Public Interfaces

```ts
meetingIntelligence.observe(input);
meetingIntelligence.query(input);
meetingIntelligence.conclude(input);
```

The Meeting Intelligence Interface is intentionally small. It hides persistence, Evidence validation, model proposal validation, deterministic reconciliation, Human Judgment precedence, transcript revision handling, and Conclusion versioning.

## Verification

```bash
npm run verify
```

This runs Prettier checks, ESLint, TypeScript type checking, and the behavioural Vitest suite.

## Documentation

- `CONTEXT.md` defines the domain vocabulary.
- `AGENTS.md` defines future coding-agent rules.
- `docs/architecture/design-it-twice.md` compares four architecture candidates.
- `docs/adr/` records architecture decisions.
- `docs/modules/` documents Module responsibilities and Interfaces.
- `evals/fixtures/meeting-corpus.json` contains the initial evaluation fixture corpus.
