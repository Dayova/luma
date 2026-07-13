# Identity Mapping

Luma uses internal `PersonId` values inside Meeting Intelligence. Provider-specific account names are resolved later by the Identity Directory when Follow-up Execution prepares provider mutations.

This keeps Meeting Intelligence independent from GitHub, Confluence, Notion, Linear, and Discord account details.

## Built-in Luma Team Mapping

The current local development mapping is:

| Person         | Internal `PersonId` | Discord username    | Discord user ID       | GitHub login             |
| -------------- | ------------------- | ------------------- | --------------------- | ------------------------ |
| Fabius Schurig | `person_fabius`     | `gamius_official`   | `726409024894926869`  | `Gamius00`               |
| Jakob Rössner  | `person_jakob`      | `fleetadmiraljakob` | `779381502311137301`  | `FleetAdmiralJakob`      |
| Julius         | `person_julius`     | `juliusd1234_18271` | `1376219174723911841` | `juliusdietrich2407-lab` |
| Philipp        | `person_philipp`    | `philipp_54277`     | `1492911575806251219` | `PhilippSchossig`        |

Discord usernames are useful for human-readable identity matching. Discord bot mentions use the numeric Discord user IDs and render as `<@discordUserId>`.

## GitHub Mentions

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
