import { describe, expect, it, vi } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import type { MeetingCaptureRevision } from "../../src/logical-meetings/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingCaptureIngestion } from "../../src/knowledge/meeting-capture-ingestion.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import {
  createNotionMeetingSynthesisWriter,
  type NotionMeetingSynthesisTransport
} from "../../src/knowledge/notion-meeting-synthesis-writer.js";
import { parseMeetingSynthesisSection } from "../../src/knowledge/meeting-synthesis-markdown.js";
import { readSynthesisPublication } from "../../src/meeting-intelligence/synthesis-publication-state.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
import type { FollowUpIntentApproved } from "../../src/domain/model.js";
import { acquireOperationalOutcomePageLease } from "../../src/follow-up-execution/operational-outcome-settlement.js";
import { MeetingSynthesisWriteNotAppliedError } from "../../src/knowledge/meeting-synthesis-writer.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z";
const parent = "11111111-1111-4111-8111-111111111111",
  native = "22222222-2222-4222-8222-222222222222",
  imported = "33333333-3333-4333-8333-333333333333";
const signingKey = "test-synthesis-key-012345678901234567890";
const original =
  "Native Meeting Notes\nOriginal transcript: Wir könnten starten.\nOriginal provider summary\n## Luma — Operational Outcome\nExisting separately-owned outcome";
