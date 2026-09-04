import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLogicalMeetings,
  type CreateLogicalMeetingsInput
} from "../../src/logical-meetings/logical-meetings.js";
import type {
  CaptureRevisionVerifier,
  HumanCaptureBindingJudgment,
  LogicalMeetingBindingResult,
  MeetingCaptureRevision
} from "../../src/logical-meetings/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";

describe("LogicalMeetings", () => {
  it("keeps a provider capture's Luma-owned binding stable across retries and later revisions", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const firstRevision = captureRevision({
        externalCaptureId: "notion-note-1",
        sourceRevision: 1,
        content: "first"
      });
      const first = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: firstRevision })
      );
      const replay = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: firstRevision })
      );
      const secondRevision = captureRevision({
        externalCaptureId: "notion-note-1",
        sourceRevision: 2,
        content: "corrected"
      });
      const revised = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: secondRevision })
      );

      expect(first.captureId).toMatch(/^capture:/);
      expect(first.logicalMeeting.id).toMatch(/^logical-meeting:/);
      expect(first.logicalMeeting.id).not.toContain("notion-note-1");
      expect(first.effect).toBe("created");
      expect(replay).toMatchObject({
        captureId: first.captureId,
        effect: "unchanged",
        logicalMeeting: { id: first.logicalMeeting.id }
      });
      expect(revised).toMatchObject({
        captureId: first.captureId,
        effect: "revised",
        logicalMeeting: { id: first.logicalMeeting.id }
      });
      expect(revised.logicalMeeting.captureRefs).toHaveLength(1);
      expect(revised.logicalMeeting.captureRefs[0]?.latestRevision).toMatchObject({
        sourceRevision: 2,
        contentHash: secondRevision.contentHash
      });

      const oldReplay = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: firstRevision })
      );
      expect(oldReplay).toMatchObject({
        effect: "unchanged",
        logicalMeeting: {
          id: first.logicalMeeting.id,
          captureRefs: [
            {
              latestRevision: { sourceRevision: 2 }
            }
          ]
        }
      });
    } finally {
      await database.close();
    }
  });

  it("automatically binds different provider captures only on high-confidence identity", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const notion = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "notion",
            providerConnectionId: "notion:jakob",
            externalCaptureId: "notion-note-calendar",
            calendarEventKeys: ["calendar:event:planning"]
          })
        })
      );
      const granola = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:fabius",
            externalCaptureId: "granola-note-calendar",
            sourceKind: "enhanced-notes",
            calendarEventKeys: ["calendar:event:planning"],
            capabilities: {
              enhancedNotes: "available",
              rawTranscript: "unavailable",
              speakerIdentity: "unavailable",
              attendees: "partial",
              revisionMetadata: "available"
            },
            materials: [
              material({
                providerId: "granola",
                kind: "derived-notes",
                provenance: "provider-derived"
              })
            ]
          })
        })
      );

      expect(granola).toMatchObject({
        state: "bound-high-confidence",
        origin: "automatic",
        logicalMeeting: { id: notion.logicalMeeting.id },
        matchEvidence: [{ kind: "shared-calendar-event" }]
      });
      expect(granola.matchFactsDigest).toMatch(/^sha256:/);
      expect(granola.logicalMeeting.captureRefs).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it.each([
    {
      kind: "shared-calendar-event",
      stronger: { calendarEventKeys: ["calendar:ranked"] },
      weaker: { conferenceKeys: ["conference:ranked"] }
    },
    {
      kind: "shared-conference",
      stronger: { conferenceKeys: ["conference:ranked"] },
      weaker: {
        interval: interval("2026-08-30T09:00:00.000Z", "2026-08-30T10:00:00.000Z"),
        attendeePersonIds: ["person:jakob", "person:fabius"]
      }
    }
  ])(
    "prefers $kind over a weaker identity match on discovery and revision",
    async ({ kind, stronger, weaker }) => {
      const database = await createPgliteDatabase();

      try {
        const logicalMeetings = create(database, logicalVerifier());
        const weak = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({ externalCaptureId: "weak-target", ...weaker })
          })
        );
        const strong = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({ externalCaptureId: "strong-target", ...stronger })
          })
        );
        const address = { providerId: "granola", externalCaptureId: "ranked-capture" };
        const original = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({ ...address, ...stronger, ...weaker })
          })
        );
        expect(original).toMatchObject({
          state: "bound-high-confidence",
          logicalMeeting: { id: strong.logicalMeeting.id },
          matchEvidence: [{ kind }]
        });

        const revised = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({ ...address, sourceRevision: 2, ...weaker })
          })
        );
        expect(revised.logicalMeeting.id).toBe(weak.logicalMeeting.id);

        const restored = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              ...address,
              sourceRevision: 3,
              ...stronger,
              ...weaker
            })
          })
        );
        expect(restored).toMatchObject({
          effect: "revised",
          state: "bound-high-confidence",
          logicalMeeting: { id: strong.logicalMeeting.id },
          matchEvidence: [{ kind }]
        });
      } finally {
        await database.close();
      }
    }
  );

  it("keeps equally strong matches ambiguous after ranking all captures in each meeting", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const conference = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "ranked-conference",
            conferenceKeys: ["conference:tie"]
          })
        })
      );
      const calendar = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "ranked-calendar",
            calendarEventKeys: ["calendar:tie-a"]
          })
        })
      );
      accepted(
        await logicalMeetings.recordBindingJudgment({
          judgmentId: "bind-ranked-captures",
          workspaceId,
          actorPersonId: "person:jakob",
          captureId: calendar.captureId,
          observedAt: "2026-08-30T12:00:00.000Z",
          reason: "Independent captures of the same meeting.",
          judgment: { type: "bind", logicalMeetingId: conference.logicalMeeting.id }
        })
      );
      const other = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "other-ranked-calendar",
            calendarEventKeys: ["calendar:tie-b"]
          })
        })
      );
      for (const sourceRevision of [1, 2, 3]) {
        const result = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "ranked-tie",
              sourceRevision,
              conferenceKeys: ["conference:tie"],
              calendarEventKeys:
                sourceRevision === 2
                  ? ["calendar:tie-a"]
                  : ["calendar:tie-a", "calendar:tie-b"]
            })
          })
        );
        if (sourceRevision === 2) {
          expect(result).toMatchObject({
            state: "bound-high-confidence",
            logicalMeeting: { id: conference.logicalMeeting.id },
            matchEvidence: [{ kind: "shared-calendar-event" }]
          });
        } else {
          expect(result).toMatchObject({
            state: "ambiguous",
            matchEvidence: [],
            matchFactsDigest: null
          });
          expect(result.logicalMeeting.id).not.toBe(conference.logicalMeeting.id);
          expect(result.logicalMeeting.id).not.toBe(other.logicalMeeting.id);
          expect(result.logicalMeeting.captureRefs).toHaveLength(1);
          expect(result.candidates).toEqual(
            expect.arrayContaining([
              {
                logicalMeetingId: conference.logicalMeeting.id,
                evidence: [{ kind: "shared-calendar-event" }]
              },
              {
                logicalMeetingId: other.logicalMeeting.id,
                evidence: [{ kind: "shared-calendar-event" }]
              }
            ])
          );
        }
      }
    } finally {
      await database.close();
    }
  });

  it("serializes concurrent discovery of one shared calendar event into one LogicalMeeting", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const [notionResult, granolaResult] = await Promise.all([
        logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-concurrent",
            calendarEventKeys: ["calendar:event:concurrent"]
          })
        }),
        logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-note-concurrent",
            calendarEventKeys: ["calendar:event:concurrent"]
          })
        })
      ]);
      const notion = accepted(notionResult);
      const granola = accepted(granolaResult);

      expect(notion.logicalMeeting.id).toBe(granola.logicalMeeting.id);
      expect(
        (
          await logicalMeetings.get({
            workspaceId,
            logicalMeetingId: notion.logicalMeeting.id
          })
        )?.captureRefs
      ).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("does not treat a title alone as a logical-meeting match", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const first = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-title-1",
            titleFingerprint: "title:weekly-planning"
          })
        })
      );
      const sameTitle = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-note-title-1",
            titleFingerprint: "title:weekly-planning"
          })
        })
      );

      expect(sameTitle).toMatchObject({
        state: "separate",
        logicalMeeting: { captureRefs: [{ id: sameTitle.captureId }] },
        candidates: []
      });
      expect(sameTitle.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
    } finally {
      await database.close();
    }
  });

  it("reassesses a provisional not-ready capture once a later revision is ready", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const notReady = captureRevision({
        externalCaptureId: "notion-note-readiness",
        availability: "not-ready",
        capabilities: {
          enhancedNotes: "unknown",
          rawTranscript: "unknown",
          speakerIdentity: "unavailable",
          attendees: "unknown",
          revisionMetadata: "available"
        }
      });
      const initial = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: notReady })
      );
      const granola = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-note-readiness",
            calendarEventKeys: ["calendar:event:readiness"]
          })
        })
      );
      const ready = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-readiness",
            sourceRevision: 2,
            content: "notion note became ready",
            calendarEventKeys: ["calendar:event:readiness"]
          })
        })
      );

      expect(initial.logicalMeeting.id).not.toBe(granola.logicalMeeting.id);
      expect(ready).toMatchObject({
        effect: "revised",
        state: "bound-high-confidence",
        logicalMeeting: { id: granola.logicalMeeting.id },
        matchEvidence: [{ kind: "shared-calendar-event" }]
      });
      expect(ready.logicalMeeting.captureRefs).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("uses time plus resolved attendee identity for a high-confidence match and leaves multiple soft candidates ambiguous", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const attendeeMatched = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-attendees",
            interval: interval("2026-08-30T13:00:00.000Z", "2026-08-30T14:00:00.000Z"),
            attendeePersonIds: ["person:jakob", "person:fabius"]
          })
        })
      );
      const secondAttendeeCapture = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:fabius",
            externalCaptureId: "granola-note-attendees",
            interval: interval("2026-08-30T13:20:00.000Z", "2026-08-30T14:20:00.000Z"),
            attendeePersonIds: ["person:jakob", "person:fabius", "person:gamius"]
          })
        })
      );

      expect(secondAttendeeCapture).toMatchObject({
        state: "bound-high-confidence",
        logicalMeeting: { id: attendeeMatched.logicalMeeting.id },
        matchEvidence: [{ kind: "time-and-attendees", sharedAttendeeCount: 2 }]
      });

      const softFacts = {
        interval: interval("2026-08-30T15:00:00.000Z", "2026-08-30T16:00:00.000Z"),
        titleFingerprint: "title:review",
        contextKeys: ["project:luma"]
      };
      await logicalMeetings.resolveCapture({
        workspaceId,
        revision: captureRevision({
          externalCaptureId: "notion-note-soft-1",
          ...softFacts
        })
      });
      await logicalMeetings.resolveCapture({
        workspaceId,
        revision: captureRevision({
          providerId: "granola",
          providerConnectionId: "granola:other",
          externalCaptureId: "granola-note-soft-2",
          ...softFacts
        })
      });
      const ambiguous = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "other-provider",
            providerConnectionId: "other:jakob",
            externalCaptureId: "other-note-soft-3",
            ...softFacts
          })
        })
      );

      expect(ambiguous.state).toBe("ambiguous");
      expect(ambiguous.candidates).toHaveLength(2);
      expect(ambiguous.logicalMeeting.captureRefs).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it.each([
    { initialState: "candidate-match", targetCount: 1 },
    { initialState: "ambiguous", targetCount: 2 }
  ])(
    "clears an automatic $initialState when revised evidence has no candidates",
    async ({ initialState, targetCount }) => {
      const database = await createPgliteDatabase();

      try {
        const logicalMeetings = create(database, logicalVerifier());
        const softFacts = {
          interval: interval("2026-08-30T09:00:00.000Z", "2026-08-30T10:00:00.000Z"),
          titleFingerprint: "title:architecture",
          contextKeys: ["project:luma"]
        };

        for (let index = 0; index < targetCount; index += 1) {
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: `notion-stale-candidate-${index}`,
              ...softFacts
            })
          });
        }

        const address = {
          providerId: "granola",
          providerConnectionId: "granola:jakob",
          externalCaptureId: "granola-stale-candidate"
        };
        const original = captureRevision({ ...address, ...softFacts });
        const first = accepted(
          await logicalMeetings.resolveCapture({ workspaceId, revision: original })
        );
        expect(first.state).toBe(initialState);
        expect(first.candidates).toHaveLength(targetCount);

        const corrected = captureRevision({ ...address, sourceRevision: 2 });
        const revised = accepted(
          await logicalMeetings.resolveCapture({ workspaceId, revision: corrected })
        );
        const expectedBinding = {
          captureId: first.captureId,
          state: "separate",
          origin: "automatic",
          candidates: [],
          matchEvidence: [],
          matchFactsDigest: null,
          logicalMeeting: { id: first.logicalMeeting.id }
        };

        expect(revised).toMatchObject({ ...expectedBinding, effect: "revised" });
        expect(
          await logicalMeetings.get({ workspaceId, captureId: first.captureId })
        ).toMatchObject({
          id: first.logicalMeeting.id,
          captureRefs: [
            {
              id: first.captureId,
              latestRevision: { sourceRevision: 2 },
              binding: { state: "separate", origin: "automatic" }
            }
          ]
        });

        for (const revision of [corrected, original]) {
          const replay = accepted(
            await logicalMeetings.resolveCapture({ workspaceId, revision })
          );
          expect(replay).toMatchObject({ ...expectedBinding, effect: "unchanged" });
          expect(replay.logicalMeeting.captureRefs).toHaveLength(1);
        }
      } finally {
        await database.close();
      }
    }
  );

  it("records candidate matches without silently binding, then preserves a Human bind across revisions", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const target = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-candidate",
            interval: interval("2026-08-30T09:00:00.000Z", "2026-08-30T10:00:00.000Z"),
            titleFingerprint: "title:architecture",
            contextKeys: ["project:luma"]
          })
        })
      );
      const candidateRevision = captureRevision({
        providerId: "granola",
        providerConnectionId: "granola:jakob",
        externalCaptureId: "granola-note-candidate",
        interval: interval("2026-08-30T09:15:00.000Z", "2026-08-30T10:15:00.000Z"),
        titleFingerprint: "title:architecture",
        contextKeys: ["project:luma"]
      });
      const candidate = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: candidateRevision })
      );

      expect(candidate).toMatchObject({
        state: "candidate-match",
        candidates: [
          {
            logicalMeetingId: target.logicalMeeting.id,
            evidence: [{ kind: "title-time-context" }]
          }
        ]
      });
      expect(candidate.logicalMeeting.id).not.toBe(target.logicalMeeting.id);

      const humanBound = accepted(
        await logicalMeetings.recordBindingJudgment({
          judgmentId: "judgment-bind-candidate",
          workspaceId,
          actorPersonId: "person:jakob",
          captureId: candidate.captureId,
          observedAt: "2026-08-30T10:30:00.000Z",
          reason: "Same scheduled architecture review.",
          judgment: { type: "bind", logicalMeetingId: target.logicalMeeting.id }
        })
      );
      const later = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: {
            ...candidateRevision,
            sourceRevision: 2,
            contentHash: contentHash("granola-candidate-revised"),
            externalReference: {
              ...candidateRevision.externalReference,
              version: contentHash("granola-candidate-revised")
            },
            identityFacts: {
              ...candidateRevision.identityFacts,
              calendarEventKeys: ["calendar:event:contradictory"]
            }
          }
        })
      );

      expect(humanBound).toMatchObject({
        state: "human-bound",
        origin: "human",
        logicalMeeting: { id: target.logicalMeeting.id }
      });
      expect(later).toMatchObject({
        state: "human-bound",
        origin: "human",
        effect: "revised",
        logicalMeeting: { id: target.logicalMeeting.id }
      });
    } finally {
      await database.close();
    }
  });

  it("replays the current Human binding after an earlier judgment has been superseded", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const target = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({ externalCaptureId: "notion-human-replay" })
        })
      );
      const revision = captureRevision({
        providerId: "granola",
        externalCaptureId: "granola-human-replay"
      });
      const capture = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision })
      );
      const bind: HumanCaptureBindingJudgment = {
        judgmentId: "bind-before-correction",
        workspaceId,
        actorPersonId: "person:jakob",
        captureId: capture.captureId,
        observedAt: "2026-08-30T10:00:00.000Z",
        reason: null,
        judgment: { type: "bind", logicalMeetingId: target.logicalMeeting.id }
      };
      await logicalMeetings.recordBindingJudgment(bind);
      const separate = accepted(
        await logicalMeetings.recordBindingJudgment({
          ...bind,
          judgmentId: "separate-after-correction",
          observedAt: "2026-08-30T10:05:00.000Z",
          judgment: {
            type: "make-separate",
            rejectedLogicalMeetingId: target.logicalMeeting.id
          }
        })
      );
      const replay = accepted(await logicalMeetings.recordBindingJudgment(bind));

      expect(replay).toMatchObject({
        effect: "unchanged",
        state: "separate",
        origin: "human",
        captureId: capture.captureId,
        logicalMeeting: {
          id: separate.logicalMeeting.id,
          captureRefs: [
            { id: capture.captureId, binding: { state: "separate", origin: "human" } }
          ]
        }
      });
      expect(
        await logicalMeetings.get({ workspaceId, captureId: capture.captureId })
      ).toEqual(replay.logicalMeeting);

      await logicalMeetings.resolveCapture({
        workspaceId,
        revision: { ...revision, eligibility: { state: "excluded", reason: "private" } }
      });
      expect(await logicalMeetings.recordBindingJudgment(bind)).toMatchObject({
        status: "rejected",
        code: "ineligible-capture"
      });
    } finally {
      await database.close();
    }
  });

  it("persists a named Human separation and prevents that capture pair from re-merging", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const first = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-note-separate",
            conferenceKeys: ["conference:meet:abc"]
          })
        })
      );
      const secondRevision = captureRevision({
        providerId: "granola",
        providerConnectionId: "granola:jakob",
        externalCaptureId: "granola-note-separate",
        conferenceKeys: ["conference:meet:abc"]
      });
      const merged = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: secondRevision })
      );
      const separate = accepted(
        await logicalMeetings.recordBindingJudgment({
          judgmentId: "judgment-separate",
          workspaceId,
          actorPersonId: "person:jakob",
          captureId: merged.captureId,
          observedAt: "2026-08-30T12:00:00.000Z",
          reason: "Reused conference room, separate meeting.",
          judgment: {
            type: "make-separate",
            rejectedLogicalMeetingId: first.logicalMeeting.id
          }
        })
      );
      const later = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: {
            ...secondRevision,
            sourceRevision: 2,
            contentHash: contentHash("granola-separate-revised"),
            externalReference: {
              ...secondRevision.externalReference,
              version: contentHash("granola-separate-revised")
            }
          }
        })
      );

      expect(merged.logicalMeeting.id).toBe(first.logicalMeeting.id);
      expect(separate).toMatchObject({ state: "separate", origin: "human" });
      expect(separate.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
      expect(later).toMatchObject({
        state: "separate",
        origin: "human",
        logicalMeeting: { id: separate.logicalMeeting.id }
      });
    } finally {
      await database.close();
    }
  });

  it.each([false, true])(
    "preserves Human separation through a third capture (excluded member withheld: %s)",
    async (withheld) => {
      const database = await createPgliteDatabase();

      try {
        const logicalMeetings = create(database, logicalVerifier());
        const first = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "separation-a",
              calendarEventKeys: ["calendar:separation"],
              conferenceKeys: ["conference:separation"]
            })
          })
        );
        const second = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "separation-b",
              calendarEventKeys: ["calendar:separation"]
            })
          })
        );
        expect(second.logicalMeeting.id).toBe(first.logicalMeeting.id);
        const separated = accepted(
          await logicalMeetings.recordBindingJudgment({
            judgmentId: "separate-a-from-b",
            workspaceId,
            actorPersonId: "person:jakob",
            captureId: first.captureId,
            observedAt: "2026-08-30T12:00:00.000Z",
            reason: "These are different meetings despite the shared calendar reference.",
            judgment: {
              type: "make-separate",
              rejectedLogicalMeetingId: first.logicalMeeting.id
            }
          })
        );
        const bridge = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "separation-c",
              conferenceKeys: ["conference:separation"]
            })
          })
        );
        expect(bridge.logicalMeeting.id).toBe(separated.logicalMeeting.id);
        if (withheld) {
          expect(
            await logicalMeetings.resolveCapture({
              workspaceId,
              revision: {
                ...captureRevision({
                  externalCaptureId: "separation-a",
                  sourceRevision: 2
                }),
                eligibility: { state: "excluded", reason: "private" }
              }
            })
          ).toMatchObject({ status: "excluded" });
        }
        const later = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "separation-b",
              sourceRevision: 2,
              calendarEventKeys: ["calendar:separation"],
              conferenceKeys: ["conference:separation"]
            })
          })
        );
        expect(later.state).toBe("separate");
        expect(later.logicalMeeting.id).not.toBe(bridge.logicalMeeting.id);
        expect(later.logicalMeeting.captureRefs.map((capture) => capture.id)).toEqual([
          second.captureId
        ]);
        expect(
          (
            await logicalMeetings.get({ workspaceId, captureId: bridge.captureId })
          )?.captureRefs.map((capture) => capture.id)
        ).not.toContain(second.captureId);
      } finally {
        await database.close();
      }
    }
  );

  it.each(["separate", "candidate-match", "ambiguous"] as const)(
    "isolates a founding capture when its identity degrades to %s",
    async (expectedState) => {
      const database = await createPgliteDatabase();

      try {
        const logicalMeetings = create(database, logicalVerifier());
        const softFacts = {
          titleFingerprint: "planning",
          contextKeys: ["project:luma"],
          interval: interval("2026-08-30T09:00:00.000Z", "2026-08-30T10:00:00.000Z")
        };
        const first = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "founder",
              calendarEventKeys: ["calendar:founder"],
              ...softFacts
            })
          })
        );
        const second = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: "follower",
              calendarEventKeys: ["calendar:founder"],
              ...softFacts
            })
          })
        );
        expect(first.state).toBe("separate");
        expect(second.logicalMeeting.id).toBe(first.logicalMeeting.id);
        if (expectedState === "ambiguous") {
          accepted(
            await logicalMeetings.resolveCapture({
              workspaceId,
              revision: captureRevision({
                externalCaptureId: "other-soft-candidate",
                ...softFacts
              })
            })
          );
        }
        const revision = captureRevision({
          externalCaptureId: "founder",
          sourceRevision: 2,
          ...(expectedState === "separate" ? {} : softFacts)
        });
        const revised = accepted(
          await logicalMeetings.resolveCapture({ workspaceId, revision })
        );
        expect(revised.state).toBe(expectedState);
        expect(revised.logicalMeeting.id).not.toBe(second.logicalMeeting.id);
        expect(revised.logicalMeeting.captureRefs.map((capture) => capture.id)).toEqual([
          first.captureId
        ]);
        expect(
          (
            await logicalMeetings.get({ workspaceId, captureId: second.captureId })
          )?.captureRefs.map((capture) => capture.id)
        ).toEqual([second.captureId]);
        expect(
          accepted(await logicalMeetings.resolveCapture({ workspaceId, revision }))
        ).toMatchObject({
          effect: "unchanged",
          logicalMeeting: { id: revised.logicalMeeting.id }
        });
      } finally {
        await database.close();
      }
    }
  );

  it("keeps capture and logical identities workspace-scoped and fails closed on fidelity violations", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const valid = captureRevision({ externalCaptureId: "shared-external-id" });
      const inFirstWorkspace = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: valid })
      );
      const inSecondWorkspace = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId: "workspace_other",
          revision: valid
        })
      );
      const invalid = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...captureRevision({
            externalCaptureId: "invalid-granola-basic",
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            capabilities: {
              enhancedNotes: "available",
              rawTranscript: "unavailable",
              speakerIdentity: "unavailable",
              attendees: "unavailable",
              revisionMetadata: "available"
            }
          }),
          materials: [
            material({
              providerId: "granola",
              kind: "verbatim-transcript",
              provenance: "original-speech"
            })
          ]
        }
      });
      const privateCapture = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...captureRevision({ externalCaptureId: "private-capture" }),
          eligibility: { state: "excluded", reason: "private" }
        }
      });

      expect(inSecondWorkspace.captureId).not.toBe(inFirstWorkspace.captureId);
      expect(inSecondWorkspace.logicalMeeting.id).not.toBe(
        inFirstWorkspace.logicalMeeting.id
      );
      expect(invalid).toMatchObject({
        status: "rejected",
        code: "invalid-capture-revision",
        retryable: false
      });
      expect(privateCapture).toMatchObject({
        status: "excluded",
        captureId: null
      });
    } finally {
      await database.close();
    }
  });

  it("canonicalizes omitted optional source-reference metadata without storing invalid JSON", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const revision = captureRevision({
        externalCaptureId: "optional-reference-version"
      });
      const externalReference = { ...revision.externalReference };
      delete externalReference.version;
      const withoutOptionalVersion: MeetingCaptureRevision = {
        ...revision,
        externalReference
      };

      const first = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: withoutOptionalVersion
        })
      );
      const replay = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: withoutOptionalVersion
        })
      );

      expect(replay).toMatchObject({
        captureId: first.captureId,
        effect: "unchanged"
      });
    } finally {
      await database.close();
    }
  });

  it("retains a verified eligibility withdrawal and removes the capture from automatic matching", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const original = captureRevision({
        externalCaptureId: "notion-note-withdrawal",
        calendarEventKeys: ["calendar:event:withdrawal"]
      });
      const first = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: original })
      );
      const withdrawn = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...captureRevision({
            externalCaptureId: "notion-note-withdrawal",
            sourceRevision: 2,
            content: "eligibility withdrawn",
            calendarEventKeys: ["calendar:event:withdrawal"]
          }),
          eligibility: { state: "excluded", reason: "private" }
        }
      });
      const laterCapture = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-note-withdrawal",
            calendarEventKeys: ["calendar:event:withdrawal"]
          })
        })
      );
      const attemptedHumanBind = await logicalMeetings.recordBindingJudgment({
        judgmentId: "judgment-bind-withdrawn-capture",
        workspaceId,
        actorPersonId: "person:jakob",
        captureId: first.captureId,
        observedAt: "2026-08-30T12:30:00.000Z",
        reason: "This must not override a privacy withdrawal.",
        judgment: { type: "bind", logicalMeetingId: laterCapture.logicalMeeting.id }
      });

      expect(withdrawn).toMatchObject({
        status: "excluded",
        captureId: first.captureId
      });
      expect(laterCapture).toMatchObject({ state: "separate" });
      expect(laterCapture.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
      expect(attemptedHumanBind).toMatchObject({
        status: "rejected",
        code: "ineligible-capture",
        retryable: false
      });
      expect(
        (
          await logicalMeetings.get({
            workspaceId,
            logicalMeetingId: first.logicalMeeting.id
          })
        )?.captureRefs
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("lets an equal-revision privacy withdrawal override an earlier eligible admission", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const original = captureRevision({
        externalCaptureId: "notion-note-same-revision-withdrawal",
        calendarEventKeys: ["calendar:event:same-revision-withdrawal"]
      });
      const first = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: original })
      );
      const withdrawn = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...original,
          eligibility: { state: "excluded", reason: "private" }
        }
      });
      const laterCapture = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-note-same-revision-withdrawal",
            calendarEventKeys: ["calendar:event:same-revision-withdrawal"]
          })
        })
      );
      const attemptedHumanBind = await logicalMeetings.recordBindingJudgment({
        judgmentId: "judgment-bind-same-revision-withdrawn-capture",
        workspaceId,
        actorPersonId: "person:jakob",
        captureId: first.captureId,
        observedAt: "2026-08-30T12:45:00.000Z",
        reason: "A same-revision privacy withdrawal must take precedence.",
        judgment: { type: "bind", logicalMeetingId: laterCapture.logicalMeeting.id }
      });

      expect(withdrawn).toMatchObject({
        status: "excluded",
        captureId: first.captureId
      });
      expect(laterCapture).toMatchObject({ state: "separate" });
      expect(laterCapture.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
      expect(attemptedHumanBind).toMatchObject({
        status: "rejected",
        code: "ineligible-capture",
        retryable: false
      });
      expect(
        (
          await logicalMeetings.get({
            workspaceId,
            logicalMeetingId: first.logicalMeeting.id
          })
        )?.captureRefs
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it.each(["private", "policy"] as const)(
    "keeps a same-revision %s withdrawal terminal after a Human import",
    async (reason) => {
      const database = await createPgliteDatabase();

      try {
        const logicalMeetings = create(database, logicalVerifier());
        const original = captureRevision({
          externalCaptureId: `notion-note-terminal-withdrawal-${reason}`,
          calendarEventKeys: [`calendar:event:terminal-withdrawal-${reason}`]
        });
        const first = accepted(
          await logicalMeetings.resolveCapture({ workspaceId, revision: original })
        );
        const importable: MeetingCaptureRevision = {
          ...original,
          eligibility: { state: "requires-human-import" }
        };
        const heldForHuman = await logicalMeetings.resolveCapture({
          workspaceId,
          revision: importable
        });
        const judgment = {
          judgmentId: `judgment-import-terminal-withdrawal-${reason}`,
          workspaceId,
          actorPersonId: "person:jakob",
          observedAt: "2026-08-30T13:15:00.000Z",
          reason: "This is an organizational Dayova meeting.",
          revision: importable
        };
        const imported = accepted(await logicalMeetings.importCapture(judgment));
        const withdrawn = await logicalMeetings.resolveCapture({
          workspaceId,
          revision: {
            ...original,
            eligibility: { state: "excluded", reason }
          }
        });
        const replayedImport = await logicalMeetings.importCapture(judgment);
        const laterCapture = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              providerId: "granola",
              providerConnectionId: "granola:jakob",
              externalCaptureId: `granola-note-terminal-withdrawal-${reason}`,
              calendarEventKeys: [`calendar:event:terminal-withdrawal-${reason}`]
            })
          })
        );
        const attemptedHumanBind = await logicalMeetings.recordBindingJudgment({
          judgmentId: `judgment-bind-terminal-withdrawal-${reason}`,
          workspaceId,
          actorPersonId: "person:jakob",
          captureId: first.captureId,
          observedAt: "2026-08-30T13:20:00.000Z",
          reason: "A terminal withdrawal must prevent further binding.",
          judgment: { type: "bind", logicalMeetingId: laterCapture.logicalMeeting.id }
        });
        const recovered = accepted(
          await logicalMeetings.resolveCapture({
            workspaceId,
            revision: captureRevision({
              externalCaptureId: original.address.externalCaptureId,
              sourceRevision: 2,
              content: `new organizational revision after ${reason} withdrawal`,
              calendarEventKeys: [`calendar:event:terminal-withdrawal-${reason}`]
            })
          })
        );

        expect(heldForHuman).toMatchObject({
          status: "excluded",
          captureId: first.captureId
        });
        expect(imported).toMatchObject({
          captureId: first.captureId,
          effect: "unchanged",
          logicalMeeting: {
            captureRefs: [
              {
                admission: {
                  state: "human-imported",
                  judgmentId: judgment.judgmentId
                },
                latestRevision: {
                  eligibility: { state: "requires-human-import" }
                }
              }
            ]
          }
        });
        expect(withdrawn).toMatchObject({
          status: "excluded",
          captureId: first.captureId
        });
        expect(replayedImport).toMatchObject({
          status: "excluded",
          captureId: first.captureId
        });
        expect(laterCapture).toMatchObject({ state: "separate" });
        expect(laterCapture.logicalMeeting.id).not.toBe(first.logicalMeeting.id);
        expect(attemptedHumanBind).toMatchObject({
          status: "rejected",
          code: "ineligible-capture",
          retryable: false
        });
        expect(
          (
            await logicalMeetings.get({
              workspaceId,
              logicalMeetingId: first.logicalMeeting.id
            })
          )?.captureRefs
        ).toEqual([]);
        expect(recovered.captureId).toBe(first.captureId);
        expect(
          recovered.logicalMeeting.captureRefs.find(
            (capture) => capture.id === first.captureId
          )
        ).toMatchObject({ latestRevision: { sourceRevision: 2 } });
      } finally {
        await database.close();
      }
    }
  );

  it("does not mint a Human import behind a terminal same-revision withdrawal", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const terminal = captureRevision({
        externalCaptureId: "granola-terminal-withdrawal-first",
        calendarEventKeys: ["calendar:event:terminal-withdrawal-first"],
        eligibility: { state: "excluded", reason: "private" }
      });
      const first = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: terminal
      });
      const delayedHumanImport = await logicalMeetings.importCapture({
        judgmentId: "judgment-import-behind-terminal-withdrawal",
        workspaceId,
        actorPersonId: "person:jakob",
        observedAt: "2026-08-30T13:25:00.000Z",
        reason: "A delayed import must not reactivate private material.",
        revision: { ...terminal, eligibility: { state: "requires-human-import" } }
      });
      const delayedEligible = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: { ...terminal, eligibility: { state: "eligible" } }
      });
      const conflictingHash = contentHash("conflicting terminal source");
      const conflictingRevision = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...terminal,
          contentHash: conflictingHash,
          externalReference: {
            ...terminal.externalReference,
            version: conflictingHash
          }
        }
      });

      expect(first).toMatchObject({ status: "excluded", captureId: null });
      expect(delayedHumanImport).toMatchObject({
        status: "rejected",
        code: "ineligible-capture",
        retryable: false
      });
      expect(delayedEligible).toMatchObject({
        status: "rejected",
        code: "invalid-capture-revision",
        retryable: false
      });
      expect(conflictingRevision).toMatchObject({
        status: "rejected",
        code: "invalid-capture-revision",
        retryable: false
      });
    } finally {
      await database.close();
    }
  });

  it("does not let a delayed lower revision overwrite the current binding", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const calendarA = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-current-a",
            calendarEventKeys: ["calendar:event:current-a"]
          })
        })
      );
      const calendarB = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-current-b",
            calendarEventKeys: ["calendar:event:current-b"]
          })
        })
      );
      const current = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-out-of-order",
            sourceRevision: 2,
            content: "new calendar identity",
            calendarEventKeys: ["calendar:event:current-a"]
          })
        })
      );
      const delayed = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            providerId: "granola",
            providerConnectionId: "granola:jakob",
            externalCaptureId: "granola-out-of-order",
            sourceRevision: 1,
            content: "stale calendar identity",
            calendarEventKeys: ["calendar:event:current-b"]
          })
        })
      );

      expect(current.logicalMeeting.id).toBe(calendarA.logicalMeeting.id);
      expect(delayed).toMatchObject({
        captureId: current.captureId,
        effect: "unchanged",
        logicalMeeting: { id: calendarA.logicalMeeting.id }
      });
      expect(
        delayed.logicalMeeting.captureRefs.find(
          (capture) => capture.id === current.captureId
        )?.latestRevision.sourceRevision
      ).toBe(2);
      expect(delayed.logicalMeeting.id).not.toBe(calendarB.logicalMeeting.id);
    } finally {
      await database.close();
    }
  });

  it("keeps a newer withheld revision ahead of delayed older eligible material", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const withheld = captureRevision({
        externalCaptureId: "granola-withheld-head",
        sourceRevision: 2,
        content: "newer private source",
        calendarEventKeys: ["calendar:event:withheld"],
        eligibility: { state: "excluded", reason: "private" }
      });
      const first = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: withheld
      });
      const delayed = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: captureRevision({
          externalCaptureId: "granola-withheld-head",
          sourceRevision: 1,
          content: "delayed eligible source",
          calendarEventKeys: ["calendar:event:withheld"]
        })
      });
      const rejectedPrivateImport = await logicalMeetings.importCapture({
        judgmentId: "judgment-private-import",
        workspaceId,
        actorPersonId: "person:jakob",
        observedAt: "2026-08-30T12:45:00.000Z",
        reason: "A private exclusion is not overridable through the import path.",
        revision: withheld
      });
      const current = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "granola-withheld-head",
            sourceRevision: 3,
            content: "newer organizational source",
            calendarEventKeys: ["calendar:event:withheld"]
          })
        })
      );

      expect(first).toMatchObject({ status: "excluded", captureId: null });
      expect(delayed).toMatchObject({ status: "excluded", captureId: null });
      expect(rejectedPrivateImport).toMatchObject({
        status: "rejected",
        code: "conflicting-human-judgment"
      });
      expect(current.logicalMeeting.captureRefs).toMatchObject([
        { latestRevision: { sourceRevision: 3 } }
      ]);
    } finally {
      await database.close();
    }
  });

  it("requires a named Human import before admitting an ambiguous withheld capture", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const target = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-import-target",
            calendarEventKeys: ["calendar:event:human-import"]
          })
        })
      );
      const withheld = captureRevision({
        providerId: "granola",
        providerConnectionId: "granola:jakob",
        externalCaptureId: "granola-human-import",
        sourceKind: "enhanced-notes",
        calendarEventKeys: ["calendar:event:human-import"],
        eligibility: { state: "requires-human-import" },
        capabilities: {
          enhancedNotes: "available",
          rawTranscript: "unavailable",
          speakerIdentity: "unavailable",
          attendees: "partial",
          revisionMetadata: "available"
        }
      });
      const automatic = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: withheld
      });
      const adapterOnlyFlip = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: { ...withheld, eligibility: { state: "eligible" } }
      });
      const imported = accepted(
        await logicalMeetings.importCapture({
          judgmentId: "judgment-import-granola",
          workspaceId,
          actorPersonId: "person:jakob",
          observedAt: "2026-08-30T13:00:00.000Z",
          reason: "This is an organizational Dayova review meeting.",
          revision: withheld
        })
      );
      const replay = accepted(
        await logicalMeetings.importCapture({
          judgmentId: "judgment-import-granola",
          workspaceId,
          actorPersonId: "person:jakob",
          observedAt: "2026-08-30T13:00:00.000Z",
          reason: "This is an organizational Dayova review meeting.",
          revision: withheld
        })
      );

      expect(automatic).toMatchObject({ status: "excluded", captureId: null });
      expect(adapterOnlyFlip).toMatchObject({
        status: "rejected",
        code: "invalid-capture-revision"
      });
      expect(imported).toMatchObject({
        state: "bound-high-confidence",
        logicalMeeting: { id: target.logicalMeeting.id }
      });
      expect(
        imported.logicalMeeting.captureRefs.find(
          (capture) => capture.id === imported.captureId
        )?.admission
      ).toMatchObject({
        state: "human-imported",
        judgmentId: "judgment-import-granola",
        actorPersonId: "person:jakob"
      });
      expect(replay).toMatchObject({
        captureId: imported.captureId,
        effect: "unchanged"
      });
    } finally {
      await database.close();
    }
  });

  it("re-evaluates a corrected high-confidence automatic binding without overriding Human decisions", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const firstTarget = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-corrected-a",
            calendarEventKeys: ["calendar:event:corrected-a"]
          })
        })
      );
      const secondTarget = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-corrected-b",
            calendarEventKeys: ["calendar:event:corrected-b"]
          })
        })
      );
      const original = captureRevision({
        providerId: "granola",
        providerConnectionId: "granola:jakob",
        externalCaptureId: "granola-corrected-binding",
        sourceRevision: 1,
        content: "calendar a",
        calendarEventKeys: ["calendar:event:corrected-a"]
      });
      const first = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: original })
      );
      const corrected = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: {
            ...original,
            sourceRevision: 2,
            contentHash: contentHash("calendar b"),
            externalReference: {
              ...original.externalReference,
              version: contentHash("calendar b")
            },
            identityFacts: {
              ...original.identityFacts,
              calendarEventKeys: ["calendar:event:corrected-b"]
            }
          }
        })
      );
      const unsupported = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: {
            ...original,
            sourceRevision: 3,
            contentHash: contentHash("calendar absent"),
            externalReference: {
              ...original.externalReference,
              version: contentHash("calendar absent")
            },
            identityFacts: {
              ...original.identityFacts,
              calendarEventKeys: ["calendar:event:corrected-absent"]
            }
          }
        })
      );

      expect(first.logicalMeeting.id).toBe(firstTarget.logicalMeeting.id);
      expect(corrected).toMatchObject({
        state: "bound-high-confidence",
        logicalMeeting: { id: secondTarget.logicalMeeting.id }
      });
      expect(unsupported).toMatchObject({ state: "separate" });
      expect(unsupported.logicalMeeting.id).not.toBe(secondTarget.logicalMeeting.id);
      expect(unsupported.logicalMeeting.captureRefs).toMatchObject([
        { latestRevision: { sourceRevision: 3 } }
      ]);
    } finally {
      await database.close();
    }
  });

  it("re-evaluates automatic matching after a Human admits a later withheld revision", async () => {
    const database = await createPgliteDatabase();

    try {
      const logicalMeetings = create(database, logicalVerifier());
      const targetA = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-import-correction-a",
            calendarEventKeys: ["calendar:event:import-correction-a"]
          })
        })
      );
      const targetB = accepted(
        await logicalMeetings.resolveCapture({
          workspaceId,
          revision: captureRevision({
            externalCaptureId: "notion-import-correction-b",
            calendarEventKeys: ["calendar:event:import-correction-b"]
          })
        })
      );
      const original = captureRevision({
        providerId: "granola",
        providerConnectionId: "granola:jakob",
        externalCaptureId: "granola-import-correction",
        sourceRevision: 1,
        content: "original automatic identity",
        calendarEventKeys: ["calendar:event:import-correction-a"]
      });
      const first = accepted(
        await logicalMeetings.resolveCapture({ workspaceId, revision: original })
      );
      const withheldCorrection: MeetingCaptureRevision = {
        ...original,
        sourceRevision: 2,
        contentHash: contentHash("withheld corrected identity"),
        externalReference: {
          ...original.externalReference,
          version: contentHash("withheld corrected identity")
        },
        eligibility: { state: "requires-human-import" },
        identityFacts: {
          ...original.identityFacts,
          calendarEventKeys: ["calendar:event:import-correction-b"]
        }
      };

      await logicalMeetings.resolveCapture({
        workspaceId,
        revision: withheldCorrection
      });
      const imported = accepted(
        await logicalMeetings.importCapture({
          judgmentId: "judgment-import-correction",
          workspaceId,
          actorPersonId: "person:jakob",
          observedAt: "2026-08-30T13:15:00.000Z",
          reason: "The revised organizational capture is approved.",
          revision: withheldCorrection
        })
      );

      expect(first.logicalMeeting.id).toBe(targetA.logicalMeeting.id);
      expect(imported).toMatchObject({
        state: "bound-high-confidence",
        logicalMeeting: { id: targetB.logicalMeeting.id }
      });
    } finally {
      await database.close();
    }
  });

  it("reopens the durable capture binding without re-evaluating a stored revision", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "luma-logical-meetings-"));
    const dataDir = join(temporaryRoot, "pglite");
    const revision = captureRevision({
      externalCaptureId: "notion-note-durable",
      calendarEventKeys: ["calendar:event:durable"]
    });
    let database = await createPgliteDatabase(dataDir);

    try {
      const first = accepted(
        await create(database, logicalVerifier()).resolveCapture({
          workspaceId,
          revision
        })
      );
      await database.close();
      database = await createPgliteDatabase(dataDir);

      const replay = accepted(
        await create(database, logicalVerifier()).resolveCapture({
          workspaceId,
          revision
        })
      );

      expect(replay).toMatchObject({
        effect: "unchanged",
        captureId: first.captureId,
        logicalMeeting: { id: first.logicalMeeting.id }
      });
    } finally {
      await database.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

function create(
  database: Awaited<ReturnType<typeof createPgliteDatabase>>,
  captureRevisionVerifier: CaptureRevisionVerifier
) {
  let nextId = 0;
  const input: Omit<CreateLogicalMeetingsInput, "database"> = {
    captureRevisionVerifier,
    now: () => new Date("2026-08-30T08:00:00.000Z"),
    createOpaqueId: () => `${++nextId}`
  };

  return createLogicalMeetings({ ...input, database });
}

function logicalVerifier(): CaptureRevisionVerifier {
  return { verify: () => Promise.resolve({ status: "verified" }) };
}

function accepted(result: LogicalMeetingBindingResult) {
  if (result.status !== "accepted") {
    throw new Error(`Expected an accepted LogicalMeeting result: ${result.message}`);
  }

  return result.decision;
}

function captureRevision(input: {
  providerId?: string;
  providerConnectionId?: string;
  externalCaptureId: string;
  sourceKind?: string;
  sourceRevision?: number;
  content?: string;
  calendarEventKeys?: string[];
  conferenceKeys?: string[];
  interval?: { startedAt: string; endedAt: string } | null;
  attendeePersonIds?: string[];
  titleFingerprint?: string | null;
  contextKeys?: string[];
  capabilities?: MeetingCaptureRevision["capabilities"];
  materials?: MeetingCaptureRevision["materials"];
  availability?: MeetingCaptureRevision["availability"];
  eligibility?: MeetingCaptureRevision["eligibility"];
}): MeetingCaptureRevision {
  const providerId = input.providerId ?? "notion";
  const sourceRevision = input.sourceRevision ?? 1;
  const hash = contentHash(
    input.content ?? `${input.externalCaptureId}:${sourceRevision}`
  );

  return {
    address: {
      providerId,
      providerConnectionId: input.providerConnectionId ?? `${providerId}:jakob`,
      externalCaptureId: input.externalCaptureId,
      sourceKind: input.sourceKind ?? "meeting-note"
    },
    sourceRevision,
    contentHash: hash,
    providerVersion: `v${sourceRevision}`,
    capturedAt: "2026-08-30T08:00:00.000Z",
    eligibility: input.eligibility ?? { state: "eligible" },
    availability: input.availability ?? "complete",
    capabilities: input.capabilities ?? {
      enhancedNotes: "available",
      rawTranscript: "available",
      speakerIdentity: "partial",
      attendees: "partial",
      revisionMetadata: "available"
    },
    identityFacts: {
      calendarEventKeys: input.calendarEventKeys ?? [],
      conferenceKeys: input.conferenceKeys ?? [],
      interval: input.interval ?? null,
      attendeePersonIds: input.attendeePersonIds ?? [],
      titleFingerprint: input.titleFingerprint ?? null,
      contextKeys: input.contextKeys ?? []
    },
    materials: input.materials ?? [],
    externalReference: {
      providerId,
      objectType: "document",
      externalId: `external:${input.externalCaptureId}`,
      url: `https://example.test/${providerId}/${input.externalCaptureId}`,
      version: hash
    }
  };
}

function material(input: {
  providerId: string;
  kind: MeetingCaptureRevision["materials"][number]["kind"];
  provenance: MeetingCaptureRevision["materials"][number]["provenance"];
}): MeetingCaptureRevision["materials"][number] {
  return {
    kind: input.kind,
    provenance: input.provenance,
    sourceObjectId: "provider-block-1",
    sourceVersion: "1",
    externalReference: {
      providerId: input.providerId,
      objectType: "document",
      externalId: "provider-note-1",
      url: "https://example.test/provider-note-1",
      version: "1"
    }
  };
}

function interval(startedAt: string, endedAt: string) {
  return { startedAt, endedAt };
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
