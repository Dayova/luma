# Luma

Luma is Dayova's organizational context and execution agent. It turns
conversation Evidence into reconciled organizational reality across Linear
(canonical work), Notion (canonical knowledge and meeting records), and
GitHub (canonical implementation evidence). Its product scope includes
Notion and Granola meeting captures plus Discord conversations, with the
Notion Custom Agent and Discord `@Luma` as interaction surfaces over the
shared Luma core.

The repository currently contains a durable Meeting Intelligence Module,
provider-neutral capability Interfaces, Linear and Notion Adapters,
Follow-up Execution foundations, a persistent Discord Meeting bot, and a
bounded read-only Discord Context Ask slice. A provider-neutral Logical
Meeting foundation can retain separate capture revisions and their durable
bindings. Granola ingestion, multi-capture synthesis, Decision Record
execution, compound execution, and the complete Discord Ask → Verify →
Reconcile → Execute product path remain incomplete.

## Current Delivery Boundary

LUM-2 (Notion Meeting Notes ingestion and observed revisions), LUM-3
(read-only Linear reconciliation), LUM-7/LUM-8 (source-bound settlement and
Operational Outcome writeback), LUM-9 (German speaker and ownership safety),
and LUM-10 (source-bound GitHub implementation references) are complete
foundations. LUM-6 remains open: LUM-11's target-selection and conflict policy
is selected, while its safe, target-bound canonical Notion patch capability
and live proof remain outstanding before the first production-safe meeting
wedge can be complete. The
[operating brief](https://app.notion.com/p/3d52e87228bf817c9c67e015df3ddf23)
records the policy, delivery priorities, and remaining owner decisions.

The LUM-33 Logical Meeting foundation is also implemented. It preserves
capture provenance, capability gaps, and Human binding decisions; it does
not activate Granola access, source collection, synthesis, or provider
writes. See [ADR 0008](docs/adr/0008-provider-neutral-logical-meetings.md) for
the exact boundary.

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
GitHub Actions runs the same command for pull requests and pushes to `main`.

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

Run deterministic local verification with:

```bash
pnpm verify
```

The networked Discord bot is deliberately not a current Dayova setup step. Do
not configure or start `pnpm dev` with a Dayova or shared Discord Application
until the [LUM-4 activation gate](docs/integrations/discord.md#lum-4-activation-gate)
is satisfied: its owner has recorded all four policy decisions and the required
follow-up implementation is delivered. Technical configuration, gateway
intents, and allowlists are necessary controls, not authorization.
