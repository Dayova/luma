# Matt Pocock Skill Maintenance

Luma follows the complete current upstream `mattpocock/skills` set. The repository lock records the reproducible upstream inventory; the user-level installation lives in Codex's documented `$HOME/.agents/skills` location.

## Policy

- Track the current upstream set as a unit. Removed or deprecated upstream skills do not remain merely because an older lock named them.
- Preserve each skill's upstream explicit or implicit invocation policy.
- Keep Luma-specific provider behavior in `docs/agents/issue-tracker.md`, triage mappings in `docs/agents/triage-labels.md`, and domain behavior in `docs/agents/domain.md`.
- Review the installer's security assessment and the upstream diff before accepting an update.

## Update Workflow

1. Review the upstream changes and list the skills currently offered by `mattpocock/skills`.
2. Check for a project-local generated copy before changing the global installation:

   ```sh
   npx skills list --json
   ```

   The expected Luma result is an empty array. A generated `./.agents/skills` tree shadows the user-level installation and must not remain active. First confirm that it contains only the old generated upstream copy, then preserve it recoverably outside the repository before continuing:

   ```sh
   backup_dir="$HOME/.agents/backups/Luma-project-skills-$(date +%Y%m%dT%H%M%SZ)"
   mkdir -p "$HOME/.agents/backups"
   mv .agents "$backup_dir"
   npx skills list --json
   ```

   Do not delete or move an intentionally authored project skill without first migrating it to a tracked, explicitly owned location. Luma does not use ignored `./.agents/skills` as a runtime source.

3. Install or refresh the reviewed Matt Pocock source explicitly, rather than relying on the CLI's project default:

   ```sh
   npx skills add mattpocock/skills --global --agent codex --skill '*' --yes --copy
   ```

   This keeps `$HOME/.agents/.skill-lock.json` as the provenance record. Do not run `npx skills update --global` for this workflow: it updates every installed global source, including sources that were not part of this review.

4. In a clean temporary Git repository, run `npx skills add mattpocock/skills --agent codex --skill '*' -y --copy` and use its generated `skills-lock.json` to refresh the repository lock. This temporary command deliberately creates a project copy only to produce the committed reproducibility artifact.
5. Keep generated `.agents/skills` copies out of this repository; the committed lock is the reproducibility record, while the global installation supplies runtime files.
6. Revalidate every category and state label against the live Luma team, plus the child, blocker, assignee, and state operations used by Wayfinder.
7. Confirm `npx skills list --json` is empty, `npx skills list --global --json` has the expected current `mattpocock/skills` inventory, the lock inventory matches it, and each installed skill has a `SKILL.md` with `name` and `description`.

Restart Codex only if a successfully installed or updated skill does not appear on the next turn.
