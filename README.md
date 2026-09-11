# Luma

Luma is Dayova's organizational context and execution agent. It turns
conversation Evidence into reconciled organizational reality across Linear
(canonical work), Notion (canonical knowledge and meeting records), and
GitHub (canonical implementation evidence). Its product scope includes
Notion and Granola meeting captures plus Discord conversations, with the
Notion Custom Agent and Discord `@Luma` as interaction surfaces over the
shared Luma core.

The shared runtime implements durable Meeting Intelligence, permission-aware
organizational retrieval, Notion and Granola capture, multi-capture synthesis,
founder Decision Records, advisory Discord polls, and approved Linear/Notion
follow-up execution. Discord commands share the same database and monthly AI
budget. Raw evidence and Human decisions are retained; current and historical
knowledge are selected explicitly.

## Delivery And Activation

The production launcher, deployment checks, encrypted recovery tooling, and
capability health reporting are implemented. Configurable provider capabilities
include exact canonical Notion patches, compound Hypothesis/Linear work,
automatic Decision processing under owner standing permission, and source-bound
Meeting recall across prior Meetings. See the
[production runbook](docs/operations/production-discord.md),
[structured-work guide](docs/structured-work.md), and
[Decision guide](docs/integrations/discord-decision-records.md).

Implementation and offline validation do not prove live deployment. Production
activation still requires the dedicated application and provider credentials,
reviewed founder/source grants and notices, the selected host, and real
restart/restore/provider verification. Granola access requires each owner's
OAuth connection. Optional native Notion review has additional provider access
requirements documented in its integration guide. The
[operating brief](https://app.notion.com/p/3d52e87228bf817c9c67e015df3ddf23)
records the product contract; current deployment evidence belongs in the
operating plan and tracker.

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

Live Discord startup registers commands and connects to the configured server.
Use the [production runbook](docs/operations/production-discord.md) and record the
source grants, participant notice and deployment checks before enabling the
corresponding capabilities. Development credentials are not production
credentials. Disabled capabilities retain their stored history.
