# Notion webhooks in the shared runtime

The optional production listener wakes the main runtime's existing canonical
Notion Meeting Notes source. It uses the same source ledger, Meeting Intelligence,
original-source grants, reasoning adapter and USD 30 AI budget as Discord. It
does not create a second store, model, reconciliation schedule or execution path.
The periodic source scan remains the completeness and recovery backstop; a
webhook provides only a latency hint, never authoritative note content or a write
instruction.

Configure normal canonical source ingestion (`NOTION_API_TOKEN` and
`NOTION_MEETINGS_DATA_SOURCE_ID`) and the dedicated exact-page read capability
and current all-founder sharing policy described in
[imported Meeting understanding](../imported-meeting-understanding.md) first.
The listener refuses startup without that analysis configuration. Adding a
subscription does not grant access to any additional page or audience.

The protected production environment accepts:

- `LUMA_NOTION_WEBHOOK_ENABLED=1` to opt in; the template defaults to `0`.
- `LUMA_NOTION_WEBHOOK_WORKSPACE_ID`, `LUMA_NOTION_WEBHOOK_SUBSCRIPTION_ID` and
  `LUMA_NOTION_WEBHOOK_INTEGRATION_ID`: the reviewed Notion UUIDs. The provider
  workspace must remain distinct from `LUMA_WORKSPACE_ID`.
- `LUMA_NOTION_WEBHOOK_VERIFICATION_TOKEN`: the subscription's HMAC secret.
  Keep it in the protected environment file, outside commands and logs.
- `LUMA_NOTION_WEBHOOK_HTTP_HOST`, `LUMA_NOTION_WEBHOOK_HTTP_PORT`, and
  `LUMA_NOTION_WEBHOOK_HTTP_PATH`: default `127.0.0.1`, `3001`, `/notion/webhook`.

The host must forward the reviewed HTTPS endpoint to that loopback listener
without changing request bytes. HMAC verification binds the original bytes and
the expected workspace, integration and subscription. Page refresh rechecks
canonical source membership; no page content supplied in a webhook is trusted.
This reuses the bounded HTTP host, including body/time limits, duplicate wake-up
handling and sanitized responses. A successful HTTP acknowledgement means the
wake-up was accepted or safely ignored; it does not claim successful analysis.
Operational status exposes pending work and sanitized failures through the app's
`notionObservationStatus()` interface.

The runtime starts one canonical scan schedule. Shutdown immediately stops
Discord admission and webhook intake, drains admitted provider refresh and
analysis, then closes its database. The existing 90-second drain and 120-second
service hard stop apply. A failed drain never creates a clean-close receipt.
Startup failure closes acquired listeners and source schedules.

Keep the old `LUMA_NOTION_OBSERVATION_*` and dormant `LUMA_NATIVE_*` settings out
of this production profile. The standalone observation entrypoint remains an
isolated proof tool; it is not a second production source owner. Native Notion
review ingress remains a separate capability.

The connected regression uses a real loopback HTTP listener and signed bytes,
then refreshes an immutable source through the shared runtime and recalls it
from Discord. It checks duplicate delivery, unsigned refusal, shared AI budget
identity and original/external grant revocation at final delivery. Only external
source and model transports are programmable. No real subscription, live
capture, provider write, HTTPS route or hosting has been activated by these tests.
