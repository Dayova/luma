/**
 * The owned adapters use Notion object IDs as request-path segments. Accept
 * only UUID spellings that Notion uses for pages and normalize equivalent
 * compact/dashed/uppercase representations before a provider client sees
 * them. This prevents untrusted provider event material from changing a
 * credentialed request path.
 */
export function canonicalNotionObjectId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (
    !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/u.test(
      value
    )
  ) {
    return null;
  }

  const compact = value.replaceAll("-", "");

  const normalized = compact.toLowerCase();
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20)
  ].join("-");
}
