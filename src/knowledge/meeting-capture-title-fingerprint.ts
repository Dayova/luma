import { createHash } from "node:crypto";

/**
 * Produces the conservative, provider-neutral title correlation token used by
 * meeting-capture adapters. It deliberately preserves punctuation and word
 * order: title equality is only a weak corroborating signal and must never
 * independently bind captures.
 */
export function meetingCaptureTitleFingerprint(title: string | null): string | null {
  if (title === null) {
    return null;
  }

  const normalized = title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  return `title:v1:sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}
