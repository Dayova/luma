# Organizational context configuration

Luma's organizational retrieval is independent of Discord conversation capture.
It uses separately configured read-only Notion, Linear and GitHub connections,
retains versions in the full store, and records a receipt for each selected
bundle. It never uses a writer credential as a read-credential fallback.
The GitHub group includes pinned code, current PR metadata and a bounded recent
activity feed, all under the same explicit repository sharing grant. None of
these sources implies that merged code has been deployed.

Set `LUMA_ORGANIZATIONAL_CONTEXT_ENABLED=1` and
`LUMA_CONTEXT_SHARING_POLICY_PATH=/etc/luma/context-sharing.json`. At least one
complete provider variable group is required. Without this configuration,
conversation Ask is limited to its captured thread; Meeting analysis can use
its own canonical prior state. Neither is workspace-wide knowledge retrieval.

## Explicit sharing policy

Copy `deploy/context-sharing-policy.example.json` to a protected absolute path.
The example grants nothing. The file must be owned by root or the runtime user,
not writable by group/other users, and must not be a symlink. The service account
must be able to read it. Policy reads fail closed and do not print raw file
contents. Replace the file atomically to revoke or narrow access during operation.

A grant explicitly authorizes the listed source scope to be used for the listed
founders. This is separate from the integration's ability to read a provider.
For example, after the source owner has authorized this exact sharing:

```json
{
  "version": 1,
  "workspaceId": "workspace_dayova",
  "grants": [
    {
      "provider": "github-code",
      "credentialScopeId": "dayova-code-reader",
      "resources": ["Dayova/luma"],
      "personIds": ["person_jakob", "person_fabius", "person_philipp", "person_julius"]
    }
  ]
}
```

Notion resources are exact page UUIDs; Linear resources are exact team IDs;
GitHub resources are exact allowlisted `owner/repository` names. Shared Discord
responses require a grant covering all four founders, regardless of which one
asked. A private one-founder grant cannot supply a four-founder response.
Changing a provider credential's trust boundary requires a new credential scope
ID; never reuse a binding to bring retained private snapshots into another scope.

The policy is an explicit sanctioned-sharing contract, not a claim that Notion
or Linear expose every human ACL through their APIs. Provider readability is
checked separately, as is the actual Discord audience. Provider search, an empty
ACL, or an integration token alone cannot authorize disclosure. Retained history
also requires an original snapshot grant covering the current recipients.

## Provider variables

| Provider | Required variables                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| GitHub   | `LUMA_GITHUB_CODE_READONLY_TOKEN`, `LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID`, `LUMA_GITHUB_CODE_REPOSITORIES`          |
| Notion   | `LUMA_CONTEXT_NOTION_READONLY_API_TOKEN`, `LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID`, `LUMA_CONTEXT_NOTION_PAGE_IDS` |
| Linear   | `LUMA_CONTEXT_LINEAR_READONLY_API_KEY`, `LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID`, `LUMA_CONTEXT_LINEAR_TEAM_ID`    |

Repository and page ID lists are comma-separated. Tokens stay in the protected
environment file; the sharing policy contains no credentials. See the
[Notion](notion-context.md), [Linear](linear-context.md), and
[GitHub code](../integrations/github-code.md) adapter documents for their exact
coverage limits.

Retrieval ranks Human-confirmed current information before proposals, retains
historical versions, deduplicates equivalent source text, and exposes conflicting
statements and bounded coverage. It does not infer accepted decisions from a
page's edit time. Ordinary document content remains source material, not proof
that every idea in it was approved. Current, complete indexed knowledge is not
promised: Linear and GitHub searches are explicitly non-exhaustive.

The source scan and revalidation have bounded time and content budgets. Changes,
revocation, newly eligible sources or a restored failed catalog invalidate old
receipts. Provider failures do not cause cached private text to be substituted.
These controls preserve evidence; they do not delete history or change the USD
30 shared AI allowance. More retrieved text can increase model cost, and the
same durable AI budget still controls admission.

The Notion provider configuration also enables [governed imported Meeting
understanding](../imported-meeting-understanding.md) in the main runtime. Existing
and new accepted Meeting Note imports use the same exact-page founder grants and
dedicated reader, with a fresh capture comparison and durable original-audience
receipt before model analysis. Source-only observation proof hosts do not gain a
second AI budget.
