# Issue Tracker: Linear

Linear is the canonical tracker for executable Luma work. Use the Dayova team and a `DAY-<number>` identifier in branches, commits, implementation notes, and status reporting.

## Provider Ownership

- Create and update tasks in Linear.
- Store specifications, Meeting records, decisions, and durable context in Notion.
- Use GitHub for code, pull requests, review, CI, and releases.
- Treat GitHub Issues created by the Linear sync as compatibility mirrors. Do not independently create or update both sides of one task.

DAY-39 and GitHub #20 record the task-pipeline migration. DAY-175 records the provider ownership rule.

## Agent Workflow

1. Find or create the Linear issue before substantial implementation.
2. Move it to In Progress when work begins.
3. Link related decisions or source issues rather than duplicating their content.
4. Add a concise implementation and verification comment when the slice is complete.
5. Move it to Done only after tests and required documentation pass.

Use local `.scratch/` files only for disposable investigation notes that should not become team work or durable knowledge.
