# Native Notion review

Luma has a read-only MCP ingress for one configured Meeting Note and one Custom Agent. It reuses the main Meeting Intelligence instance, source ledger, identity/access policy and AI budget. It does not construct a second store/model or expose a WorkProvider writer. Notion/Linear changes still require their normal approved Follow-up Intents.

The original Human instruction is exactly `Luma review <Notion page URL>`. The `review_meeting_note` tool takes only `sessionId` and `eventId`, selecting the real original user-message event. Luma retrieves that event itself and checks its actual `created_by.type=user`, unique founder account, original text, exact page, configured agent and session. Model arguments, connector owner identity, event metadata, attendance, page authorship and a claimed Person ID are not authorization.

The read-only `find_review_requests` tool discovers authentic locators itself with no arguments: it queries the configured agent's five most recently updated sessions and at most 20 original user messages in each, for a fixed seven-day request window. It returns at most ten exact matching requests, with only founder name, time and real locators. Session/event/result bounds are explicit partial-coverage reasons; an empty result is never a claim about all history. Four-founder ACL and identity proofs precede private session reads, and the exact original matches/audience are revalidated before final delivery. Discovery has no model, store mutation or provider write. Admitted late proofs are drained at shutdown.

The documented Worker/MCP execution context does not supply the current authenticated session/event IDs, and Activity is not documented to expose copyable UUIDs. Discovery closes the locator lookup gap without pretending to identify the current invocation. When multiple requests could match, select by the founder/time context or have the founder choose; never infer an actor or automatically pick the newest. This implementation is tested through actual HTTP with programmed provider responses; the live Custom Agent handshake and tool run still require account-level verification.

## Independent audience proof

The Agent API token has read access to the selected agent. A **separate** Admin API credential, restricted to `workflows:read`, retrieves that agent's sharing permissions. Luma accepts exactly four distinct direct user grants corresponding to Jakob, Fabius, Philipp and Julius, with unique current identity mappings. Group/workspace grants, missing founders, unknown/extra principals, incomplete pagination, deleted/unreadable sessions and unavailable proofs withhold the response. The ACL is checked before reading session text and again after reading the original event.

The source page and Linear team also need explicit grants to all four in the existing protected Context sharing policy, under their dedicated credential scope IDs. Access by the service token alone is insufficient. This source-sharing grant does not substitute for the actual agent audience proof.

The Admin endpoint documents agent sharing grants and effective roles, including workspace/group grants. Platform administrators can override these sharing settings, as with the source systems themselves.

## Main runtime integration

1. The shared main server parses `nativeNotionReviewConfig(env)` before creating resources and composes this runtime when enabled. Production preflight validates the required configuration; live account and provider proofs below remain activation gates.
2. `createNativeNotionReviewResources({config,database,workspace,ledger,identityDirectory,accessPolicy,operationalOutcomeMarkerVerifier})` returns `workCatalog`, `validate()`, `ownsSource(source)`, `sourceHistoryAccess`, `stop()` and `createRuntime({meetingIntelligence})`. Optional second-argument factories replace only true external adapters for integration verification.
3. Use its issued dedicated read-only Linear `workCatalog` **instead of** another reconciliation catalog with the same provider ID when constructing the sole MI. Do not append duplicate `linear` catalogs. The independent writer remains confined to Follow-up Execution/approved structured work.
4. The native runtime constructs callback-free ingestion over that same MI. Do not pass normal capture ingestion or `onProcessedSource`: those can schedule standing automatic Decision writes and would violate the read-only native operation.
5. Call `validate()`, then create/start the native runtime. Its listener defaults to loopback port 3003 at `/notion/review/mcp`, behind authenticated HTTPS reverse proxy. Configure the Custom Agent with the separate MCP bearer, and enable only its read-only discovery and review tools.
6. Compose `sourceHistoryAccess` into the shared imported-source current/history guard. Use the exact `ownsSource(source)` predicate; a revoked or corrupt native binding still belongs to this guard and must deny without fallback. The exported `hasNativeReviewSourceBinding({database,workspaceId,source})` reads durable provenance independently of current feature/page configuration. When native review is disabled, a native-bound source must be withheld; repointing the configured page does not turn an old native source into a generic import. It verifies the immutable source, original native request/audience and current permissions; retained wording may differ while its original source objects remain present. It does not backfill unrecorded sources. At most 20 retained native authorization events for one exact source hash are checked per pass; exceeding that bound withholds rather than guessing permission.
7. Stop the listener/runtime before closing shared persistence. New requests are rejected, incomplete sockets are closed and admitted review work is drained. An AI disclosure proof that outlives an AI timeout is retained and drained too. After all other shared MI consumers drain, call the resources' `stop()` to finish late current/history proofs before closing the database.