async function setup(nativeAnchor = false, useSdk = false) {
  const database = await createPgliteDatabase();
  let sourceAllowed = true,
    targetAllowed = true,
    modelCalls = 0,
    mutations = 0,
    loseResponse = false,
    applyUnknown = true;
  let afterMutation: (() => Promise<void> | void) | undefined;
  const pages = new Map<
    string,
    { markdown: string; key: string | null; version: number }
  >();
  if (nativeAnchor) pages.set(native, { markdown: original, key: null, version: 1 });
  const head = (id: string) => ({
    object: "page",
    id,
    url: `https://www.notion.so/${id.replaceAll("-", "")}`,
    archived: false,
    in_trash: false,
    last_edited_time: `v${pages.get(id)!.version}`,
    parent: { type: "data_source_id", data_source_id: parent }
  });
  const normalize = (markdown: string) =>
    markdown
      .split("\n")
      .filter((line) => line !== "")
      .join("\n");
  const mutate = async (action: () => unknown) => {
    mutations++;
    let result: unknown;
    if (!loseResponse || applyUnknown) result = action();
    await afterMutation?.();
    if (loseResponse) throw new Error("Provider response lost after possible mutation");
    return result;
  };
  const transport: NotionMeetingSynthesisTransport = {
    find: ({ key }) =>
      Promise.resolve({
        results: [...pages]
          .filter(([, page]) => page.key === key)
          .map(([id]) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null
      }),
    readPage: (id) => Promise.resolve(head(id)),
    readMarkdown: (id) =>
      Promise.resolve({
        object: "page_markdown",
        id,
        markdown: pages.get(id)!.markdown,
        truncated: false,
        unknown_block_ids: []
      }),
    create: ({ key, markdown }) =>
      mutate(() => {
        pages.set(imported, { key, markdown: normalize(markdown), version: 1 });
        return head(imported);
      }),
    insert: ({ pageId, markdown }) =>
      mutate(() => {
        const p = pages.get(pageId)!;
        p.markdown = normalize(p.markdown + markdown);
        p.version++;
        return {
          object: "page_markdown",
          id: pageId,
          markdown: p.markdown,
          truncated: false,
          unknown_block_ids: []
        };
      }),
    replace: ({ pageId, before, after }) =>
      mutate(() => {
        const p = pages.get(pageId)!;
        if (p.markdown.split(before).length !== 2)
          throw new Error("Exact owned region not found uniquely");
        p.markdown = normalize(p.markdown.replace(before, after));
        p.version++;
        return {
          object: "page_markdown",
          id: pageId,
          markdown: p.markdown,
          truncated: false,
          unknown_block_ids: []
        };
      })
  };
  const httpFetch: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url
    );
    if (url.origin !== "https://api.notion.com")
      throw new Error("Unexpected provider origin");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      filter: { property: string; rich_text: { equals: string } };
      markdown: string;
      properties: Record<
        string,
        {
          title?: Array<{ text: { content: string } }>;
          rich_text?: Array<{ text: { content: string } }>;
        }
      >;
      type: string;
      insert_content: { content: string };
      update_content: { content_updates: Array<{ old_str: string; new_str: string }> };
    };
    const parts = url.pathname.split("/");
    let value: unknown;
    if (url.pathname === `/v1/data_sources/${parent}/query`)
      value = await transport.find({
        dataSourceId: parent,
        keyProperty: body.filter.property,
        key: body.filter.rich_text.equals
      });
    else if (url.pathname === "/v1/pages" && init?.method === "POST")
      value = await transport.create({
        dataSourceId: parent,
        titleProperty: "Name",
        keyProperty: "Luma Meeting ID",
        title: body.properties["Name"]!.title![0]!.text.content,
        key: body.properties["Luma Meeting ID"]!.rich_text![0]!.text.content,
        markdown: body.markdown
      });
    else if (parts[2] === "pages" && parts.length === 4)
      value = await transport.readPage(parts[3]!);
    else if (parts[2] === "pages" && parts[4] === "markdown") {
      if (init?.method === "GET") value = await transport.readMarkdown(parts[3]!);
      else if (body.type === "insert_content")
        value = await transport.insert({
          pageId: parts[3]!,
          markdown: body.insert_content.content
        });
      else
        value = await transport.replace({
          pageId: parts[3]!,
          before: body.update_content.content_updates[0]!.old_str,
          after: body.update_content.content_updates[0]!.new_str
        });
    } else throw new Error("Unexpected Notion request");
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ref = {
    providerId: nativeAnchor ? "notion" : "granola",
    objectType: "document" as const,
    externalId: nativeAnchor ? native : "capture-person-jakob",
    url: nativeAnchor
      ? `https://www.notion.so/${native.replaceAll("-", "")}`
      : "https://notes.granola.ai/meeting/capture-person-jakob"
  };
  const revision: MeetingCaptureRevision = {
    address: {
      providerId: ref.providerId,
      providerConnectionId: "founder-source",
      externalCaptureId: ref.externalId,
      sourceKind: "meeting-capture"
    },
    sourceRevision: 1,
    contentHash: "capture-hash-1",
    capturedAt: at,
    providerVersion: "v1",
    eligibility: { state: "eligible" },
    availability: "partial",
    capabilities: {
      rawTranscript: "unavailable",
      enhancedNotes: "available",
      speakerIdentity: "unavailable",
      attendees: "unavailable",
      revisionMetadata: "available"
    },
    identityFacts: {
      calendarEventKeys: [],
      conferenceKeys: [],
      interval: null,
      attendeePersonIds: [],
      titleFingerprint: "weekly",
      contextKeys: []
    },
    materials: [
      {
        kind: "derived-notes",
        provenance: "provider-derived",
        sourceObjectId: "notes-root",
        sourceVersion: "1",
        externalReference: ref
      }
    ],
    externalReference: ref
  };
  const logicalMeetings = createLogicalMeetings({
    database,
    captureRevisionVerifier: {
      verify: () => Promise.resolve({ status: "verified" as const })
    }
  });
  const model: ReasoningModel = {
    generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
      modelCalls++;
      const proposal: CaptureSynthesisProposal = {
        claims: [
          {
            key: "review-before-start",
            kind: "decision",
            text: "Wir könnten nach dem Review starten; literal `luma-synthesis:start:v1` remains source text.",
            evidenceIds: [request.evidence[0]!.evidenceId],
            quotations: [],
            conflictingKeys: [],
            confidence: "medium"
          }
        ]
      };
      return Promise.resolve({
        value: proposal as T,
        metadata: {
          provider: "fixture",
          model: "fixture",
          promptVersion: request.promptVersion
        }
      });
    }
  };
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: model,
    captureSynthesis: {
      logicalMeetings,
      audience: () =>
        Promise.resolve({
          workspaceId: workspace.workspaceId,
          personIds: ["person_jakob", "person_fabius"]
        }),
      access: {
        readCurrent: ({ capture }) => {
          if (!sourceAllowed) throw new Error("Source sharing revoked");
          return Promise.resolve({
            authorizationScopeId: "original-connection-grant",
            canonicalAnchorRef: nativeAnchor ? ref : null,
            materials: capture.latestRevision.materials.map((descriptor) => ({
              descriptor,
              text: "Wir könnten nach dem Review starten."
            }))
          });
        }
      }
    }
  });
  const bound = await logicalMeetings.resolveCapture({
    workspaceId: workspace.workspaceId,
    revision
  });
  if (bound.status !== "accepted") throw new Error("Capture fixture was not accepted");
  const meetingId = bound.decision.logicalMeeting.id;
  const ingestion = createMeetingCaptureIngestion({ workspace, meetingIntelligence: mi });
  expect(await ingestion.ingest(bound.decision.logicalMeeting)).toMatchObject({
    analysisStatus: "completed"
  });
  const writer = createNotionMeetingSynthesisWriter({
    workspaceId: workspace.workspaceId,
    importedMeetingsDataSourceId: parent,
    token: "test-token",
    signingKey,
    authorize: () => Promise.resolve(targetAllowed),
    ...(useSdk ? { fetch: httpFetch } : { transport })
  });
  const executor = createFollowUpExecution({
    database,
    meetingIntelligence: mi,
    meetingSynthesisWriter: writer,
    now: () => new Date(at)
  });
  const conclude = () => mi.conclude({ workspaceId: workspace.workspaceId, meetingId });
  let observations = 0;
  const approve = async (actor = "person_jakob") => {
    const conclusion = await conclude(),
      intent = conclusion.followUpIntentions[0]!;
    const observation: FollowUpIntentApproved = {
      type: "follow-up-intent-approved",
      observationId: `approve-${++observations}`,
      workspaceId: workspace.workspaceId,
      meetingId,
      occurredAt: at,
      observedAt: at,
      intentId: intent.id,
      approvedBy: actor
    };
    return {
      intentId: intent.id,
      update: await mi.observe({ workspace, observations: [observation] })
    };
  };
  return {
    database,
    mi,
    executor,
    pages,
    conclude,
    approve,
    meetingId,
    writer,
    mutations: () => mutations,
    modelCalls: () => modelCalls,
    setSourceAllowed: (value: boolean) => {
      sourceAllowed = value;
    },
    setTargetAllowed: (value: boolean) => {
      targetAllowed = value;
    },
    setLostResponse: (applied: boolean) => {
      loseResponse = true;
      applyUnknown = applied;
    },
    afterMutation: (hook: () => Promise<void> | void) => {
      afterMutation = hook;
    }
  };
}

