import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importedSourceAnalysisFromEnv } from "../../src/app/imported-source-analysis-runtime.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import * as sourceFactory from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { ImportedMeetingSource } from "../../src/domain/model.js";

afterEach(() => vi.restoreAllMocks());
describe("imported analysis provider identity", () => {
  it.each([undefined, "  notion-dayova  "])(
    "uses configured provider %s while retaining exact page and founder grants",
    async (configured) => {
      const directory = await mkdtemp(join(tmpdir(), "luma-provider-id-"));
      const database = await createPgliteDatabase();
      const ledger = createObservedSourceLedger({ database });
      const providerId = configured?.trim() || "notion";
      const page = "00000000-0000-0000-0000-000000000001";
      const workspaceId = "dayova-provider-test";
      const time = "2026-09-11T09:00:00.000Z";
      const source = {
        providerId,
        sourceKind: "meeting-note" as const,
        sourceObjectId: "root",
        parentObjectId: page,
        url: `https://notion.so/${page}`
      };
      const empty = {
        state: "available" as const,
        sourceBlockId: "section",
        text: "",
        blocks: []
      };
      const snapshot: RawMeetingNoteSnapshot = {
        schemaVersion: 1,
        title: "Source",
        lifecycle: "ready",
        calendar: null,
        recording: null,
        sections: {
          summary: empty,
          actionItemsAndNotes: empty,
          transcript: { ...empty, text: "A proposal" }
        },
        markdown: { content: "Source", truncated: false, unknownBlockIds: [] },
        completeness: { state: "complete" }
      };
      try {
        const policyPath = join(directory, "policy.json");
        await writeFile(
          policyPath,
          JSON.stringify({
            version: 1,
            workspaceId,
            grants: [
              {
                provider: "notion",
                credentialScopeId: "read-scope",
                resources: [page],
                personIds: dayovaFounderPersonIds
              }
            ]
          }),
          { mode: 0o600 }
        );
        const record = await ledger.record({
          workspaceId,
          source,
          providerVersion: time,
          observedAt: time,
          snapshot
        });
        const capturedConfigurations: Array<{ providerId: string; pageId: string }> = [];
        vi.spyOn(
          sourceFactory,
          "createNotionObjectScopedMeetingNoteEvidenceSource"
        ).mockImplementation((config) => {
          capturedConfigurations.push({
            providerId: config.providerId,
            pageId: config.pageId
          });
          return {
            capture: () =>
              Promise.resolve({
                status: "captured",
                evidence: { source, providerVersion: time, observedAt: time, snapshot }
              })
          };
        });
        const configuration = importedSourceAnalysisFromEnv({
          workspaceId,
          ledger,
          operationalOutcomeMarkerVerifier: { isOwned: () => Promise.resolve(false) },
          env: {
            LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
            LUMA_CONTEXT_SHARING_POLICY_PATH: policyPath,
            LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "synthetic",
            LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "read-scope",
            LUMA_CONTEXT_NOTION_PAGE_IDS: page,
            ...(configured ? { LUMA_NOTION_PROVIDER_ID: configured } : {})
          }
        });
        const imported: ImportedMeetingSource = {
          ...source,
          sourceRevision: record.revision,
          contentHash: record.contentHash,
          providerVersion: time,
          title: "Source",
          externalReference: {
            providerId,
            objectType: "document",
            externalId: page,
            url: source.url
          },
          workItemProviderId: "linear",
          implementationReferenceProviderId: "github",
          completeness: "complete",
          completenessReasons: [],
          actionItemsAvailability: "available",
          deadlineReferenceAt: time,
          capturedAt: time
        };
        const audience = { workspaceId, personIds: [...dayovaFounderPersonIds] };
        await expect(
          configuration!.access.requireCurrent({ source: imported, audience })
        ).resolves.toBeUndefined();
        expect(capturedConfigurations).toEqual([{ providerId, pageId: page }]);
        await expect(
          configuration!.access.requireCurrent({
            source: { ...imported, providerId: "another-notion" },
            audience
          })
        ).rejects.toThrow();
        await expect(
          configuration!.access.requireCurrent({
            source: imported,
            audience: { ...audience, personIds: ["guest"] }
          })
        ).rejects.toThrow();
        expect(capturedConfigurations).toHaveLength(1);
      } finally {
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
