# Identity Mapping

Luma uses internal `PersonId` values inside Meeting Intelligence. Provider-specific account names are resolved later by the Identity Directory when Follow-up Execution prepares provider mutations.

This keeps Meeting Intelligence independent from GitHub, Confluence, Notion, Linear, and Discord account details.

## Built-in Luma Team Mapping

The current local development mapping is:

| Person         | Internal `PersonId` | Discord user ID       | GitHub login             | Linear user ID                         | Notion user ID                         |
| -------------- | ------------------- | --------------------- | ------------------------ | -------------------------------------- | -------------------------------------- |
| Fabius Schurig | `person_fabius`     | `726409024894926869`  | `Gamius00`               | `5213a22b-1699-499f-8901-e34204add045` | `398d872b-594c-81f6-ac94-00026a72946d` |
| Jakob Rössner  | `person_jakob`      | `779381502311137301`  | `FleetAdmiralJakob`      | `67e00026-a426-4476-83bb-fe679fc5ca9c` | `612665e1-6fad-4c71-a856-a41a0fb1f32e` |
| Julius         | `person_julius`     | `1376219174723911841` | `juliusdietrich2407-lab` | `cfca93a4-7a23-4d8a-a5c9-56dd9b4b84c8` | `398d872b-594c-81af-9821-0002ec39922d` |
| Philipp        | `person_philipp`    | `1492911575806251219` | `PhilippSchossig`        | `810f1e3b-321b-4e74-bb7b-92cf1608e3ba` | `1ebd872b-594c-8119-8a8e-000285918013` |

Discord usernames are useful for human-readable identity matching. Discord bot mentions use the numeric Discord user IDs and render as `<@discordUserId>`.

## Linear Assignment And Subscribers

Approved work creation resolves `assigneeId` to a Linear user ID and `mentionPersonIds` to Linear subscriber IDs. This lets the bot notify team members without embedding provider identities in Meeting State.

## GitHub Compatibility Mentions

When a provider-independent `CreateWorkItemIntent` has:

```ts
{
  assigneeId: "person_jakob",
  mentionPersonIds: ["person_fabius", "person_julius", "person_philipp"]
}
```

Follow-up Execution resolves this to:

```md
cc @FleetAdmiralJakob @Gamius00 @juliusdietrich2407-lab @PhilippSchossig
```

The GitHub issue assignee is also resolved to `FleetAdmiralJakob`.

## Discord Mentions

When Discord-facing code needs to tag people, the Identity Directory renders numeric Discord IDs as:

```md
<@779381502311137301> <@726409024894926869>
```

Discord usernames should not be used for bot mentions.

## Adding People

Set `LUMA_IDENTITY_PEOPLE_JSON` to a JSON array. Entries extend the built-in team;
using a built-in `personId` overrides that Person's mapping:

```bash
LUMA_IDENTITY_PEOPLE_JSON='[
  {
    "personId": "person_other",
    "displayName": "Other Person",
    "discordUserId": "123456789012345678",
    "discordUsername": "other_discord",
    "githubLogin": "OtherGitHubLogin",
    "githubUserId": null,
    "atlassianAccountId": null,
    "notionUserId": null,
    "linearUserId": null,
    "languagePreference": "auto"
  }
]'
```

Fields other than `personId`, `displayName`, and `languagePreference` may be omitted or set to `null`.

## Assignment vs Mention

GitHub assignment and GitHub mentions are different:

- Assignment uses `assigneeId` resolved to a GitHub login.
- Mentions use `mentionPersonIds` resolved to `@login` Markdown.

GitHub may only allow assignment for users who are assignable in the target repository. Mentions can still be rendered in issue bodies and comments for users or teams GitHub recognizes.

Notion Meeting participants are resolved separately and written to the `Attendees` People property. Custom provider reference IDs do not affect identity resolution: the production Adapters declare the canonical identity namespace (`linear`, `notion`, or `github-issues`).
