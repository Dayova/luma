# Provider-neutral Logical Meetings

Accepted. Luma represents one real-world Meeting with a Luma-owned Logical Meeting identity and keeps each connection-scoped, provider-specific Meeting Capture revision separate. A durable Capture Binding records the deterministic matching evidence or Human Judgment that relates them, so neither a provider ID nor a title-only guess can silently become the meeting's identity.

LUM-33 deliberately leaves LUM-2's Notion Meeting Notes source and observed-source ledger as the durable raw-source and revision boundary. The binding layer stores provenance-bearing descriptors rather than raw source material, does not replay historical source Observations, and does not activate webhook, scheduled, or provider runtime work. It also performs no Notion, Linear, GitHub, or other external write. LUM-2 does not persist the authenticated account that performed a canonical Notion read, so the current Notion bridge can attest only a trusted composition-owned canonical source scope—not a person's connection. A future personal-provider adapter must archive an attested connection scope with its capture revision.

## Considered Options

- Use the provider capture ID as the Meeting ID. This cannot represent independent captures of the same real-world Meeting and would entrench the first provider as canonical.
- Correlate captures inside each provider adapter. This would duplicate matching and Human-correction policy, while losing a common durable relationship across providers.
- Store a universal merged transcript or rewrite the LUM-2 ledger. This would blur raw-source provenance, invent material a provider did not expose, and compromise the existing immutable source-revision boundary.

## Consequences

Later synthesis may consume active Capture Bindings to form a Luma Synthesis, but it must preserve per-capture provenance, capability gaps, and disagreement; it must never present a concatenated provider artifact as original speech. A withheld revision records only a minimal opaque eligibility watermark. A later private/policy decision for the same source revision is an append-only terminal withdrawal: it fences current admission without rewriting the earlier importable decision or Human-import audit, and it prevents delayed older deliveries from reactivating private material. An ambiguous or `requires-human-import` revision can enter only through an actor-attested exact-revision import; a private/policy exclusion cannot be overridden there. A later current revision re-checks every automatic binding, including a former high-confidence match, while preserving its history; Human bindings and separations remain authoritative. A compact Operational Outcome remains a distinct, authorized execution/writeback record rather than a raw source or Luma Synthesis. Full capture-graph topology, runtime activation, and external writes remain outside this decision.
