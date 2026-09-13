import { createContextIntelligence } from "../src/context-intelligence/context-intelligence.js";
import type { ContextInquiry } from "../src/context-intelligence/interface.js";
import type { ContextAnswerRequest } from "../src/context-intelligence/context-answerer.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../src/knowledge/observed-source-ledger.js";
import { createNotionReadOnlyKnowledgeCatalogForTest } from "../src/knowledge/notion-read-only-knowledge-catalog.js";
import { notionKnowledgeContextCatalog } from "../src/organizational-context/notion-context-catalog.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyApiIssue
} from "../src/work/linear-read-only-work-catalog.js";
import { createLinearContextCatalog } from "../src/organizational-context/linear-context-catalog.js";
import { createGitHubCodeProvider } from "../src/code/github-code-provider.js";
import { createGitHubChangeContextCatalog } from "../src/organizational-context/github-change-context-catalog.js";
import { createNotionDecisionRecordCatalog } from "../src/knowledge/notion-decision-records.js";
import {
  decisionDigest,
  renderNotionDecisionRecord
} from "../src/knowledge/notion-decision-record-format.js";
import { createDecisionContextCatalog } from "../src/organizational-context/decision-context-catalog.js";
import { createOrganizationalContext } from "../src/organizational-context/organizational-context.js";
import type {
  ContextAudience,
  ContextSource
} from "../src/organizational-context/interface.js";
import type { LumaDatabase } from "../src/persistence/db.js";
import { digest, type CrossProviderFixture, type MeetingCorpus } from "./corpus.js";
import { score } from "./scorer.js";

