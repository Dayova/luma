# Matt Pocock Skill Maintenance

Luma follows the complete current upstream `mattpocock/skills` set. The repository lock records the reproducible upstream inventory; the user-level installation lives in Codex's documented `$HOME/.agents/skills` location.

## Policy

- Track the current upstream set as a unit. Removed or deprecated upstream skills do not remain merely because an older lock named them.
- Preserve each skill's upstream explicit or implicit invocation policy.
- Keep Luma-specific provider behavior in `docs/agents/issue-tracker.md`, triage mappings in `docs/agents/triage-labels.md`, and domain behavior in `docs/agents/domain.md`.
- Review the installer's security assessment and the upstream diff before accepting an update.

## Update Workflow

1. Review the upstream changes and list the skills currently offered by `mattpocock/skills`.
2. Update the global installation with the current skills CLI so `$HOME/.agents/.skill-lock.json` retains GitHub provenance.
3. In a clean temporary Git repository, run `npx skills add mattpocock/skills --agent codex --skill '*' -y --copy` and use its generated `skills-lock.json` to refresh the repository lock.
4. Keep generated `.agents/skills` copies out of this repository; the committed lock is the reproducibility record, while the user installation supplies the runtime files.
5. Revalidate every category and state label against the live Luma team, plus the child, blocker, assignee, and state operations used by Wayfinder.
6. Confirm the lock inventory matches the installed upstream inventory and that each skill has a `SKILL.md` with `name` and `description`.

Restart Codex only if a successfully installed or updated skill does not appear on the next turn.
