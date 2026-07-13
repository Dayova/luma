# Luma

Luma is a Discord-native AI meeting intelligence system. The repository contains a durable Meeting Intelligence Module, provider-neutral capability Interfaces, a GitHub Issues WorkProvider, Follow-up Execution, and a real Discord Adapter for persistent Meeting threads, commands, summaries, and execution receipts.

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
- `docs/brand.md` documents the Luma brand assets, colors, and UI usage guidance.
- `docs/architecture/design-it-twice.md` compares four architecture candidates.
- `docs/adr/` records architecture decisions.
- `docs/configuration/environment.md` documents environment variables and live integration setup.
- `docs/configuration/identity.md` documents internal Person to provider-account mapping.
- `docs/integrations/github-issues.md` documents the GitHub Issues WorkProvider.
- `docs/integrations/discord.md` documents the Discord bot setup and current commands.
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
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
```

See `docs/configuration/environment.md` for the full variable reference.

With the Discord variables configured, start the development bot with:

```bash
npm run dev
```
