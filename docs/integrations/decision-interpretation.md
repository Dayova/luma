# Decision interpretation

The production `DecisionInterpreter` uses the configured OpenAI reasoning model
and the same durable AI budget as Meeting analysis and Context Ask. Its usage is
recorded as `decision-interpretation`. It performs one bounded Responses request,
with provider retries disabled, storage disabled and the verified standard tier.
Monthly limits, uncertain charges, input/output bounds and provider failures use
the shared accounting and Discord service-status behavior.

The model receives the eligible original source, current authority snapshot and a
compact complete canonical record catalog. It proposes a grounded candidate and
reconciliation action. The owned Decision Intelligence module separately checks
actual authority, Human acceptance, ambiguity and write authorization. The model
cannot write records or manufacture authority. Polls remain advisory; provisional
roles, disputed proposals and mixed German/English modality remain explicit.

Strict structured output is validated again by Luma. Claims must cite known
source evidence; people, scope and target identities must be supplied in eligible
context. Related work and code references use opaque keys resolved from supplied
references, preventing model-invented URLs or provider identities. An unknown
reference or malformed result is rejected after accounting for the provider's
actual usage. The telemetry ledger stores hashes and billing facts, not source
prose or prompts.

Tests use deterministic model responses and the real shared budget, plus a mocked
HTTP boundary under the pinned OpenAI SDK. They establish accounting, reference
validation and request behavior. They do not establish real-model decision
quality; that still requires the opt-in live evaluation before activation.

The wire format follows the official
[Structured Outputs contract](https://developers.openai.com/api/docs/guides/structured-outputs):
an object at the root, required fields, explicit nulls and no extra properties.
