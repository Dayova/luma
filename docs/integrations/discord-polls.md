# Discord poll Evidence

Context Ask captures native polls inside the same admitted public thread and
history boundary as its triggering founder mention. A fresh creator identity must
map to an admitted founder, or to this authenticated Luma bot. Other bots,
webhooks, unsupported poll layouts and unreadable polls make the capture partial;
partial captures do not dispatch the answer model. The surrounding discussion,
including objections, remains original Evidence.

The retained poll includes the original question, stable option IDs and wording
or emoji, multi-select setting, expiry, and observed aggregate results. Human
wording is distinguished from Luma-generated wording. The snapshot stores its
observation time and content hash. No poll counts grant execution authority, prove
founder participation, establish a quorum, or settle a disputed decision. An
expired poll is not necessarily finalized. Multi-select vote totals are not voter
counts. This path does not fetch voter identities.

[Discord's Poll API](https://docs.discord.com/developers/resources/poll) can omit
results. The capture preserves that as unknown instead of using discord.js's
default zero counts. Malformed counts, duplicate IDs or foreign option IDs also
produce unknown results. Zero is justified only for an omitted known option in a
valid results payload. A finalized flag is used only when Discord actually returns
it. The raw REST message identity, author, original text and edit timestamp must
match the bounded SDK read.

Each history page admits at most ten fresh poll reads within the existing message
and character caps. Poll JSON counts against the character budget. Each read has
a five-second cancellation race, including REST queue waits; a delayed response
cannot turn an incomplete capture into a complete one. Oversized anchor content
is refused before scanning history. Live channel-audience checks still bracket
capture and final delivery.

Replaying an answer rechecks the same source boundary, including poll state. A
changed result, deleted poll, unsupported fresh read or lost access withholds the
old answer without another paid model call. Original snapshots remain retained.
The `context-ask-v3` instructions tell the answerer to distinguish advisory tallies,
explicit objections, Human Judgment and decision ownership, and to cite the
relevant poll and discussion. Provider content remains input evidence, separate
from higher-priority instructions, following the
[OpenAI prompt guidance](https://developers.openai.com/api/docs/guides/prompt-engineering#message-roles-and-instruction-following).

This implementation is read-only. Autonomous poll publication, verified Dayova
Team role mentions, Decision Records, broader channel observation and durable
unknown-send recovery are separate work. Deterministic tests prove capture,
normalization, budget bounds and replay behavior; live model quality and actual
Discord activation have not been measured by those tests.
