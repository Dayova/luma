import { createHash } from "node:crypto";
import type { ExternalReference } from "../domain/model.js";

/** An explicitly selected, complete existing document; no search or retargeting. */
export type CanonicalKnowledgeDocument = {
  reference: ExternalReference & { objectType: "document" };
  markdown: string;
};

/** Owned write capability. It does not create documents or replace whole pages. */
export interface CanonicalKnowledgePatchWriter {
  readonly providerId: string;
  readComplete(externalId: string): Promise<CanonicalKnowledgeDocument>;
  replaceExact(input: {
    externalId: string;
    expectedMarkdown: string;
    replacementMarkdown: string;
  }): Promise<void>;
}

export type PreparedCanonicalKnowledgePatch = {
  operationToken: string;
  proposalId: string;
  target: CanonicalKnowledgeDocument["reference"];
  expectedMarkdown: string;
  replacementMarkdown: string;
  beforeDigest: string;
  afterDigest: string;
  patchDigest: string;
};

export function knowledgeDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exactRegionCount(markdown: string, region: string): number {
  if (!region) return 0;
  let count = 0;
  let position = 0;
  while ((position = markdown.indexOf(region, position)) !== -1) {
    count += 1;
    position += 1; // Overlapping occurrences are ambiguous too.
  }
  return count;
}
