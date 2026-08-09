# Issue Tracker: Linear

Linear is the canonical tracker for executable Luma work. Use the Luma team and a `LUM-<number>` identifier in branches, commits, implementation notes, and status reporting. The Dayova team remains the home for non-Luma company work and legacy issues; do not create new Luma work there.

## Provider Ownership

- Create and update Luma tasks in the Luma Linear team.
- Store specifications, Meeting records, decisions, and durable context in Notion.
- Use GitHub for code, pull requests, review, CI, and releases.
- Treat GitHub Issues created by the Linear sync as compatibility mirrors. Do not independently create or update both sides of one task.

DAY-39 and GitHub #20 record the task-pipeline migration. DAY-175 records the provider ownership rule.

## Linear Operations

Use the connected Linear app for tracker operations:

- **Create or update**: use `save_issue`; pass `team: "Luma"` when creating.
- **Read**: use `get_issue`, including relations when blockers, children, duplicates, or related work matter.
- **List**: use `list_issues` scoped to the Luma team and the narrowest useful state, label, parent, assignee, or query filter.
- **Comment**: use `create_comment`; read existing discussion with `list_comments` before adding context.
- **Label**: read the issue first, then pass the complete intended label set to `save_issue` because `labels` replaces the existing set.
- **Close**: use `Done` for completed work and `Canceled` for rejected or `wontfix` work.

Resolve users against the Luma team. The connector account is not necessarily the Luma owner, so do not treat `me` as the assignee without checking.

## Pull Requests as a Triage Surface

**PRs as a request surface: no.** GitHub pull requests are code and review artifacts, not the canonical request queue. Triage the corresponding Luma issue. Inspect a pull request directly only when the user names it or the Luma issue links it.

A bare `LUM-<number>` always means a Linear issue. A bare GitHub `#<number>` is not a Luma issue identifier.

## Skill Publishing Rules

- When a skill says **publish a spec**, store the durable full specification in Notion and create or update one Luma issue with the execution summary, acceptance criteria, and Notion link.
- When a skill says **publish tickets**, create one Luma issue per ticket in dependency order. Use native parent and blocking relationships and apply the mapped `ready-for-agent` label when appropriate.
- When a skill says **fetch the relevant ticket**, read the full Linear issue, comments, labels, status, and relations.

## Wayfinding Operations

Used by `$wayfinder`. The map and its tickets are Linear issues in the Luma team.

- **Map**: create one issue labelled `wayfinder:map`. Its description holds Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket**: create an issue with `parentId` set to the map and exactly one type label: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: set native `blockedBy` or `blocks` relations. Use `removeBlockedBy` or `removeBlocks` when a decision invalidates an edge.
- **Frontier**: list the map's children, exclude completed or canceled issues, fetch relations, then keep only unassigned issues with no open blockers. Preserve the map's intended order when choosing the first result.
- **Claim**: assign the active Luma owner before any work and move the ticket to `In Progress`. Verify the user against the Luma team rather than assuming the connector identity.
- **Resolve**: post the answer as a comment, move the ticket to `Done`, append a one-line linked context pointer under the map's Decisions so far, and then create or rewire newly visible tickets.

## Agent Workflow

1. Find or create the Linear issue before substantial implementation.
2. Move it to In Progress when work begins.
3. Link related decisions or source issues rather than duplicating their content.
4. Add a concise implementation and verification comment when the slice is complete.
5. Move it to Done only after tests and required documentation pass.

Use local `.scratch/` files only for disposable investigation notes that should not become team work or durable knowledge.
