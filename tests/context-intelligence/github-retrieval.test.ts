import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubCodeProvider } from "../../src/code/github-code-provider.js";
import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";
import type { ContextInquiry } from "../../src/context-intelligence/interface.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGitHubContextCatalog } from "../../src/organizational-context/github-context-catalog.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";
const recipients = ["person_jakob", "person_fabius", "person_philipp", "person_julius"];
const now = "2026-09-10T10:00:00.000Z";
const repository = "dayova/luma";
const head = "a".repeat(40);
const path = "src/budget.ts";
const code =
  "// The monthly AI budget gates paid requests.\nexport const monthlyLimitUsd = 30;\n";
const bytes = Buffer.from(code);
const blobSha = createHash("sha1")
  .update(`blob ${bytes.length}\0`)
  .update(bytes)
  .digest("hex");
const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

describe("Context Ask through the real GitHub catalog and CodeProvider", () => {
  it("finds literal code from a natural question, keeps the original question, and rechecks a persisted replay without another model call", async () => {
    const f = await harness("How do we enforce the monthly AI budget?");
    const result = await f.context.inquire(f.inquiry);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.question).toBe(f.inquiry.question);
    expect(f.requests[0]?.organizationalEvidence).toHaveLength(1);
    expect(result.answer.organizationalEvidence?.[0]).toMatchObject({
      content: code,
      authority: "source",
      standing: "current",
      version: `${head}:${blobSha}:L1-L3`,
      externalReference: {
        url: `https://github.com/${repository}/blob/${head}/${path}#L1-L3`
      }
    });
    expect(result.organizationalContext?.coverage.complete).toBe(false);
    expect(result.organizationalContext?.request.concepts).toEqual([
      "enforce",
      "monthly",
      "AI",
      "budget"
    ]);
    expect(f.searchTerms).toContain("budget");
    expect(f.searchTerms).not.toContain(f.inquiry.question);
    expect(f.requests[0]?.retrievalCoverage?.complete).toBe(false);
    const replay = createContextIntelligence(f.dependencies);
    expect(await replay.inquire(f.inquiry)).toEqual(result);
    await replay.requireCurrent!(f.inquiry);
    expect(f.requests).toHaveLength(1);

    f.changeHead();
    await expect(replay.inquire(f.inquiry)).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    await expect(replay.requireCurrent!(f.inquiry)).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    expect(f.requests).toHaveLength(1);
    expect((await f.database.query("SELECT * FROM context_inquiries")).rows).toHaveLength(
      1
    );
    expect(
      (await f.database.query("SELECT * FROM organizational_context_snapshots")).rows
        .length
    ).toBeGreaterThan(0);
  });

  it("answers a question without searchable concepts from thread evidence, with explicit partial coverage and no provider scan", async () => {
    const f = await harness("What?");
    const result = await f.context.inquire(f.inquiry);
    expect(result.answer.organizationalEvidence ?? []).toEqual([]);
    expect(result.answer.evidence[0]?.messageId).toBe("3");
    expect(result.organizationalContext?.request.concepts).toEqual([]);
    expect(result.organizationalContext?.coverage).toMatchObject({
      complete: false,
      selected: 0
    });
    expect(result.organizationalContext?.coverage.warnings.join(" ")).toContain(
      "No meaningful searchable terms"
    );
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "organizational-context-partial"
    );
    expect(await createContextIntelligence(f.dependencies).inquire(f.inquiry)).toEqual(
      result
    );
    await f.context.requireCurrent!(f.inquiry);
    expect(f.requests).toHaveLength(1);
    expect(f.providerRequests).toEqual([]);

    // Even an empty discovery receipt remains bound to its configured catalogs.
    const changedCatalogs = createContextIntelligence({
      ...f.dependencies,
      organizationalContext: createOrganizationalContext({
        database: f.database,
        catalogs: []
      })
    });
    await expect(changedCatalogs.requireCurrent!(f.inquiry)).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    expect(f.requests).toHaveLength(1);
  });
});

