# Architecture Review

> Historical foundation review, recorded on 2026-07-06 in commit `4995c9e`.
> The original findings below describe that foundation slice, not the current
> implementation or production readiness.

## Current-state Clarification — 2026-09-08

Follow-up Execution now persists reservations, staged settlement outcomes,
and recovery state; its original in-instance-only idempotency finding below
is historical. Production provider and Discord SDKs now live behind owned
Adapters, so the original repository-wide import scan is also historical.
Bounded read-only Context Ask and a provider-neutral Logical Meeting binding
foundation have since been added. Granola ingestion and multi-capture
synthesis remain incomplete.

Use the [current delivery boundary](../../README.md#current-delivery-boundary),
[Follow-up Execution](../modules/follow-up-execution.md),
[Context Intelligence](../modules/context-intelligence.md), and
[Logical Meeting ADR](../adr/0008-provider-neutral-logical-meetings.md) for
current scope and limitations. The original review is preserved below.

## Scope

This review covers the first foundation slice: TypeScript setup, domain model, Meeting Intelligence, provider-neutral capability Interfaces, Follow-up Execution, persistence, and behavioural tests.

## Deletion Test

Deleting the Meeting Intelligence Module would force callers to absorb Observation idempotency, Evidence persistence, ReasoningModel proposal validation, reconciliation, transcript correction handling, Human Judgment precedence, Revision management, Conclusion versioning, and receipt event emission. The Module is earning its existence.

Deleting the KnowledgeProvider, WorkProvider, and CodeProvider Interfaces would force provider-specific semantics into Follow-up Execution and future Organizational Context retrieval. These Interfaces sit at true external seams because production Adapters and deterministic test Adapters vary.

## Depth, Leverage, Locality

- Depth: the `observe`, `query`, and `conclude` Interface exercises substantial behaviour without exposing internal model or reconciliation stages.
- Leverage: Discord, future dashboard code, provider sync jobs, and Follow-up Execution can share the same Meeting State semantics.
- Locality: meeting understanding rules are concentrated in Meeting Intelligence rather than spread across command handlers or provider Adapters.

## Leak Scan

Runtime source currently has no imports of Discord SDKs, provider SDKs, MCP/plugin types, OpenAI Agents SDK, LangGraph, Mastra, Vercel AI SDK, or TanStack AI types.

## Unsafe TypeScript Scan

`src` and `tests` currently contain no `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or `TODO` markers.

## Current Friction

- Meeting Intelligence is already large because the first slice keeps the external Interface deep. Future work should split private implementation files only when the split preserves locality.
- Follow-up Execution idempotency is in-instance only. Durable idempotency belongs in a later persistence-backed slice.
- Organizational Context is specified as an Interface but not yet wired into analysis.
- Concurrency strategy is documented but not yet stress-tested with concurrent PGlite transactions.
