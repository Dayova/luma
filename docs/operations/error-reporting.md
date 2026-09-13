# User-facing failure reporting

Luma reports what it could establish, the effect on the request, and a useful next
step. An unknown exception is not evidence of a provider outage, edited source,
missing key, invalid user question, or an unapplied external change.

## Current handling

| Failure                            | Explanation and next step                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Source verification timeout        | Verification exceeded its deadline; the answer is withheld. Check usage before another attempt.                                             |
| Source/access proof failed         | Current evidence could not be verified. Changed content, lost access and a failed check remain possibilities. Check access and diagnostics. |
| Saved-answer inconsistency         | Luma could not verify its record. Investigate before another paid attempt.                                                                  |
| Invalid answer or citation         | Luma could not validate its answer; unverified claims are withheld. Check usage and answer diagnostics.                                     |
| AI setup/access                    | Check credentials, model access, verified pricing and accounting holds. A loaded key does not establish successful authorization.           |
| Unknown AI failure                 | Cause remains unconfirmed. Check pending charges and diagnostics before retrying.                                                           |
| Local malformed JSON or body limit | Input was rejected before starting a command. The HTTP response is 400 and excludes submitted content.                                      |
| Unexpected local server exception  | Outcome is unverified. The HTTP response is 500, excludes exception text, and asks the reader to inspect saved state and usage.             |
| Workflow budget/attempt limit      | No new call was admitted; earlier attempts can have costs. Review the workflow before another request.                                      |
| Input limit                        | Full input includes retrieved evidence. Do not assume the question itself caused the limit.                                                 |
| Reply rendering limit              | Luma cannot display the generated answer. Treat this as output handling, not a reason to blame the question.                                |

Shared presentation functions keep immediate AI and context failures consistent
between Discord and the local page. Durable note receipts retain their separate
analysis outcomes. Decision Record and structured-work failures direct users to
operation status before another write; they do not assert that a failed or
ambiguous write had no effect.

## Review checks

- Establish the cause from a typed failure or explicit evidence; otherwise say
  that it is unconfirmed.
- Keep retry guidance sensitive to retained results, unknown charges and possible
  external changes. Do not automatically repeat a paid request or write.
- Keep raw provider exceptions, credentials and conversation contents out of
  failure responses.
- Preserve freshness, audience checks, original evidence and spending records.
- Test classification through the relevant request/delivery surface, including
  unknown failures and secret-bearing exceptions.

The September 2026 audit covered the Discord Ask/DM/command error paths, AI
budget and provider normalization, local session/HTTP errors, and the status
advice for Decision Records and structured work. This is not a guarantee that
every future failure will have a precise cause. Missing diagnostics and failures
that prevent Discord delivery itself still require operator investigation.

Known limitation: the scoped Meeting answer renderer still has a size fallback;
it now describes the output limitation honestly. This audit did not add a new
large-answer delivery mechanism to that command.