/** Real source parsers, signed Decision reader, catalogs and Context Ask over synthetic I/O. */
export async function runCrossProviderFixture(
  database: LumaDatabase,
  fixture: CrossProviderFixture,
  corpus: MeetingCorpus
) {
  const workspaceId = `eval-cross-provider-${fixture.id}`;
  const record = structuredClone(fixture.canonicalRecord);
  record.source.audience.workspaceId = workspaceId;
  const audience = record.source.audience;
  let granted = true;
  const authorize = (requested: ContextAudience) =>
    granted &&
    requested.workspaceId === workspaceId &&
    requested.personIds.every((id) => audience.personIds.includes(id));
  const calls: string[] = [];
  const dataSourceId = "11111111-1111-4111-8111-111111111111";
  const decisionPage = "22222222-2222-4222-8222-222222222222";
  const notionPage = "33333333-3333-4333-8333-333333333333";
  const signingKey = "synthetic-evaluation-signing-key-over-32-bytes";
  const canonicalMarkdown = renderNotionDecisionRecord(
    {
      format: 1,
      workspaceId,
      dataSourceId,
      revisions: [
        {
          operationId: "synthetic-accepted-decision",
          stageDigest: digest(JSON.stringify(record)),
          content: record
        }
      ]
    },
    signingKey
  );
  const canonical = createDecisionContextCatalog({
    id: "canonical-decisions",
    records: createNotionDecisionRecordCatalog({
      workspaceId,
      dataSourceId,
      signingKey,
      readOnlyApiToken: "synthetic-decision-read-token",
      authorize: ({ audience: requested }) => Promise.resolve(authorize(requested)),
      authorizeRetainedSource: ({ audience: requested, source }) =>
        Promise.resolve(
          authorize(requested) && decisionDigest(source) === decisionDigest(record.source)
        ),
      authorizeRetainedAuthority: ({ audience: requested, snapshot }) =>
        Promise.resolve(
          authorize(requested) &&
            decisionDigest(snapshot) === decisionDigest(record.authority.snapshot)
        ),
      transport: {
        list: () => {
          calls.push("decision:list");
          return Promise.resolve({
            object: "list",
            results: [{ object: "page", id: decisionPage }],
            has_more: false,
            next_cursor: null
          });
        },
        readPage: (id) => {
          if (id !== decisionPage) throw new Error("Unscoped Decision read");
          calls.push("decision:page");
          return Promise.resolve({
            object: "page",
            id,
            url: `https://notion.so/${id}`,
            archived: false,
            in_trash: false,
            parent: { type: "data_source_id", data_source_id: dataSourceId },
            last_edited_time: corpus.referenceAt
          });
        },
        readMarkdown: (id) => {
          if (id !== decisionPage) throw new Error("Unscoped Decision markdown");
          calls.push("decision:markdown");
          return Promise.resolve({
            object: "page_markdown",
            id,
            markdown: canonicalMarkdown,
            truncated: false,
            unknown_block_ids: []
          });
        }
      }
    })
  });
  const notion = notionKnowledgeContextCatalog(
    createNotionReadOnlyKnowledgeCatalogForTest(
      {
        workspaceId,
        credentialScopeId: "notion-reader",
        readOnlyApiToken: "synthetic-notion-read-token",
        pageIds: [notionPage],
        authorize: ({ audience: requested }) => Promise.resolve(authorize(requested))
      },
      {
        retrievePage: (id) => {
          if (id !== notionPage) throw new Error("Unscoped Notion read");
          calls.push("notion:page");
          return Promise.resolve({
            object: "page",
            id,
            archived: false,
            in_trash: false,
            url: `https://notion.so/${id}`,
            last_edited_time: corpus.referenceAt,
            properties: {
              title: { type: "title", title: [{ plain_text: "Luma access policy" }] },
              "Luma knowledge state": {
                type: "select",
                select: { name: fixture.notion.standing }
              }
            }
          });
        },
        retrieveMarkdown: (id) => {
          if (id !== notionPage) throw new Error("Unscoped Notion markdown");
          calls.push("notion:markdown");
          return Promise.resolve({
            object: "page_markdown",
            id,
            markdown: fixture.notion.content,
            truncated: false,
            unknown_block_ids: []
          });
        }
      }
    )
  );
  const issue: LinearReadOnlyApiIssue = {
    id: "44444444-4444-4444-8444-444444444444",
    teamId: "luma-team",
    identifier: "LUM-777",
    title: "Luma access policy",
    description: fixture.linear.content,
    stateType: "completed",
    stateName: "Done",
    assignee: null,
    dueDate: null,
    labels: [`luma:knowledge:${fixture.linear.standing}`],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-777",
    updatedAt: corpus.referenceAt
  };
  const linear = createLinearContextCatalog({
    workspaceId,
    credentialScopeId: "linear-reader",
    authorize: ({ audience: requested }) => Promise.resolve(authorize(requested)),
    readOnlyWorkCatalog: createLinearReadOnlyWorkCatalogForTest({
      teamId: "luma-team",
      api: createLinearReadOnlyApiForTest({
        searchIssues: () => {
          calls.push("linear:search");
          return Promise.resolve([structuredClone(issue)]);
        },
        getIssue: (id) => {
          if (id !== issue.id) throw new Error("Unscoped Linear read");
          calls.push("linear:read");
          return Promise.resolve(structuredClone(issue));
        }
      })
    })
  });
  const repository = "dayova/luma";
  const prUrl = `https://github.com/${repository}/pull/7`;
  const github = createGitHubChangeContextCatalog({
    now: () => new Date(corpus.referenceAt),
    authorize: ({ audience: requested }) => Promise.resolve(authorize(requested)),
    codeProvider: createGitHubCodeProvider({
      token: "synthetic-github-read-token",
      credentialScopeId: "github-reader",
      repositories: [repository],
      now: () => new Date(corpus.referenceAt),
      fetchImpl: (raw, init) => {
        const url = new URL(raw instanceof Request ? raw.url : raw);
        if (url.origin !== "https://api.github.com" || init?.method !== "GET")
          throw new Error("Unscoped evaluation HTTP request");
        calls.push(`github:${url.pathname}`);
        let body: unknown;
        if (url.pathname === "/search/issues")
          body = {
            total_count: 1,
            incomplete_results: false,
            items: [{ number: 7, html_url: prUrl, pull_request: { html_url: prUrl } }]
          };
        else if (url.pathname === `/repos/${repository}/pulls/7`)
          body = {
            id: 70,
            number: 7,
            title: "Luma access policy",
            body: fixture.github.content,
            user: { id: 1, login: "synthetic-jakob" },
            state: ["merged", "closed"].includes(fixture.github.state)
              ? "closed"
              : "open",
            draft: fixture.github.state === "draft",
            merged: fixture.github.state === "merged",
            html_url: prUrl,
            updated_at: corpus.referenceAt,
            head: { sha: "a".repeat(40) },
            base: { sha: "b".repeat(40), repo: { full_name: repository } },
            additions: 0,
            deletions: 0,
            changed_files: 0,
            commits: 0,
            requested_reviewers: [],
            requested_teams: []
          };
        else if (
          [
            `/repos/${repository}/events`,
            ...["files", "commits", "reviews"].map(
              (part) => `/repos/${repository}/pulls/7/${part}`
            )
          ].includes(url.pathname)
        )
          body = [];
        else throw new Error("Unexpected evaluation HTTP endpoint");
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
    })
  });
  const catalogs = [canonical, notion, linear, github];
  const mappings: Record<string, Pick<ContextSource, "standing" | "authority">[]> = {};
  for (const [name, catalog] of [
    ["canonical", canonical],
    ["notion", notion],
    ["linear", linear],
    ["github", github]
  ] as const) {
    const found = await catalog.search({ audience, concepts: ["Luma"], limit: 10 });
    const values = await Promise.all(
      found.sourceIds.map((sourceId) => catalog.read({ audience, sourceId }))
    );
    mappings[name] = values.flatMap((value) =>
      value ? [{ standing: value.standing, authority: value.authority }] : []
    );
  }
  const requests: ContextAnswerRequest[] = [];
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Luma access policy",
      url: "https://discord.com/channels/1/2"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "3",
      firstMessageId: "3",
      lastMessageId: "3",
      messageIds: ["3"]
    },
    messages: [
      {
        id: "3",
        ordinal: 0,
        author: {
          providerUserId: "1",
          displayName: "Jakob",
          personId: audience.personIds[0]!
        },
        createdAt: corpus.referenceAt,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: fixture.question
      }
    ],
    completeness: { state: "complete" }
  };
  const context = () =>
    createContextIntelligence({
      database,
      ledger: createObservedSourceLedger({ database }),
      organizationalContext: createOrganizationalContext({
        database,
        catalogs,
        now: () => new Date(corpus.referenceAt)
      }),
      organizationalContextLimits: { limit: 10, maxCharacters: 12000 },
      conversationEvidenceSource: {
        capture: () =>
          Promise.resolve({
            source: {
              providerId: "discord",
              sourceKind: "conversation",
              sourceObjectId: "3",
              parentObjectId: "2",
              url: snapshot.messages[0]!.url
            },
            providerVersion: null,
            snapshot: structuredClone(snapshot),
            observedAt: corpus.referenceAt
          })
      },
      answerer: {
        answer: (request) => {
          requests.push(structuredClone(request));
          const sources = request.organizationalEvidence ?? [];
          return Promise.resolve({
            answer: {
              text: sources.length
                ? sources
                    .map(
                      (source) =>
                        `[${source.standing}; ${source.authority}] ${source.content}`
                    )
                    .join("\n")
                : "No current organizational knowledge is available.",
              evidenceIds: sources.length
                ? sources.map((source) => source.evidenceId)
                : request.evidence.map((source) => source.evidenceId)
            },
            facts: [],
            inferences: [],
            unresolved: [],
            metadata: {
              provider: "synthetic",
              model: "selected-evidence-echo-v1",
              promptVersion: request.promptVersion
            }
          });
        }
      },
      now: () => new Date(corpus.referenceAt)
    });
  const inquiry: ContextInquiry = {
    type: "ask",
    workspaceId,
    inquiryId: "current",
    question: fixture.question,
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "2",
      anchorMessageId: "3"
    },
    audience
  };
  const current = await context().inquire(inquiry);
  const before = (
    await database.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM organizational_context_snapshots WHERE workspace_id=$1 ORDER BY snapshot_id",
      [workspaceId]
    )
  ).rows;
  if (fixture.revokeBeforeReplay) granted = false;
  let replay = "allowed",
    delivery = "allowed";
  try {
    await context().inquire(inquiry);
  } catch {
    replay = "blocked";
  }
  try {
    await context().requireCurrent!(inquiry);
  } catch {
    delivery = "blocked";
  }
  const fresh = await context().inquire({ ...inquiry, inquiryId: "fresh" });
  const after = (
    await database.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM organizational_context_snapshots WHERE workspace_id=$1 ORDER BY snapshot_id",
      [workspaceId]
    )
  ).rows;
  const outputs: Record<string, unknown> = {
    current: {
      text: current.answer.text,
      primaryText: current.organizationalContext?.evidence[0]?.content ?? "",
      standing: current.organizationalContext?.evidence.map((entry) => entry.standing),
      authority: current.organizationalContext?.evidence.map((entry) => entry.authority),
      coverage: current.organizationalContext?.coverage
    },
    fresh: { text: fresh.answer.text },
    replay,
    delivery,
    before,
    after,
    mappings,
    providerReads: [...new Set(calls.map((call) => call.split(":")[0]))].sort(),
    requests: requests.map((request) => ({
      promptVersion: request.promptVersion,
      input: request
    }))
  };
  return {
    id: fixture.id,
    surface:
      "ContextIntelligence.inquire + actual Notion/Linear/GitHub adapters" as const,
    outputs,
    checks: fixture.assertions.map((check) => score(check, outputs)),
    coveredBy: [],
    contextUse: {
      requests: requests.length,
      inputCharacters: requests.reduce(
        (sum, request) => sum + JSON.stringify(request).length,
        0
      ),
      contextCharacters: requests.reduce(
        (sum, request) =>
          sum +
          (request.organizationalEvidence ?? []).reduce(
            (n, source) => n + source.content.length,
            0
          ),
        0
      ),
      contextEntries: requests.reduce(
        (sum, request) => sum + (request.organizationalEvidence?.length ?? 0),
        0
      )
    }
  };
}