async function harness(question: string) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const inquiry: ContextInquiry = {
    type: "ask",
    workspaceId,
    inquiryId: "budget-question",
    question,
    audience: { workspaceId, personIds: recipients },
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "2",
      anchorMessageId: "3"
    }
  };
  const providerRequests: URL[] = [];
  const searchTerms: string[] = [];
  let currentHead = head;
  const provider = createGitHubCodeProvider({
    token: "synthetic-readonly-token",
    credentialScopeId: "test-founder-code-reader",
    repositories: [repository],
    now: () => new Date(now),
    fetchImpl: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      providerRequests.push(url);
      expect(url.origin).toBe("https://api.github.com");
      expect(init?.method).toBe("GET");
      let response: unknown;
      if (url.pathname === `/repos/${repository}`) {
        response = {
          full_name: repository,
          default_branch: "main",
          html_url: `https://github.com/${repository}`
        };
      } else if (url.pathname === `/repos/${repository}/commits/heads%2Fmain`) {
        response = {
          sha: currentHead,
          html_url: `https://github.com/${repository}/commit/${currentHead}`,
          author: null,
          commit: { message: "Enforce budget", committer: { date: now } }
        };
      } else if (url.pathname === "/search/code") {
        const query = url.searchParams.get("q") ?? "";
        const prefix = `repo:${repository} in:file "`;
        expect(query.startsWith(prefix) && query.endsWith('"')).toBe(true);
        const term = query.slice(prefix.length, -1);
        searchTerms.push(term);
        // The transport honors actual literal search semantics. Returning every
        // fixture regardless of the query would hide the full-question defect.
        const matches = code.toLowerCase().includes(term.toLowerCase());
        response = {
          total_count: matches ? 1 : 0,
          incomplete_results: false,
          items: matches
            ? [
                {
                  path,
                  sha: blobSha,
                  html_url: `https://github.com/${repository}/blob/${currentHead}/${path}`,
                  repository: { full_name: repository }
                }
              ]
            : []
        };
      } else if (url.pathname === `/repos/${repository}/contents/${path}`) {
        expect(url.searchParams.get("ref")).toBe(currentHead);
        response = {
          type: "file",
          path,
          size: bytes.length,
          sha: blobSha,
          encoding: "base64",
          content: bytes.toString("base64")
        };
      } else {
        throw new Error(`Unexpected synthetic GitHub endpoint: ${url.pathname}`);
      }
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }
  });
  const catalog = createGitHubContextCatalog({
    codeProvider: provider,
    authorize: (input) =>
      Promise.resolve(
        input.audience.workspaceId === workspaceId &&
          JSON.stringify([...input.audience.personIds].sort()) ===
            JSON.stringify([...recipients].sort()) &&
          input.repository === repository &&
          input.credentialScopeId === "test-founder-code-reader"
      )
  });
  const organizationalContext = createOrganizationalContext({
    database,
    catalogs: [catalog],
    now: () => new Date(now)
  });
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Luma",
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
          providerUserId: "779381502311137301",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: now,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: `@Luma ${question}`
      }
    ],
    completeness: { state: "complete" }
  };
  const requests: ContextAnswerRequest[] = [];
  const dependencies = {
    database,
    ledger: createObservedSourceLedger({ database }),
    organizationalContext,
    conversationEvidenceSource: {
      capture: () =>
        Promise.resolve({
          source: {
            providerId: "discord",
            sourceKind: "conversation" as const,
            sourceObjectId: "3",
            parentObjectId: "2",
            url: "https://discord.com/channels/1/2/3"
          },
          providerVersion: null,
          snapshot: structuredClone(snapshot),
          observedAt: now
        })
    },
    answerer: {
      answer: (request: ContextAnswerRequest) => {
        requests.push(request);
        const source = request.organizationalEvidence?.[0];
        return Promise.resolve({
          answer: {
            text: source
              ? "The code sets the monthly AI budget to $30."
              : "The thread contains a question that needs clarification.",
            evidenceIds: [source?.evidenceId ?? request.evidence[0]!.evidenceId]
          },
          facts: [],
          inferences: [],
          unresolved: [],
          metadata: {
            provider: "programmable",
            model: "synthetic",
            promptVersion: request.promptVersion
          }
        });
      }
    },
    now: () => new Date(now)
  };
  return {
    database,
    inquiry,
    dependencies,
    context: createContextIntelligence(dependencies),
    requests,
    providerRequests,
    searchTerms,
    changeHead: () => {
      currentHead = "b".repeat(40);
    }
  };
}
