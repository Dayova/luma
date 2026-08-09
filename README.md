# Luma

Luma is Dayova's organizational context and execution agent. It turns
conversation Evidence into reconciled organizational reality across Linear
(canonical work), Notion (canonical knowledge and raw Meeting Notes), and
GitHub (canonical implementation evidence). Notion Meeting Notes and Discord
conversations are first-class sources; the Notion Custom Agent and Discord
`@Luma` are surfaces over the same shared Luma core.

The repository currently contains a durable Meeting Intelligence Module,
provider-neutral capability Interfaces, Linear and Notion Adapters,
Follow-up Execution foundations, a persistent Discord Meeting bot, and a
bounded read-only Discord Context Ask slice. It does not yet implement the
complete Discord Ask → Verify → Reconcile → Execute product path.

## Current Delivery Boundary

LUM-2 (Notion Meeting Notes ingestion and observed revisions) and LUM-3
(read-only Linear reconciliation) are complete foundations. LUM-9 is the
current German speaker-attribution and Action Item-ownership safety P0 before
the meeting wedge can be called production-safe. LUM-6, LUM-7, and LUM-8—the
approved settlement, durable execution, and compact Operational Outcome
writeback work—remain incomplete.

## Public Interfaces

```ts
meetingIntelligence.observe(input);
meetingIntelligence.query(input);
meetingIntelligence.conclude(input);
```

The Meeting Intelligence Interface is intentionally small. It hides persistence, Evidence validation, model proposal validation, deterministic reconciliation, Human Judgment precedence, transcript revision handling, and Conclusion versioning.

## Verification

```bash
pnpm verify
```

This runs Prettier checks, ESLint, TypeScript type checking, and the behavioural Vitest suite.

## License

Luma is available under the [MIT License](LICENSE).

## Toolchain

Luma uses `pnpm@11.12.0`. Its strict dependency layout catches undeclared dependencies, while its workspace support leaves room for provider Adapters to become separate packages without changing package managers. Node.js 24 or newer and Corepack are required.

```bash
corepack enable
pnpm install --frozen-lockfile
```

The `packageManager` field in `package.json` lets Corepack select the correct pnpm version automatically.

## Documentation

- `CONTEXT.md` defines the domain vocabulary.
- `AGENTS.md` defines future coding-agent rules.
- `docs/brand.md` documents the Luma brand assets, colors, and UI usage guidance.
- `docs/architecture/design-it-twice.md` compares four architecture candidates.
- `docs/adr/` records architecture decisions.
- `docs/configuration/environment.md` documents environment variables and live integration setup.
- `docs/configuration/identity.md` documents internal Person to provider-account mapping.
- `docs/integrations/linear.md` documents the canonical Linear WorkProvider.
- `docs/integrations/notion.md` documents the canonical Notion KnowledgeProvider.
- `docs/integrations/github-issues.md` documents the compatibility GitHub Issues WorkProvider.
- `docs/integrations/discord.md` documents the Discord bot setup and current commands.
- `docs/modules/` documents Module responsibilities and Interfaces.
- `evals/fixtures/meeting-corpus.json` contains the initial evaluation fixture corpus.

## Local Environment

Start from:

```bash
cp .env.example .env
```

For approved external follow-up, configure Linear and Notion in `.env`. GitHub live validation can use a token exported from the GitHub CLI:

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
```

See `docs/configuration/environment.md` for the full variable reference.

With the Discord variables configured, start the development bot with:

```bash
pnpm dev
```
