import { z } from "zod";
import type { CodeProvider, CodeExcerptReference } from "../code/interface.js";
import { GitHubCodeProviderError } from "../code/github-code-provider.js";
import type { ContextAudience, ContextCatalog, ContextSource } from "./interface.js";

export type GitHubContextAuthorization = (input: {
  audience: ContextAudience;
  providerId: string;
  credentialScopeId: string;
  repository: string;
}) => Promise<boolean>;

export type GitHubContextCatalogConfig = {
  codeProvider: CodeProvider;
  /** Live explicit sharing grant for all actual recipients, independent of API readability. */
  authorize: GitHubContextAuthorization;
  maxSearches?: number;
};

const sourceSchema = z
  .object({
    type: z.literal("github-code-excerpt-v1"),
    repository: z.string().min(1).max(141),
    path: z.string().min(1).max(4096),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    blobSha: z.string().regex(/^[a-f0-9]{40}$/u),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive()
  })
  .strict();

export function createGitHubContextCatalog(
  config: GitHubContextCatalogConfig
): ContextCatalog {
  const { codeProvider: provider } = config;
  const maxSearches = config.maxSearches ?? 6;
  if (
    !Number.isSafeInteger(maxSearches) ||
    maxSearches < 1 ||
    maxSearches > 20 ||
    !provider.providerId ||
    !provider.readScope.credentialScopeId ||
    typeof config.authorize !== "function"
  )
    throw new Error("GitHub context catalog configuration is invalid.");
  // Retained source identities cannot cross a changed credential binding.
  const id = `github-code:${encodeURIComponent(provider.providerId)}:${encodeURIComponent(provider.readScope.credentialScopeId)}`;
  const allowed = async (
    audience: ContextAudience,
    repository: string
  ): Promise<boolean> => {
    if (!validAudience(audience) || !provider.readScope.repositories.includes(repository))
      return false;
    return config.authorize({
      audience,
      providerId: provider.providerId,
      credentialScopeId: provider.readScope.credentialScopeId,
      repository
    });
  };
  return {
    id,
    async search({ audience, concepts, limit }) {
      if (!validAudience(audience))
        return {
          sourceIds: [],
          complete: false,
          warnings: ["GitHub context audience is ineligible."]
        };
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("GitHub context search limit is invalid.");
      const terms = [
        ...new Set(concepts.map((concept) => concept.trim()).filter(Boolean))
      ];
      const sources = new Map<string, string>();
      const warnings = new Set<string>([
        "GitHub catalog searches bounded literal phrases in the default-branch code index; PR and activity retrieval are not included in this catalog search."
      ]);
      let searches = 0;
      outer: for (const repository of provider.readScope.repositories) {
        for (const text of terms) {
          if (sources.size >= limit || searches >= maxSearches) {
            warnings.add(
              "GitHub context search reached its configured result or request limit."
            );
            break outer;
          }
          try {
            if (!(await allowed(audience, repository))) {
              warnings.add(
                "A configured repository is not authorized for this audience."
              );
              break;
            }
            searches += 1;
            const result = await provider.searchCode({
              repository,
              text,
              limit: Math.min(20, limit - sources.size)
            });
            if (!(await allowed(audience, repository))) {
              warnings.add("A repository sharing grant changed during retrieval.");
              break;
            }
            for (const warning of result.coverage.warnings) warnings.add(warning);
            if (!result.coverage.complete)
              warnings.add("GitHub code search coverage is partial.");
            for (const item of result.results) {
              if (item.repository !== repository || item.commitSha !== result.commitSha)
                throw new Error("GitHub context result identity is invalid.");
              if (sources.size < limit) sources.set(sourceId(item), repository);
            }
          } catch (error) {
            warnings.add(controlledFailure(error));
          }
        }
      }
      // IDs contain private path metadata too. A later revocation also removes
      // candidates accumulated by earlier phrase searches in that repository.
      for (const repository of new Set(sources.values())) {
        let eligible = false;
        try {
          eligible = await allowed(audience, repository);
        } catch (error) {
          warnings.add(controlledFailure(error));
        }
        if (!eligible) {
          warnings.add("A repository sharing grant changed during retrieval.");
          for (const [candidate, owner] of sources) {
            if (owner === repository) sources.delete(candidate);
          }
        }
      }
      // Search candidates are not evidence. Each read rechecks live grants and bytes.
      return { sourceIds: [...sources.keys()], complete: false, warnings: [...warnings] };
    },
    async read({ audience, sourceId: requestedId }): Promise<ContextSource | null> {
      const reference = parseSourceId(requestedId);
      if (!reference) return null;
      try {
        if (!(await allowed(audience, reference.repository))) return null;
        const current = await provider.getCurrentCodeExcerpt(reference);
        if (!current || sourceId(current) !== requestedId) return null;
        if (!(await allowed(audience, reference.repository))) return null;
        const version = `${current.commitSha}:${current.blobSha}:L${current.startLine}-L${current.endLine}`;
        return {
          id: requestedId,
          kind: "code-change",
          title: `${current.repository}: ${current.path}`,
          content: current.excerpt,
          version,
          updatedAt: current.committedAt,
          externalReference: {
            providerId: provider.providerId,
            objectType: "other",
            externalId: requestedId,
            url: current.url,
            version
          },
          standing: "current",
          authority: "source"
        };
      } catch (error) {
        // Provider diagnostic text can contain private data; preserve only known codes.
        throw new Error(controlledFailure(error));
      }
    }
  };
}

function validAudience(audience: ContextAudience): boolean {
  return (
    Boolean(audience.workspaceId.trim()) &&
    audience.personIds.length > 0 &&
    audience.personIds.every((person) => Boolean(person.trim())) &&
    new Set(audience.personIds).size === audience.personIds.length
  );
}
function sourceId(reference: CodeExcerptReference): string {
  return `github-code-excerpt:${Buffer.from(
    JSON.stringify({
      type: "github-code-excerpt-v1",
      repository: reference.repository,
      path: reference.path,
      commitSha: reference.commitSha,
      blobSha: reference.blobSha,
      startLine: reference.startLine,
      endLine: reference.endLine
    })
  ).toString("base64url")}`;
}
function parseSourceId(value: string): CodeExcerptReference | null {
  const prefix = "github-code-excerpt:";
  if (
    value.length > 12_000 ||
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]+$/u.test(value.slice(prefix.length))
  )
    return null;
  try {
    const result = sourceSchema.safeParse(
      JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"))
    );
    if (
      !result.success ||
      result.data.endLine < result.data.startLine ||
      result.data.endLine - result.data.startLine > 100 ||
      sourceId(result.data) !== value
    )
      return null;
    return result.data;
  } catch {
    return null;
  }
}
function controlledFailure(error: unknown): string {
  return error instanceof GitHubCodeProviderError
    ? `GitHub context is unavailable (${error.code}).`
    : "GitHub context is unavailable.";
}
