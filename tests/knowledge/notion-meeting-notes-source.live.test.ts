import { describe, expect, it } from "vitest";
import type { MeetingNotesScan } from "../../src/knowledge/meeting-notes-source.js";
import { createNotionMeetingNotesSourceFromEnv } from "../../src/knowledge/notion-meeting-notes-source.js";
import {
  createObservedSourceLedger,
  type ObservedSourceRevision
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const liveMeetingNotesEnabled =
  process.env["LUMA_LIVE_NOTION_MEETING_NOTES_TESTS"] === "1" &&
  Boolean(process.env["NOTION_API_TOKEN"]) &&
  Boolean(process.env["NOTION_MEETINGS_DATA_SOURCE_ID"]) &&
  Boolean(process.env["LUMA_NOTION_LIVE_MEETING_NOTES_BLOCK_ID"]);

describe.skipIf(!liveMeetingNotesEnabled)(
  "Notion Meeting Notes source live integration",
  () => {
    it("reads a known completed Meeting Note without mutating Notion", async () => {
      const database = await createPgliteDatabase();
      const source = createNotionMeetingNotesSourceFromEnv({
        ledger: createObservedSourceLedger({ database })
      });
      const expectedSourceObjectId =
        process.env["LUMA_NOTION_LIVE_MEETING_NOTES_BLOCK_ID"];

      try {
        const workspaceId = process.env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova";
        const scans: MeetingNotesScan[] = [];
        let cursor: string | undefined;
        let targetRecord: ObservedSourceRevision | undefined;
        let targetCursor: string | undefined;

        do {
          const scan = await source.scan({
            workspaceId,
            limit: 100,
            ...(cursor ? { cursor } : {})
          });
          scans.push(scan);
          const record = scan.records.find(
            (candidate) => candidate.source.sourceObjectId === expectedSourceObjectId
          );

          if (record) {
            targetRecord = record;
            targetCursor = cursor;
          }

          cursor = scan.nextCursor ?? undefined;
        } while (cursor);

        expect(targetRecord).toBeDefined();

        if (!targetRecord) {
          throw new Error(
            "The configured Meeting Notes block was not found in the canonical data source"
          );
        }

        expect(scans.at(-1)?.nextCursor).toBeNull();
        expect(
          scans
            .flatMap((scan) => scan.partialReasons)
            .filter((reason) => reason.code === "source-enumeration-incomplete")
        ).toEqual([]);
        expect(targetRecord.source.providerId).toBe("notion");
        expect(targetRecord.snapshot.lifecycle).toBe("ready");
        expect(targetRecord.snapshot.sections.summary.state).toBe("available");
        expect(targetRecord.snapshot.sections.actionItemsAndNotes.state).toBe(
          "available"
        );
        expect(targetRecord.snapshot.sections.transcript.state).toBe("available");
        expect(
          targetRecord.snapshot.calendar?.attendeeProviderUserIds.length
        ).toBeGreaterThan(0);
        expect(targetRecord.snapshot.markdown.content).not.toBe("");
        expect(targetRecord.snapshot.markdown.truncated).toBe(false);
        expect(targetRecord.snapshot.markdown.unknownBlockIds).toEqual([]);

        const retry = await source.scan({
          workspaceId,
          limit: 100,
          ...(targetCursor ? { cursor: targetCursor } : {})
        });
        const retriedTarget = retry.records.find(
          (candidate) => candidate.source.sourceObjectId === expectedSourceObjectId
        );

        expect(retriedTarget).toMatchObject({
          change: "unchanged",
          revision: targetRecord.revision,
          contentHash: targetRecord.contentHash
        });
      } finally {
        await database.close();
      }
    }, 60_000);
  }
);
