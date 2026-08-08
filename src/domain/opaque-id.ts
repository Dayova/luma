/**
 * Makes opaque provider identifiers safe to embed in Luma-owned compound IDs.
 *
 * The original value remains available in provider references. This helper only
 * protects separators used by Luma's own stable identifiers.
 */
export function opaqueIdentifierSegment(value: string): string {
  return encodeURIComponent(value);
}
