import { createHash } from "node:crypto";
import { createGitHubCodeProvider } from "../src/code/github-code-provider.js";
import { createGitHubContextCatalog } from "../src/organizational-context/github-context-catalog.js";
import { createOrganizationalContext } from "../src/organizational-context/organizational-context.js";
import { createContextIntelligence } from "../src/context-intelligence/context-intelligence.js";
import type { ContextInquiry } from "../src/context-intelligence/interface.js";
import type { ContextAnswerRequest } from "../src/context-intelligence/context-answerer.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../src/knowledge/observed-source-ledger.js";
import type { LumaDatabase } from "../src/persistence/db.js";
import { score } from "./scorer.js";
import { digest, type GitHubFixture, type MeetingCorpus } from "./corpus.js";

/** Real adapters, synthetic GET responses, no global fetch and no live model. */
export async function runGitHubFixture(
  database: LumaDatabase,
  fixture: GitHubFixture,
  corpus: MeetingCorpus
) {
  const workspaceId = `eval-github:${fixture.id}`;
  const { repository, path, content } = fixture;
  const time = corpus.referenceAt;
  const originalHead = "a".repeat(40);
  let head = originalHead;
  let granted = true;
  const bytes = Buffer.from(content);
  const blobSha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const httpReads: string[] = [];
  const terms: string[] = [];
  const provider = createGitHubCodeProvider({
    token: "synthetic-read-token",
    credentialScopeId: "eval-reader",
    repositories: [repository],
    now: () => new Date(time),
    fetchImpl: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== "https://api.github.com" || init?.method !== "GET")
        throw new Error("Unexpected evaluation request");
      httpReads.push(url.pathname);
      let response: unknown;
      if (url.pathname === `/repos/${repository}`)
        response = {
          full_name: repository,
          default_branch: "main",
          html_url: `https://github.com/${repository}`
        };
      else if (url.pathname === `/repos/${repository}/commits/heads%2Fmain`)
        response = {
          sha: head,
          html_url: `https://github.com/${repository}/commit/${head}`,
          author: null,
          commit: { message: "Synthetic repository revision", committer: { date: time } }
        };
      else if (url.pathname === "/search/code") {
        const query = url.searchParams.get("q") ?? "";
        const prefix = `repo:${repository} in:file "`;
        if (!query.startsWith(prefix) || !query.endsWith('"'))
          throw new Error("Unscoped evaluation query");
        const term = query.slice(prefix.length, -1);
        terms.push(term);
        const matches = content.toLowerCase().includes(term.toLowerCase());
        response = {
          total_count: matches ? 1 : 0,
          incomplete_results: false,
          items: matches
            ? [
                {
                  path,
                  sha: blobSha,
                  html_url: `https://github.com/${repository}/blob/${head}/${path}`,
                  repository: { full_name: repository }
                }
              ]
            : []
        };
      } else if (url.pathname === `/repos/${repository}/contents/${path}`) {
        if (url.searchParams.get("ref") !== head)
          throw new Error("Unpinned evaluation file read");
        response = {
          type: "file",
          path,
          size: bytes.length,
          sha: blobSha,
          encoding: "base64",
          content: bytes.toString("base64")
        };
      } else throw new Error("Unexpected evaluation endpoint");
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }
  });
  const catalog = createGitHubContextCatalog({
    codeProvider: provider,
    authorize: (request) =>
      Promise.resolve(
        granted &&
          request.audience.workspaceId === workspaceId &&
          request.audience.personIds.every((person) =>
            fixture.recipients.includes(person)
          )
      )
  });
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Evaluation",
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
        author: { providerUserId: "1", displayName: "Jakob", personId: "person_jakob" },
        createdAt: time,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: fixture.question
      }
    ],
    completeness: { state: "complete" }
  };
  const requests: ContextAnswerRequest[] = [];
  const context = () =>
    createContextIntelligence({
      database,
      ledger: createObservedSourceLedger({ database }),
      organizationalContext: createOrganizationalContext({
        database,
        catalogs: [catalog],
        now: () => new Date(time)
      }),
      conversationEvidenceSource: {
        capture: () =>
          Promise.resolve({
            source: {
              providerId: "discord",
              sourceKind: "conversation",
              sourceObjectId: "3",
              parentObjectId: "2",
              url: "https://discord.com/channels/1/2/3"
            },
            providerVersion: null,
            snapshot: structuredClone(snapshot),
            observedAt: time
          })
      },
      answerer: {
        answer: (request) => {
          requests.push(structuredClone(request));
          const sources = request.organizationalEvidence ?? [];
          return Promise.resolve({
            answer: {
              text: sources.length
                ? sources.map((source) => source.content).join("\n")
                : "No organizational evidence.",
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
      now: () => new Date(time)
    });
  const inquiry: ContextInquiry = {
    type: "ask",
    workspaceId,
    inquiryId: "first",
    question: fixture.question,
    audience: { workspaceId, personIds: fixture.recipients },
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "2",
      anchorMessageId: "3"
    }
  };
  const first = await context().inquire(inquiry);
  const replay = await context().inquire(inquiry);
  const beforeChangeRequests = requests.length;
  const retained = () =>
    database.query<{ source_json: string }>(
      "SELECT source_json FROM organizational_context_snapshots WHERE workspace_id = $1 ORDER BY snapshot_id",
      [workspaceId]
    );
  const before = digest(JSON.stringify((await retained()).rows));
  if (fixture.changeHeadBeforeReplay) head = "b".repeat(40);
  let changedReplay: string = "delivered";
  try {
    await context().inquire(inquiry);
  } catch (error) {
    changedReplay =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unavailable";
  }
  const afterChangeRequests = requests.length;
  if (fixture.revokeBeforeFresh) granted = false;
  const fresh = await context().inquire({ ...inquiry, inquiryId: "fresh" });
  const after = digest(JSON.stringify((await retained()).rows));
  const outputs: Record<string, unknown> = {
    first: {
      text: first.answer.text,
      sources:
        first.answer.organizationalEvidence?.map((source) => ({
          content: source.content,
          url: source.externalReference.url,
          standing: source.standing,
          authority: source.authority
        })) ?? [],
      coverage: first.organizationalContext?.coverage
    },
    replayEqual: JSON.stringify(first) === JSON.stringify(replay),
    beforeChangeRequests,
    afterChangeRequests,
    changedReplay,
    freshSources: fresh.answer.organizationalEvidence?.length ?? 0,
    retainedBefore: before,
    retainedAfter: after,
    question: requests[0]?.question,
    searchTerms: terms,
    httpReads,
    requests: requests.map((request) => ({
      promptVersion: request.promptVersion,
      input: request
    }))
  };
  return {
    id: fixture.id,
    surface: "ContextIntelligence.inquire → real GitHub CodeProvider with synthetic HTTP",
    coveredBy: [],
    checks: fixture.assertions.map((check) => score(check, outputs)),
    outputs,
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