describe("Capture synthesis approved canonical publication", () => {
  it("refuses a forged execution receipt and an approval for a superseded Human revision", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        first = (await f.conclude()).captureSynthesis!;
      expect(
        (
          await f.mi.observe({
            workspace,
            observations: [
              {
                type: "follow-up-execution-recorded",
                observationId: "forged-receipt",
                workspaceId: workspace.workspaceId,
                meetingId: f.meetingId,
                occurredAt: at,
                observedAt: at,
                intentId,
                executionLeaseId: "invented",
                outcome: { status: "succeeded", externalReferences: [] }
              }
            ]
          })
        ).errors
      ).toHaveLength(1);
      expect(
        (
          await f.mi.observe({
            workspace,
            observations: [
              {
                type: "capture-synthesis-judgment-recorded",
                observationId: "superseding-human-revision",
                workspaceId: workspace.workspaceId,
                meetingId: f.meetingId,
                occurredAt: at,
                observedAt: at,
                participantId: "person_jakob",
                expectedSynthesisRevision: first.revision,
                claimId: first.claims[0]!.id,
                judgment: { kind: "correct", text: "Review first." }
              }
            ]
          })
        ).errors
      ).toEqual([]);
      await expect(
        f.executor.execute({ workspace, meetingId: f.meetingId, intentId })
      ).rejects.toThrow(/current/u);
      expect(f.mutations()).toBe(0);
    } finally {
      await f.database.close();
    }
  });
  it("respects the physical-page lease shared with operational outcome writes", async () => {
    const f = await setup(true);
    try {
      await acquireOperationalOutcomePageLease({
        database: f.database,
        workspaceId: workspace.workspaceId,
        meetingId: "other-meeting",
        intentId: "other-outcome",
        target: {
          workspaceId: workspace.workspaceId,
          providerId: "notion",
          page: {
            providerId: "notion",
            objectType: "document",
            externalId: native,
            url: `https://www.notion.so/${native.replaceAll("-", "")}`
          },
          sourceObjectId: "native-source-root",
          sourceRevision: 1,
          sourceContentHash: "source-hash"
        },
        executionLeaseId: "other-lease",
        now: new Date(at)
      });
      const { intentId } = await f.approve();
      await expect(
        f.executor.execute({ workspace, meetingId: f.meetingId, intentId })
      ).rejects.toThrow(/did not reach/u);
      expect(f.mutations()).toBe(0);
      expect(
        (
          await f.database.query<{ intent_id: string }>(
            "SELECT intent_id FROM operational_outcome_page_leases"
          )
        ).rows
      ).toEqual([{ intent_id: "other-outcome" }]);
    } finally {
      await f.database.close();
    }
  });
  it("aborts a stalled production HTTP body without waiting forever on stream cancellation", async () => {
    const f = await setup(true);
    try {
      const conclusion = await f.conclude();
      let aborted = false,
        beforeWrite = false;
      const writer = createNotionMeetingSynthesisWriter({
        workspaceId: workspace.workspaceId,
        importedMeetingsDataSourceId: parent,
        token: "test-token",
        signingKey,
        authorize: () => Promise.resolve(true),
        fetch: (_request, init) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull: () => new Promise<void>(() => {}),
                cancel: () => new Promise<void>(() => {})
              }),
              { status: 200 }
            )
          );
        }
      });
      vi.useFakeTimers();
      const outcome = writer
        .publish({
          publication: {
            workspaceId: workspace.workspaceId,
            logicalMeetingId: f.meetingId,
            intentId: conclusion.followUpIntentions[0]!.id,
            operationToken: "timeout-operation",
            audience: {
              workspaceId: workspace.workspaceId,
              personIds: ["person_jakob", "person_fabius"]
            },
            synthesis: conclusion.captureSynthesis!,
            anchor: conclusion.captureSynthesis!.canonicalAnchorRef
          },
          requireCurrent: () => Promise.resolve(),
          beforeWrite: () => {
            beforeWrite = true;
            return Promise.resolve();
          },
          recordApplied: () => Promise.resolve()
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await outcome).toBeInstanceOf(MeetingSynthesisWriteNotAppliedError);
      expect(aborted).toBe(true);
      expect(beforeWrite).toBe(false);
    } finally {
      vi.useRealTimers();
      await f.database.close();
    }
  });
  it.each([false, true])(
    "publishes once to the correct canonical anchor and only replaces its owned section (native=%s)",
    async (nativeAnchor) => {
      const f = await setup(nativeAnchor, true);
      try {
        const initial = await f.conclude();
        expect(initial.captureSynthesis?.coverage).toBe("partial");
        expect(initial.decisions).toEqual([]);
        const request = {
          workspace,
          meetingId: f.meetingId,
          intentId: initial.followUpIntentions[0]!.id
        };
        await expect(f.executor.execute(request)).rejects.toThrow(/approved/u);
        expect(f.mutations()).toBe(0);
        expect((await f.approve("person_guest")).update.errors).toHaveLength(1);
        expect((await f.approve()).update.errors).toEqual([]);
        expect((await f.executor.execute(request)).observation.outcome.status).toBe(
          "succeeded"
        );
        await f.executor.execute(request);
        expect(f.mutations()).toBe(1);
        const page = f.pages.get(nativeAnchor ? native : imported)!;
        if (nativeAnchor) expect(page.markdown.startsWith(original)).toBe(true);
        else expect(page.markdown.startsWith("# Imported Meeting Record")).toBe(true);
        const parsed = parseMeetingSynthesisSection(page.markdown, signingKey)!;
        expect(parsed.publication.synthesis.claims[0]?.text).toContain(
          "`luma-synthesis:start:v1`"
        );
        expect(page.markdown).not.toContain("<meeting-notes");
        const claim = initial.captureSynthesis!.claims[0]!;
        expect(
          (
            await f.mi.observe({
              workspace,
              observations: [
                {
                  type: "capture-synthesis-judgment-recorded",
                  observationId: "human-correction",
                  workspaceId: workspace.workspaceId,
                  meetingId: f.meetingId,
                  occurredAt: at,
                  observedAt: at,
                  participantId: "person_jakob",
                  expectedSynthesisRevision: 1,
                  claimId: claim.id,
                  judgment: {
                    kind: "correct",
                    text: "Wir warten ausdrücklich auf das Review."
                  }
                }
              ]
            })
          ).errors
        ).toEqual([]);
        const next = await f.approve();
        await f.executor.execute({ ...request, intentId: next.intentId });
        expect(f.mutations()).toBe(2);
        expect(f.pages.size).toBe(1);
        const updated = f.pages.get(nativeAnchor ? native : imported)!.markdown;
        expect(
          parseMeetingSynthesisSection(updated, signingKey)?.publication.synthesis
            .revision
        ).toBe(2);
        if (nativeAnchor) expect(updated.startsWith(original)).toBe(true);
        expect(
          (await f.database.query("SELECT * FROM meeting_synthesis_publication_locks"))
            .rows
        ).toHaveLength(0);
        expect(
          (await f.database.query("SELECT * FROM operational_outcome_page_leases")).rows
        ).toHaveLength(0);
      } finally {
        await f.database.close();
      }
    }
  );
  it.each(["human-edit", "duplicate-marker"])(
    "withholds an externally changed owned section (%s)",
    async (change) => {
      const f = await setup();
      try {
        const { intentId } = await f.approve();
        await f.executor.execute({ workspace, meetingId: f.meetingId, intentId });
        const page = f.pages.get(imported)!;
        page.markdown =
          change === "human-edit"
            ? page.markdown.replace("### decision", "### action")
            : page.markdown + "\n`luma-synthesis:end:v1`";
        const synthesis = (await f.conclude()).captureSynthesis!;
        await f.mi.observe({
          workspace,
          observations: [
            {
              type: "capture-synthesis-judgment-recorded",
              observationId: "next-human-revision",
              workspaceId: workspace.workspaceId,
              meetingId: f.meetingId,
              occurredAt: at,
              observedAt: at,
              participantId: "person_jakob",
              expectedSynthesisRevision: 1,
              claimId: synthesis.claims[0]!.id,
              judgment: { kind: "confirm" }
            }
          ]
        });
        const next = await f.approve();
        await expect(
          f.executor.execute({
            workspace,
            meetingId: f.meetingId,
            intentId: next.intentId
          })
        ).rejects.toBeInstanceOf(MeetingSynthesisWriteNotAppliedError);
        expect(f.mutations()).toBe(1);
      } finally {
        await f.database.close();
      }
    }
  );
  it("recovers a lost create response positively without another imported record", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      f.setLostResponse(true);
      expect((await f.executor.execute(request)).observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });
      await expect(f.executor.execute(request)).rejects.toThrow(/recovery/u);
      expect((await f.executor.recover(request)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect(f.mutations()).toBe(1);
      const recreatedLogicalMeetings = createLogicalMeetings({
        database: f.database,
        captureRevisionVerifier: {
          verify: () => Promise.resolve({ status: "verified" as const })
        }
      });
      const logical = await recreatedLogicalMeetings.get({
        workspaceId: workspace.workspaceId,
        logicalMeetingId: f.meetingId
      });
      expect(logical?.canonicalAnchorRef?.externalId).toBe(imported);
      expect((await f.conclude()).captureSynthesis?.canonicalAnchorRef?.externalId).toBe(
        imported
      );
      const replay = createMeetingCaptureIngestion({
        workspace,
        meetingIntelligence: f.mi
      });
      expect(await replay.ingest(logical!)).toMatchObject({
        analysisStatus: "not-needed",
        revision: 1
      });
      expect(f.modelCalls()).toBe(1);
      expect(f.pages.size).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("retains positive publication while a local anchor transaction fails and repairs it without resending", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      await f.database.exec(
        "ALTER TABLE logical_meetings ADD CONSTRAINT test_anchor_failure CHECK (canonical_anchor_ref_json IS NULL)"
      );
      expect((await f.executor.execute(request)).observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true,
        errorCode: "synthesis-canonical-anchor-unsettled",
        externalReferences: [{ externalId: imported }]
      });
      expect(
        (
          await readSynthesisPublication(
            f.database,
            workspace.workspaceId,
            f.meetingId,
            intentId
          )
        )?.applied?.externalReference.externalId
      ).toBe(imported);
      expect((await f.conclude()).captureSynthesis?.canonicalAnchorRef).toBeNull();
      await f.database.exec(
        "ALTER TABLE logical_meetings DROP CONSTRAINT test_anchor_failure"
      );
      expect((await f.executor.recover(request)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect((await f.conclude()).captureSynthesis?.canonicalAnchorRef?.externalId).toBe(
        imported
      );
      expect(f.mutations()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("preserves a conflicting canonical anchor after positive publication and requires review without another write", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      f.afterMutation(async () => {
        await f.database.query(
          "UPDATE logical_meetings SET canonical_anchor_ref_json=$3 WHERE workspace_id=$1 AND logical_meeting_id=$2",
          [
            workspace.workspaceId,
            f.meetingId,
            JSON.stringify({
              providerId: "notion",
              objectType: "document",
              externalId: native
            })
          ]
        );
      });
      for (const result of [
        await f.executor.execute(request),
        await f.executor.recover(request)
      ])
        expect(result.observation.outcome).toMatchObject({
          status: "failed",
          requiresManualRecovery: true,
          errorCode: "synthesis-canonical-anchor-unsettled",
          externalReferences: [{ externalId: imported }]
        });
      expect((await f.conclude()).captureSynthesis?.canonicalAnchorRef?.externalId).toBe(
        native
      );
      expect(f.mutations()).toBe(1);
      expect(
        (await f.database.query("SELECT * FROM meeting_synthesis_publication_locks")).rows
      ).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });
  it("keeps an unproven create in manual recovery across repeated recovery attempts", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      f.setLostResponse(false);
      await f.executor.execute(request);
      for (let attempt = 0; attempt < 2; attempt++)
        expect((await f.executor.recover(request)).observation.outcome).toMatchObject({
          status: "failed",
          requiresManualRecovery: true
        });
      expect(f.mutations()).toBe(1);
      expect(f.pages.size).toBe(0);
      expect(
        (await f.database.query("SELECT * FROM meeting_synthesis_publication_locks")).rows
      ).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });
  it("retains positive provider success when source access is revoked before delivery", async () => {
    const f = await setup(true);
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      f.afterMutation(() => f.setSourceAllowed(false));
      await expect(f.executor.execute(request)).rejects.toThrow(/current/u);
      const state = await readSynthesisPublication(
        f.database,
        workspace.workspaceId,
        f.meetingId,
        intentId
      );
      expect(state?.intent.status).toBe("succeeded");
      expect(state?.applied?.externalReference.externalId).toBe(native);
      expect(
        (await f.database.query("SELECT * FROM operational_outcome_page_leases")).rows
      ).toHaveLength(0);
      f.setSourceAllowed(true);
      expect((await f.executor.execute(request)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect(f.mutations()).toBe(1);
    } finally {
      await f.database.close();
    }
  });
  it("does not cross a revoked destination grant and permits the proven undispatched retry", async () => {
    const f = await setup();
    try {
      const { intentId } = await f.approve(),
        request = { workspace, meetingId: f.meetingId, intentId };
      f.setTargetAllowed(false);
      await expect(f.executor.execute(request)).rejects.toThrow(/did not reach/u);
      expect(f.mutations()).toBe(0);
      f.setTargetAllowed(true);
      expect((await f.executor.execute(request)).observation.outcome.status).toBe(
        "succeeded"
      );
    } finally {
      await f.database.close();
    }
  });
});
