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
- `docs/configuration/environment.md` documents environment variables and live integration setup.
- `docs/integrations/github-issues.md` documents the GitHub Issues WorkProvider.
- `docs/modules/` documents Module responsibilities and Interfaces.
- `evals/fixtures/meeting-corpus.json` contains the initial evaluation fixture corpus.

## Local Environment

Start from:

```bash
cp .env.example .env
```

For GitHub live validation, either set `GITHUB_TOKEN` in `.env` or export it from the GitHub CLI:

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="owner/repo"
```

See `docs/configuration/environment.md` for the full variable reference.
