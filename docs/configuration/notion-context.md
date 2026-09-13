# Read-only Notion context

`createNotionContextCatalog` provides organizational context through an owned,
read-only `KnowledgeCatalog`. It never wraps the writer-capable
`KnowledgeProvider`. Constructing a catalog does not read a page, start a poll,
or perform any external mutation.

The composition host must provide:

- `workspaceId`: Luma's workspace identity.
- `credentialScopeId`: a stable, non-secret identity for this reviewed credential
  and sharing scope. It forms part of the catalog ID. Give a replacement scope a
  new identity so existing derived receipts cannot silently change credentials.
- `pageIds`: one to 100 exact Notion page UUIDs. Equivalent compact/dashed UUIDs
  normalize to one identity; duplicates are rejected. No search, child-page
  discovery, database discovery, arbitrary block retrieval or writer is exposed.
- `readOnlyApiToken`: a dedicated connection with only the necessary read-content
  capability and access to the approved pages.
- `authorize`: the current explicit Dayova sharing-grant check for the actual
  recipients, workspace, credential scope and exact page UUID.

The required callback receives `{ audience, credentialScopeId, source }`, where
the Notion source is `{ provider: "notion", pageId }`. It must return `true` only
when every recipient is included in a current sanctioned sharing grant for this
scope. The catalog rejects a different workspace or an empty audience before
reading anything. It checks the grant before and after each provider request;
failed or revoked grants cannot return page content or retained discovery IDs.

The Notion integration token proves that the integration can read a page. It does
not prove that a founder or a Discord channel's audience may read it. Notion page
metadata does not establish this grant. Provide it from the host's explicit
reviewed access policy. An `authorize: () => true` callback is not an access policy.

The optional `createNotionContextCatalogFromEnv({ workspaceId, authorize, env })`
helper reads only these provider settings:

| Variable                                  | Meaning                            |
| ----------------------------------------- | ---------------------------------- |
| `LUMA_CONTEXT_NOTION_READONLY_API_TOKEN`  | Dedicated read credential; secret  |
| `LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID` | Reviewed non-secret scope identity |
| `LUMA_CONTEXT_NOTION_PAGE_IDS`            | Comma-separated exact page UUIDs   |

There is no fallback to `NOTION_API_TOKEN`, native-meeting credentials, or a
writer provider. Keep the secret in the existing private production environment
file; never put it in a source ID, log, command argument, or published example.
This helper supplies a catalog for the host to compose; it does not activate a
Discord or observation runtime by itself.

Each read uses the installed SDK and Notion API version `2026-03-11`: page head,
full Markdown including transcripts, then page head again. The heads must agree;
an edited, archived, trashed, missing or restricted page is unavailable. The
version also hashes the returned content, so changed text cannot reuse a receipt
merely because a provider timestamp stayed unchanged. Provider errors are reduced
to a controlled unavailable result, without raw SDK diagnostics.

Notion can report omitted content using `truncated`, `unknown_block_ids`, or
enhanced Markdown `<unknown>` tags. This adapter rejects all three and pages
over 100,000 characters; it never fetches unknown subtrees outside the exact page
scope. This is intentionally a completeness requirement. Bookmarks or unsupported
embeds can therefore make a page unavailable until its supported content can be
read completely. See the [official Markdown API](https://developers.notion.com/reference/retrieve-page-markdown).

Discovery lists only currently granted configured page IDs, with omissions
reported when the request's limit is smaller. The organizational context module
performs relevance ranking, retention and excerpt budgeting. `standing: current`
means the latest readable document; `authority: source` does not claim that a
proposal, job title or ownership statement inside it is an accepted decision.
Human Judgment and explicit decision metadata remain separate.
