import { createHash } from "node:crypto";
import { z } from "zod";
import type { CodeActivity, CodeChange, CodeProvider } from "../code/interface.js";
import { GitHubCodeProviderError } from "../code/github-code-provider.js";
import type { ContextAudience, ContextCatalog, ContextSource } from "./interface.js";
import type { GitHubContextAuthorization } from "./github-context-catalog.js";

const repository = z
  .string()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u)
  .max(141);
const identity = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("pr"), repository, number: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal("activity"),
      repository,
      concepts: z.array(z.string().min(1).max(80)).min(1).max(8)
    })
    .strict()
]);
type Identity = z.infer<typeof identity>;
const recentTerms = new Set([
  "recent",
  "latest",
  "changed",
  "changes",
  "activity",
  "updates",
  "commits",
  "releases",
  "neu",
  "neues",
  "neueste",
  "zuletzt",
  "änderungen",
  "geändert",
  "aktivität"
]);

/** Current PR metadata and bounded recent activity, using the same explicit repository grant. */
export function createGitHubChangeContextCatalog(input: {
  codeProvider: CodeProvider;
  authorize: GitHubContextAuthorization;
  now?: () => Date;
}): ContextCatalog {
  const provider = input.codeProvider;
  const now = input.now ?? (() => new Date());
  const allowed = (audience: ContextAudience, repo: string) => {
    if (
      !audience.workspaceId.trim() ||
      !audience.personIds.length ||
      new Set(audience.personIds).size !== audience.personIds.length ||
      audience.personIds.some((person) => !person.trim()) ||
      !provider.readScope.repositories.includes(repo)
    )
      return Promise.resolve(false);
    return input.authorize({
      audience,
      repository: repo,
      providerId: provider.providerId,
      credentialScopeId: provider.readScope.credentialScopeId
    });
  };
  const readActivity = async (repo: string, concepts: string[]) => {
    const result = await provider.getRecentActivity({
      repository: repo,
      since: new Date(now().getTime() - 30 * 86_400_000).toISOString()
    });
    if (result.activities.some((event) => event.repository !== repo)) throw unavailable();
    const generic = concepts.some((concept) => recentTerms.has(concept.toLowerCase()));
    const matches = result.activities.filter(
      (event) =>
        generic ||
        concepts.some((concept) =>
          `${event.title} ${event.commitSha ?? ""}`
            .toLowerCase()
            .includes(concept.toLowerCase())
        )
    );
    return { result, matches };
  };
  return {
    id: `github-changes:${encodeURIComponent(provider.providerId)}:${encodeURIComponent(provider.readScope.credentialScopeId)}`,
    async search({ audience, concepts, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw unavailable();
      const terms = [
        ...new Set(concepts.map((term) => term.trim()).filter(Boolean))
      ].slice(0, 8);
      if (!terms.length || terms.some((term) => term.length > 80))
        return {
          sourceIds: [],
          complete: false,
          warnings: ["No bounded GitHub change discovery terms."]
        };
      const candidates = new Map<string, string>();
      const warnings = new Set<string>([
        "GitHub change discovery is bounded; recent activity is a delayed partial feed, not complete repository history."
      ]);
      let reads = 0;
      for (const repo of provider.readScope.repositories) {
        if (candidates.size >= limit || reads >= 6) break;
        for (const text of terms.slice(0, 3)) {
          if (candidates.size >= limit || reads >= 5) break;
          try {
            if (!(await allowed(audience, repo))) break;
            reads += 1;
            const found = await provider.searchPullRequests({
              repository: repo,
              text,
              limit: Math.min(5, limit - candidates.size)
            });
            if (!(await allowed(audience, repo))) break;
            found.coverage.warnings.forEach((warning) => warnings.add(warning));
            for (const pr of found.results) {
              if (
                pr.repository !== repo ||
                !Number.isSafeInteger(pr.number) ||
                pr.number < 1
              )
                throw unavailable();
              if (candidates.size < limit)
                candidates.set(encode({ type: "pr", ...pr }), repo);
            }
          } catch (error) {
            warnings.add(message(error));
          }
        }
        if (candidates.size < limit && reads < 6) {
          try {
            if (!(await allowed(audience, repo))) continue;
            reads += 1;
            const { result, matches } = await readActivity(repo, terms);
            if (!(await allowed(audience, repo))) continue;
            result.coverage.warnings.forEach((warning) => warnings.add(warning));
            if (matches.length)
              candidates.set(
                encode({ type: "activity", repository: repo, concepts: terms }),
                repo
              );
          } catch (error) {
            warnings.add(message(error));
          }
        }
      }
      // Source IDs contain private repository metadata. Revocation clears earlier discoveries too.
      for (const repo of new Set(candidates.values())) {
        let eligible = false;
        try {
          eligible = await allowed(audience, repo);
        } catch {
          /* Fail closed. */
        }
        if (!eligible)
          for (const [id, owner] of candidates) if (owner === repo) candidates.delete(id);
      }
      return {
        sourceIds: [...candidates.keys()],
        complete: false,
        warnings: [...warnings]
      };
    },
    async read({ audience, sourceId }): Promise<ContextSource | null> {
      const ref = decode(sourceId);
      if (!ref) return null;
      try {
        if (!(await allowed(audience, ref.repository))) return null;
        let source: ContextSource;
        if (ref.type === "pr") {
          const pr = await provider.getPullRequest(ref.repository, ref.number);
          if (
            pr.repository !== ref.repository ||
            pr.number !== ref.number ||
            pr.providerId !== provider.providerId
          )
            throw unavailable();
          source = pullSource(sourceId, pr);
        } else {
          const { result, matches } = await readActivity(ref.repository, ref.concepts);
          if (!matches.length) return null;
          const selected = matches.slice(0, 20);
          const content = JSON.stringify({
            coverage:
              "Partial recent activity from the last 30 days; feed may be delayed and older events omitted. Events do not prove deployed behavior.",
            omittedMatchingEvents: matches.length - selected.length,
            events: selected.map(activityContent),
            warnings: result.coverage.warnings
          });
          source = {
            id: sourceId,
            kind: "code-change",
            title: `${ref.repository}: recent activity`,
            content,
            version: digest(content),
            updatedAt: selected[0]!.occurredAt,
            externalReference: {
              providerId: provider.providerId,
              objectType: "other",
              externalId: sourceId,
              url: selected[0]!.url
            },
            standing: "current",
            authority: "source"
          };
        }
        if (!(await allowed(audience, ref.repository))) return null;
        return source;
      } catch (error) {
        throw new Error(message(error));
      }
    }
  };
}
function pullSource(id: string, pr: CodeChange): ContextSource {
  const stable = { ...pr, observedAt: undefined };
  const version = digest(JSON.stringify(stable));
  const content = JSON.stringify({
    repository: pr.repository,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    description: pr.description.slice(0, 16_000),
    descriptionTruncated: pr.description.length > 16_000,
    author: pr.author,
    reviewers: pr.reviewers.slice(0, 30),
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    updatedAt: pr.updatedAt,
    filesChanged: pr.filesChanged.slice(0, 100),
    filesOmitted: Math.max(0, pr.filesChanged.length - 100),
    commits: pr.commits.slice(0, 30),
    commitsOmitted: Math.max(0, pr.commits.length - 30),
    additions: pr.additions,
    deletions: pr.deletions,
    url: pr.url,
    coverage: pr.coverage,
    interpretation:
      "A draft/open PR is proposed work. Merged means merged into its base, not deployed. Author/reviewer identity is not ownership or decision authority."
  });
  return {
    id,
    kind: "code-change",
    title: `${pr.repository}#${pr.number}: ${pr.title}`,
    content,
    version,
    updatedAt: pr.updatedAt,
    externalReference: {
      providerId: pr.providerId,
      objectType: "pull-request",
      externalId: pr.id,
      url: pr.url,
      version
    },
    standing:
      pr.state === "merged"
        ? "current"
        : pr.state === "closed"
          ? "historical"
          : "proposed",
    authority: "source"
  };
}
function activityContent(event: CodeActivity) {
  return {
    ...event,
    title: event.title.slice(0, 500),
    titleTruncated: event.title.length > 500
  };
}
function encode(value: Identity): string {
  return `github-change:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
function decode(value: string): Identity | null {
  const prefix = "github-change:";
  if (
    value.length > 4_000 ||
    !value.startsWith(prefix) ||
    !/^[a-zA-Z0-9_-]+$/u.test(value.slice(prefix.length))
  )
    return null;
  try {
    const parsed = identity.safeParse(
      JSON.parse(
        Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")
      ) as unknown
    );
    return parsed.success && encode(parsed.data) === value ? parsed.data : null;
  } catch {
    return null;
  }
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unavailable(): Error {
  return new Error("GitHub change context is unavailable.");
}
function message(error: unknown): string {
  return error instanceof GitHubCodeProviderError
    ? `GitHub change context is unavailable (${error.code}).`
    : unavailable().message;
}