`LUMA_LINEAR_PROVIDER_ID` supplies the same opaque WorkProvider namespace to native ingestion, source reconstruction, review projection and the issued read-only catalog (default `linear`). Its identity provider remains `linear`, so an alias cannot change founder identity bindings or sharing credentials.

Native operation proof follows the async request into `runBudgetedAiRequest`, after reservation and existing `beforeInvoke`, immediately before SDK dispatch. A late or revoked proof cannot dispatch after the AI timeout. No extra AI account/budget is created. Analysis status and safe classified errors are retained in the native result so budget exhaustion and timeouts are visible even when deterministic work reconciliation remains available.

`native_review_instructions` retains the immutable event, original recipients/identity bindings, exact source identity/version/hash and analysis status. `source_bound_native_reviews` retains the existing reconciliation receipt. Repeated events do not run another catalog reconciliation or create another observation. Replay revalidates the current native event, audience and exact source; a changed source needs a new Human request. Work search results remain the original proposal's snapshot, while the returned Human resolution projection is fresh. Approved execution rechecks the actual target before writing.

## Configuration

Activation requires every value below; no write-token fallback or automatic permission change exists:

| Variable                                 | Meaning                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `LUMA_NATIVE_REVIEW_ENABLED`             | Explicit `1`/`true`                                      |
| `LUMA_NATIVE_NOTION_WORKSPACE_ID`        | Actual Notion workspace UUID                             |
| `LUMA_NATIVE_NOTION_AGENT_ID`            | Exact Custom Agent UUID                                  |
| `LUMA_NATIVE_NOTION_PAGE_ID`             | Exact Meeting Note page UUID                             |
| `LUMA_NATIVE_NOTION_AGENT_READ_TOKEN`    | Agent read credential                                    |
| `LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN`    | Dedicated `workflows:read` Admin credential              |
| `LUMA_NATIVE_NOTION_READONLY_API_TOKEN`  | Separately restricted exact-page Notion read credential  |
| `LUMA_NATIVE_NOTION_CREDENTIAL_SCOPE_ID` | Explicit source-sharing scope                            |
| `LINEAR_READONLY_API_KEY`                | Dedicated Linear read key                                |
| `LINEAR_TEAM_ID`                         | Actual Linear team, distinct from logical Luma workspace |
| `LUMA_NATIVE_LINEAR_CREDENTIAL_SCOPE_ID` | Explicit team-sharing scope                              |
| `LUMA_CONTEXT_SHARING_POLICY_PATH`       | Existing protected workspace-bound sharing file          |
| `LUMA_NATIVE_REVIEW_MCP_BEARER_TOKEN`    | Dedicated secret, at least 32 characters                 |
| `LUMA_NATIVE_REVIEW_HTTP_PORT`           | Optional loopback port, default 3003                     |
| `LUMA_NATIVE_REVIEW_HTTP_PATH`           | Optional exact MCP path                                  |

All credentials stay in the existing protected production environment/recovery bundle. No additional account, OAuth connection, permission grant or live source is activated by this code. The Admin API is Enterprise-only: do not assume Dayova has this plan or purchase an upgrade. Keep the native surface disabled if the actual permission API/read credential is unavailable; there is no fabricated non-Enterprise ACL fallback. Platform administrators can override sharing, as with the source systems themselves. Native Custom Agent credits are charged by Notion separately; Luma's shared AI cap governs its own model requests and does not cap Notion's agent spending.

## Verified provider contracts and remaining live proof

- [Notion Agent APIs overview](https://developers.notion.com/guides/notion-agent-apis/overview): Custom Agent sessions and event history, per-agent token access.
- [Official public OpenAPI](https://developers.notion.com/openapi.json): `POST /v1/sessions/query` with configured-agent and bounded timestamp filters; `GET /v1/sessions/{session_id}`; `POST /v1/sessions/{session_id}/events/query` with exact ID filter; `user.message.created_by`. Agent API version `2026-03-11`.
- [Agent sharing permissions](https://developers.notion.com/reference/admin/get-agent-permissions) and [official Admin OpenAPI](https://developers.notion.com/openapi-adminApi.json): `GET /v1/spaces/{space_id}/agents/{agent_id}/permissions`; scope `workflows:read`; version `2026-06-01`.
- [Custom Agent MCP connections](https://www.notion.com/help/mcp-connections-for-custom-agents): connected tools use the connector owner's credentials; that is not proof of the requesting Human.
- [Worker API client](https://developers.notion.com/workers/guides/api-client): worker tokens inherit agent permissions; no documented authenticated Human session/event context.
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): stateless JSON responses, authentication, exact Origin validation and no SSE stream.

LUM-5's final live gates remain: actual account/credential scopes and discovered native event locators; four-founder agent sharing audit; completed Activity tool trace with no mutations; same-source/same-revision Discord comparison; real review-to-approved-execution follow-through. The implemented native tool is intentionally read-only and does not itself perform that final approval/write step.
