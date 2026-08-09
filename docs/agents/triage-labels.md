# Triage Labels

Matt Pocock's triage skill requires exactly one category role and one state role on every triaged issue. Use these exact, case-sensitive Linear labels.

## Category Roles

| Role in mattpocock/skills | Linear label  | Meaning                     |
| ------------------------- | ------------- | --------------------------- |
| `bug`                     | `Bug`         | Existing behavior is broken |
| `enhancement`             | `enhancement` | New feature or improvement  |

`Feature`, `Improvement`, and other product labels may coexist, but they do not replace the canonical category role.

## State Roles

| Role in mattpocock/skills | Linear label      | Linear workflow state | Meaning                                   |
| ------------------------- | ----------------- | --------------------- | ----------------------------------------- |
| `needs-triage`            | `needs-triage`    | `Triage`              | Maintainer needs to evaluate the issue    |
| `needs-info`              | `needs-info`      | `Triage`              | Waiting for actionable reporter context   |
| `ready-for-agent`         | `ready-for-agent` | `Todo`                | Fully specified, ready for an AFK agent   |
| `ready-for-human`         | `ready-for-human` | `Todo`                | Requires human implementation or judgment |
| `wontfix`                 | `wontfix`         | `Canceled`            | Will not be actioned                      |

Workflow states record progress after work starts. Keep only one canonical state-role label, replacing it when the triage disposition changes; other non-triage labels may remain.
