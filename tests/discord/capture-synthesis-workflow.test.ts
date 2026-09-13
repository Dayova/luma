import type { ExternalReference } from "../../src/domain/model.js";
import type { WorkProvider } from "../../src/work/interface.js";
import { createNotionOperationalOutcomeWriter } from "../../src/knowledge/notion-operational-outcome-writer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Discord from "discord.js";
import { Events } from "discord.js";
import { discordAudienceFixture } from "./discord-audience-fixture.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../../src/discord/discord-meeting-bot.js";
import { createDiscordCaptureReviewRuntime } from "../../src/discord/discord-capture-review-runtime.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import type { MeetingCaptureRevision } from "../../src/logical-meetings/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingCaptureIngestion } from "../../src/knowledge/meeting-capture-ingestion.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type {
  MeetingSynthesisWriter,
  MeetingSynthesisPublicationReceipt
} from "../../src/knowledge/meeting-synthesis-writer.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
import type { MeetingCaptureAccess } from "../../src/meeting-intelligence/meeting-capture-access.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import {
  createMeetingNotesIngestion,
  observedMeetingNoteToObservation
} from "../../src/knowledge/meeting-notes-ingestion.js";
import { observedNotionMeetingCapture } from "../../src/knowledge/notion-meeting-capture.js";
import { createDiscordImportedMeetingAccess } from "../../src/discord/discord-imported-meeting-access.js";

const sdk = vi.hoisted(() => ({
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  put: vi.fn(),
  get: vi.fn(),
  destroy: vi.fn()
}));
vi.mock("discord.js", async (importOriginal) => {
  const original = await importOriginal<typeof Discord>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    Client: class extends EventEmitter {
      user = { id: "bot_luma" };
      rest = { get: sdk.get };
      channels = {
        fetch: (id: string) =>
          Promise.resolve({
            id,
            guildId: "guild",
            type:
              id === "parent"
                ? original.ChannelType.GuildText
                : original.ChannelType.PublicThread,
            parentId: id === "parent" ? null : "parent",
            permissionsFor: () => ({ has: () => true })
          })
      };
      constructor() {
        super();
        sdk.emit = this.emit.bind(this);
      }
      login() {
        queueMicrotask(() => this.emit(original.Events.ClientReady));
        return Promise.resolve();
      }
      destroy = sdk.destroy;
    },
    REST: class {
      setToken() {
        return this;
      }
      put = sdk.put;
    }
  };
});
const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z",
  founder = "779381502311137301";
const canonical = {
  providerId: "notion",
  objectType: "document" as const,
  externalId: "33333333-3333-4333-8333-333333333333",
  url: "https://notion.so/33333333333343338333333333333333"
};
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  const audience = discordAudienceFixture({ botId: "bot_luma" });
  audience.state.ownerId = founder;
  audience.state.members[0]!.user.id = founder;
  sdk.get.mockImplementation(audience.read);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capture(id: string): MeetingCaptureRevision {
  const ref = {
    providerId: "granola",
    objectType: "document" as const,
    externalId: id,
    url: `https://notes.granola.ai/meeting/${id}`
  };
  return {
    address: {
      providerId: "granola",
      providerConnectionId: "owner-account",
      externalCaptureId: id,
      sourceKind: "meeting-capture"
    },
    sourceRevision: 1,
    contentHash: `hash-${id}`,
    providerVersion: "v1",
    capturedAt: at,
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
        sourceVersion: "v1",
        externalReference: ref
      }
    ],
    externalReference: ref
  };
}
async function setup(actionMode = false) {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  const denied = new Set<string>();
  let calls = 0,
    publications = 0,
    loseResponse = false,
    longText = false,
    modelUnavailable = false;
  let readHook: (() => void) | undefined;
  let afterReplyFence: (() => void) | undefined;
  const scopes = new Map<string, string>();
  const logicalMeetings = createLogicalMeetings({
    database,
    captureRevisionVerifier: {
      verify: () => Promise.resolve({ status: "verified" as const })
    }
  });
  const captureAccess: MeetingCaptureAccess = {
    readCurrent: ({ capture, audience }) => {
      expect([...audience.personIds].sort()).toEqual([...dayovaFounderPersonIds].sort());
      readHook?.();
      if (denied.has(capture.id)) throw new Error("Private capture");
      return Promise.resolve({
        authorizationScopeId: scopes.get(capture.id) ?? "original-scope",
        canonicalAnchorRef: null,
        materials: capture.latestRevision.materials.map((descriptor) => ({
          descriptor,
          text: "Wir könnten nächste Woche starten."
        }))
      });
    }
  };
  const reasoningModel: ReasoningModel = {
    generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
      calls++;
      if (modelUnavailable)
        return Promise.reject(new Error("Model currently unavailable"));
      const value: CaptureSynthesisProposal = {
        claims: [
          {
            key: "start",
            kind: actionMode ? "action-item" : "decision",
            text: longText
              ? "A".repeat(1700) +
                "Middle of the complete review " +
                "B".repeat(1700) +
                "END"
              : "Wir könnten nächste Woche starten.",
            evidenceIds: [request.evidence[0]!.evidenceId],
            quotations: [],
            conflictingKeys: [],
            confidence: "medium"
          }
        ]
      };
      return Promise.resolve({
        value: value as T,
        metadata: {
          provider: "fixture",
          model: "fixture",
          promptVersion: request.promptVersion
        }
      });
    }
  };
  const created = new Map<string, ExternalReference>();
  const work = {
    providerId: "linear",
    searchWorkItems: () => Promise.resolve([]),
    getWorkItem: () => Promise.reject(new Error("Unexpected work lookup")),
    createWorkItem: vi.fn<WorkProvider["createWorkItem"]>((request) => {
      const reference = {
        providerId: "linear",
        objectType: "work-item" as const,
        externalId: "LUM-102",
        url: "https://linear.app/dayova/issue/LUM-102"
      };
      created.set(request.idempotencyKey, reference);
      return Promise.resolve(reference);
    }),
    findCreatedWorkItemByIdempotencyKey: (key) => {
      const stored = created.get(key);
      return Promise.resolve(stored ?? null);
    },
    updateWorkItem: () => Promise.reject(new Error("Unexpected update")),
    addComment: () => Promise.reject(new Error("Unexpected comment"))
  } satisfies WorkProvider;
  let outcomeMarkdown = "Original canonical synthesis record";
  const outcomeWriter = createNotionOperationalOutcomeWriter({
    api: {
      retrievePageMarkdown: ({ pageId }) => {
        expect(pageId).toBe(canonical.externalId);
        return Promise.resolve({
          content: outcomeMarkdown,
          truncated: false,
          unknownBlockIds: []
        });
      },
      insertPageMarkdown: ({ pageId, content }) => {
        expect(pageId).toBe(canonical.externalId);
        outcomeMarkdown += content;
        return Promise.resolve();
      },
      updatePageMarkdown: ({ pageId, oldContent, newContent }) => {
        expect(pageId).toBe(canonical.externalId);
        outcomeMarkdown = outcomeMarkdown.replace(oldContent, newContent);
        return Promise.resolve();
      }
    }
  });
  const mi = createMeetingIntelligence({
    database,
    reasoningModel,
    ...(actionMode ? { workCatalogs: [work] } : {}),
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: "linear"
    }),
    captureSynthesis: {
      logicalMeetings,
      access: captureAccess,
      audience: () =>
        Promise.resolve({
          workspaceId: workspace.workspaceId,
          personIds: [...dayovaFounderPersonIds]
        })
    }
  });
  const applied = new Map<string, MeetingSynthesisPublicationReceipt>();
  const writer: MeetingSynthesisWriter = {
    providerId: "notion",
    publish: async (request) => {
      await request.requireCurrent();
      await request.beforeWrite(request.publication.anchor);
      publications++;
      const receipt = {
        externalReference: canonical,
        operationToken: request.publication.operationToken,
        synthesisRevision: request.publication.synthesis.revision,
        sourceSetDigest: request.publication.synthesis.sourceSetDigest
      };
      applied.set(request.publication.intentId, receipt);
      if (loseResponse) throw new Error("Response lost after possible write");
      await request.recordApplied(receipt);
      return receipt;
    },
    findPublished: async (request) => {
      await request.requireCurrent();
      return applied.get(request.publication.intentId) ?? null;
    }
  };
  const executor = createFollowUpExecution({
    database,
    meetingIntelligence: mi,
    meetingSynthesisWriter: writer,
    workProvider: work,
    operationalOutcomeWriter: outcomeWriter,
    identityDirectory: createLumaTeamIdentityDirectory(),
    now: () => new Date(at)
  });
  const review = createDiscordCaptureReviewRuntime({
    database,
    workspace,
    logicalMeetings,
    captureAccess,
    meetingIntelligence: mi,
    followUpExecution: executor,
    founderPersonIds: dayovaFounderPersonIds
  });
  const transport = createDiscordJsTransport({
    token: "fixture",
    clientId: "client",
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    authorizeHumanReader: (userId) => Promise.resolve(userId === founder)
  });
  const bot = createDiscordMeetingBot({
    database,
    workspace,
    meetingIntelligence: mi,
    followUpExecution: executor,
    captureReview: {
      handle: async (value) => {
        const result = await review.handle(value);
        afterReplyFence?.();
        return result;
      }
    },
    importedMeetingAccess: createDiscordImportedMeetingAccess({
      ledger,
      workspace,
      providerId: "notion",
      workItemProviderId: "linear",
      authorizedPersonIds: dayovaFounderPersonIds,
      sourceAccess: { requireCurrent: () => Promise.resolve() }
    }),
    identityDirectory: createLumaTeamIdentityDirectory(),
    authorizedPersonIds: dayovaFounderPersonIds,
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    transport
  });
  await bot.start();
  cleanup.push(async () => {
    await bot.stop();
    await database.close();
  });
  let interactions = 0;
  async function command(
    name: string,
    values: Record<string, string | number | boolean> = {},
    userId = founder,
    channelId = "parent"
  ) {
    const interaction = {
      isChatInputCommand: () => true,
      commandName: "meeting",
      inGuild: () => true,
      guildId: "guild",
      id: `interaction-${++interactions}`,
      channelId,
      user: { id: userId },
      createdAt: new Date(at),
      options: {
        getSubcommand: () => name,
        getString: (key: string) => values[key] ?? null,
        getInteger: (key: string) => values[key] ?? null,
        getBoolean: (key: string) => values[key] ?? null,
        getUser: (key: string) =>
          typeof values[key] === "string" ? { id: values[key] } : null
      },
      deferReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn<(value: { content: string }) => Promise<void>>(() =>
        Promise.resolve()
      )
    };
    sdk.emit(Events.InteractionCreate, interaction);
    await expect
      .poll(() => interaction.editReply.mock.calls.length, { timeout: 10000 })
      .toBe(1);
    return interaction.editReply.mock.calls[0]![0].content;
  }
  async function add(id: string, source = capture(id)) {
    const result = await logicalMeetings.resolveCapture({
      workspaceId: workspace.workspaceId,
      revision: source
    });
    if (result.status !== "accepted") throw new Error("Capture was not admitted");
    await createMeetingCaptureIngestion({ workspace, meetingIntelligence: mi }).ingest(
      result.decision.logicalMeeting
    );
    return result.decision;
  }
  const query = (id: string) =>
    mi.query({
      workspaceId: workspace.workspaceId,
      meetingId: id,
      query: { type: "capture-synthesis" }
    });
  return {
    database,
    ledger,
    mi,
    logicalMeetings,
    command,
    add,
    query,
    denied,
    scopes,
    publications: () => publications,
    calls: () => calls,
    work,
    outcomeMarkdown: () => outcomeMarkdown,
    unavailableModel: () => {
      modelUnavailable = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    longText: () => {
      longText = true;
    },
    onRead: (hook: () => void) => {
      readHook = hook;
    },
    beforeReply: (hook: () => void) => {
      afterReplyFence = hook;
    }
  };
}

describe("Native founder capture and synthesis commands", () => {
  it("labels publication for the displayed synthesis revision when the projection includes older receipts", async () => {
    const f = await setup();
    const id = (await f.add("publication-history")).logicalMeeting.id;
    expect(await f.command("publish", { meeting_id: id, revision: 1 })).toContain(
      "succeeded"
    );
    const prior = await f.query(id);
    if (prior.type !== "capture-synthesis" || !prior.synthesis)
      throw new Error("Missing published synthesis");
    expect(
      await f.command("judge", {
        meeting_id: id,
        revision: 1,
        claim_id: prior.synthesis.claims[0]!.id,
        choice: "confirm"
      })
    ).toContain("Human confirm recorded");
    // The public projection permits multiple publication intentions. Supply its
    // genuine prior receipt alongside the current revision through that port.
    const query = f.mi.query.bind(f.mi);
    vi.spyOn(f.mi, "query").mockImplementation(async (request) => {
      const result = await query(request);
      return result.type === "capture-synthesis"
        ? {
            ...result,
            followUpIntentions: [
              ...(prior.followUpIntentions ?? []),
              ...(result.followUpIntentions ?? [])
            ]
          }
        : result;
    });
    const response = await f.command("synthesis", { meeting_id: id });
    expect(response).toContain("Synthesis revision: 2");
    expect(response).toContain("Publication: suggested");
    expect(response).not.toContain("Publication: succeeded");
    expect(f.publications()).toBe(1);
    expect(f.calls()).toBe(1);
  });
  it("makes Granola-only meetings reachable, shows Basic gaps, records exact Human judgments and publishes one canonical anchor", async () => {
    const f = await setup(),
      first = await f.add("granola-only"),
      id = first.logicalMeeting.id;
    expect(await f.command("captures")).toContain(id);
    const details = await f.command("captures", { meeting_id: id });
    expect(details).toContain("rawTranscript: unavailable");
    expect(details).toContain(first.captureId);
    const initial = await f.query(id);
    if (initial.type !== "capture-synthesis" || !initial.synthesis)
      throw new Error("No synthesis");
    const claim = initial.synthesis.claims[0]!;
    expect(await f.command("synthesis", { meeting_id: id })).toContain("Wir könnten");
    expect(
      await f.command("judge", {
        meeting_id: id,
        revision: 1,
        claim_id: claim.id,
        choice: "confirm"
      })
    ).toContain("Human confirm recorded");
    expect(await f.command("publish", { meeting_id: id, revision: 1 })).toContain(
      "changed"
    );
    expect(f.publications()).toBe(0);
    expect(
      await f.command("judge", {
        meeting_id: id,
        revision: 2,
        claim_id: claim.id,
        choice: "correct",
        text: "We may start only after the founder review."
      })
    ).toContain("Human correct recorded");
    expect(await f.command("synthesis", { meeting_id: id })).toContain("human-corrected");
    expect(await f.command("publish", { meeting_id: id, revision: 3 })).toContain(
      "succeeded"
    );
    expect(f.publications()).toBe(1);
    const restarted = createLogicalMeetings({
      database: f.database,
      captureRevisionVerifier: {
        verify: () => Promise.resolve({ status: "verified" as const })
      }
    });
    expect(
      (await restarted.get({ workspaceId: workspace.workspaceId, logicalMeetingId: id }))
        ?.canonicalAnchorRef
    ).toEqual(canonical);
    expect(await f.command("synthesis", { meeting_id: id })).toContain(canonical.url);
    expect(
      await f.command("publish", { meeting_id: id, revision: 3, recover: true })
    ).toContain("succeeded");
    expect(f.publications()).toBe(1);
    expect(f.calls()).toBe(1);
    const definition = JSON.stringify(sdk.put.mock.calls[0]?.[1]);
    for (const name of ["captures", "synthesis", "judge", "publish", "capture-link"])
      expect(definition).toContain(`"name":"${name}"`);
  });
  it("retains a Human rejection and rejects stale approvals without another model request", async () => {
    const f = await setup(),
      first = await f.add("rejected"),
      id = first.logicalMeeting.id;
    const q = await f.query(id);
    if (q.type !== "capture-synthesis" || !q.synthesis) throw new Error("No synthesis");
    expect(
      await f.command("judge", {
        meeting_id: id,
        revision: 1,
        claim_id: q.synthesis.claims[0]!.id,
        choice: "reject"
      })
    ).toContain("Human reject recorded");
    expect(await f.command("synthesis", { meeting_id: id })).toContain("human-rejected");
    expect(await f.command("publish", { meeting_id: id, revision: 1 })).toContain(
      "changed"
    );
    expect(f.calls()).toBe(1);
    expect(f.publications()).toBe(0);
  });
  it("recovers an uncertain publication through a read-only positive probe without resending", async () => {
    const f = await setup(),
      first = await f.add("uncertain"),
      id = first.logicalMeeting.id;
    f.loseResponse();
    expect(await f.command("publish", { meeting_id: id, revision: 1 })).toContain(
      "may have applied"
    );
    expect(
      await f.command("publish", { meeting_id: id, revision: 1, recover: true })
    ).toContain("succeeded");
    expect(f.publications()).toBe(1);
  });
  it("withholds private records, rejects guests and rechecks grants before the actual reply", async () => {
    const f = await setup(),
      first = await f.add("private"),
      id = first.logicalMeeting.id;
    f.denied.add(first.captureId);
    expect(await f.command("captures")).not.toContain(id);
    expect(await f.command("synthesis", { meeting_id: id })).not.toContain("Wir könnten");
    expect(
      await f.command("publish", { meeting_id: id, revision: 1 }, "guest")
    ).toContain("do not have access");
    f.denied.clear();
    f.beforeReply(() => f.denied.add(first.captureId));
    expect(await f.command("synthesis", { meeting_id: id })).toContain("withheld");
    expect(f.publications()).toBe(0);
  });
  it("keeps replacement grants from authorizing a prepared review and rejects changed source revisions", async () => {
    const f = await setup(),
      first = await f.add("grant-change"),
      id = first.logicalMeeting.id;
    f.beforeReply(() => f.scopes.set(first.captureId, "replacement-scope"));
    expect(await f.command("captures", { meeting_id: id })).toContain("withheld");
    expect(
      await f.command("capture-link", {
        meeting_id: id,
        capture_id: first.captureId,
        revision: 2,
        choice: "separate"
      })
    ).toContain("revision changed");
    expect(f.publications()).toBe(0);
  });
  it("binds and separates exact source captures through Human judgments without changing immutable captures", async () => {
    const f = await setup(),
      first = await f.add("first"),
      second = await f.add("second");
    const original = await f.database.query(
      "SELECT * FROM meeting_capture_revisions ORDER BY capture_id,source_revision"
    );
    expect(
      await f.command("capture-link", {
        meeting_id: first.logicalMeeting.id,
        capture_id: second.captureId,
        revision: 1,
        choice: "bind"
      })
    ).toContain("Capture binding recorded");
    expect(
      (
        await f.logicalMeetings.get({
          workspaceId: workspace.workspaceId,
          captureId: second.captureId
        })
      )?.id
    ).toBe(first.logicalMeeting.id);
    expect(
      await f.command("capture-link", {
        meeting_id: first.logicalMeeting.id,
        capture_id: second.captureId,
        revision: 1,
        choice: "separate"
      })
    ).toContain("Capture binding recorded");
    const separated = await f.logicalMeetings.get({
      workspaceId: workspace.workspaceId,
      captureId: second.captureId
    });
    expect(separated?.id).not.toBe(first.logicalMeeting.id);
    expect(separated?.captureRefs[0]?.binding.origin).toBe("human");
    expect(
      (
        await f.database.query(
          "SELECT * FROM meeting_capture_revisions ORDER BY capture_id,source_revision"
        )
      ).rows
    ).toEqual(original.rows);
  });
  it("refuses capture binding when any source contributor is no longer shared with the founders", async () => {
    const f = await setup(),
      first = await f.add("shared"),
      second = await f.add("not-shared");
    f.denied.add(second.captureId);
    expect(
      await f.command("capture-link", {
        meeting_id: first.logicalMeeting.id,
        capture_id: second.captureId,
        revision: 1,
        choice: "bind"
      })
    ).toContain("withheld");
    expect(
      (
        await f.logicalMeetings.get({
          workspaceId: workspace.workspaceId,
          captureId: second.captureId
        })
      )?.id
    ).toBe(second.logicalMeeting.id);
  });
  it("reports an accepted Human binding when model analysis is unavailable", async () => {
    const f = await setup(),
      first = await f.add("budget-first"),
      second = await f.add("budget-second");
    f.unavailableModel();
    const message = await f.command("capture-link", {
      meeting_id: first.logicalMeeting.id,
      capture_id: second.captureId,
      revision: 1,
      choice: "bind"
    });
    expect(message).toContain("Capture binding recorded");
    expect(message).toContain("Synthesis is pending");
    expect(
      (
        await f.logicalMeetings.get({
          workspaceId: workspace.workspaceId,
          captureId: second.captureId
        })
      )?.id
    ).toBe(first.logicalMeeting.id);
    expect(f.publications()).toBe(0);
  });

  it.each(["revision", "binding"] as const)(
    "refuses a queued Human link when the prior %s changes after source proof",
    async (changed) => {
      const f = await setup(),
        first = await f.add("queue-first"),
        second = await f.add("queue-second");
      const entered = deferred(),
        release = deferred();
      const originalTransaction = f.database.transaction.bind(f.database);
      const spy = vi
        .spyOn(f.database, "transaction")
        .mockImplementationOnce(async (callback) => {
          entered.resolve();
          await release.promise;
          return originalTransaction(callback);
        });
      const pending = f.command("capture-link", {
        meeting_id: first.logicalMeeting.id,
        capture_id: second.captureId,
        revision: 1,
        choice: "bind"
      });
      await entered.promise;
      spy.mockRestore();
      let expectedMeeting = second.logicalMeeting.id;
      if (changed === "revision") {
        const next = capture("queue-second");
        next.sourceRevision = 2;
        next.contentHash = "revised-source-hash";
        next.providerVersion = "v2";
        await f.logicalMeetings.resolveCapture({
          workspaceId: workspace.workspaceId,
          revision: next
        });
      } else {
        const replacement = await f.logicalMeetings.recordBindingJudgment({
          judgmentId: "newer-human-choice",
          workspaceId: workspace.workspaceId,
          actorPersonId: "person_fabius",
          captureId: second.captureId,
          observedAt: at,
          reason: "Keep this separate",
          judgment: {
            type: "make-separate",
            rejectedLogicalMeetingId: second.logicalMeeting.id
          }
        });
        if (replacement.status !== "accepted")
          throw new Error("Newer Human judgment failed");
        expectedMeeting = replacement.decision.logicalMeeting.id;
      }
      release.resolve();
      expect(await pending).toContain("binding could not be accepted");
      expect(
        (
          await f.logicalMeetings.get({
            workspaceId: workspace.workspaceId,
            captureId: second.captureId
          })
        )?.id
      ).toBe(expectedMeeting);
    }
  );

  it("preserves complete long claims over bounded native review pages", async () => {
    const f = await setup();
    f.longText();
    const first = await f.add("long");
    const pages = await Promise.all(
      [1, 2, 3, 4].map((page) =>
        f.command("synthesis", { meeting_id: first.logicalMeeting.id, page })
      )
    );
    expect(pages.every((p) => p.length < 2000)).toBe(true);
    expect(pages.join("")).toContain("Middle of the complete review");
    expect(pages.join("")).toContain("END");
  });
  it("resolves an existing imported Notion thread to its actual logical capture without minting or merging IDs", async () => {
    const f = await setup(),
      pageId = "11111111-1111-4111-8111-111111111111";
    const source = await f.ledger.record({
      workspaceId: workspace.workspaceId,
      source: {
        providerId: "notion",
        sourceKind: "meeting-note",
        sourceObjectId: "notion-root",
        parentObjectId: pageId,
        url: `https://notion.so/${pageId}`
      },
      providerVersion: "v1",
      observedAt: at,
      snapshot: {
        schemaVersion: 1,
        title: "Weekly",
        lifecycle: "ready",
        calendar: null,
        recording: null,
        sections: {
          summary: {
            state: "available",
            sourceBlockId: "summary",
            text: "Wir könnten starten.",
            blocks: []
          },
          actionItemsAndNotes: {
            state: "available",
            sourceBlockId: "actions",
            text: "",
            blocks: []
          },
          transcript: {
            state: "available",
            sourceBlockId: "transcript",
            text: "",
            blocks: []
          }
        },
        markdown: {
          content: "Wir könnten starten.",
          truncated: false,
          unknownBlockIds: []
        },
        completeness: { state: "complete" }
      }
    });
    const imported = await createMeetingNotesIngestion({
      meetingIntelligence: f.mi
    }).ingest({ workspace, source });
    expect(imported.errors).toEqual([]);
    const oldId = observedMeetingNoteToObservation(
      { workspace, source },
      "linear",
      "github-code"
    ).meetingId;
    const bound = await f.add(
      "ignored",
      observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "canonical-datasource"
      })
    );
    expect(oldId).not.toBe(bound.logicalMeeting.id);
    expect(await f.command("bind", { source_page: pageId }, founder, "thread")).toContain(
      "attached"
    );
    expect(await f.command("synthesis", {}, founder, "thread")).toContain(
      bound.logicalMeeting.id
    );
    expect(
      (await f.database.query("SELECT logical_meeting_id FROM logical_meetings")).rows
    ).toHaveLength(1);
  });
});

describe("Native derived action review", () => {
  it("reaches Granola-only action review, records exact founder details and explicitly publishes and executes once without paid re-analysis", async () => {
    const f = await setup(true),
      added = await f.add("granola-actions"),
      id = added.logicalMeeting.id;
    const initial = await f.query(id);
    if (initial.type !== "capture-synthesis" || !initial.synthesis)
      throw new Error("Missing synthesis");
    const claimId = initial.synthesis.claims[0]!.id;
    expect(await f.command("actions", { meeting_id: id })).toContain(
      "needs-clarification"
    );
    expect(
      await f.command("judge", {
        meeting_id: id,
        revision: 1,
        claim_id: claimId,
        choice: "resolve-action",
        modality: "commitment",
        due_date: "none",
        owner: founder
      })
    ).toContain("Human resolve-action recorded");
    const reviewed = await f.mi.query({
      workspaceId: workspace.workspaceId,
      meetingId: id,
      query: { type: "action-item-reconciliation-review" }
    });
    if (reviewed.type !== "action-item-reconciliation-review")
      throw new Error("Wrong query");
    expect(reviewed.reviews[0]).toMatchObject({
      ownership: { status: "confirmed", ownerPersonId: "person_jakob" },
      effectiveOutcome: { type: "create-new" }
    });
    const accepted = await f.command("actions", {
      meeting_id: id,
      revision: 2,
      choice: "accept",
      review_id: reviewed.reviews[0]!.proposal.id,
      page: 2
    });
    const snapshot = await f.mi.query({
      workspaceId: workspace.workspaceId,
      meetingId: id,
      query: { type: "snapshot" }
    });
    expect(snapshot.type === "snapshot" && snapshot.state.followUpIntentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "settle-operational-outcome",
          status: "suggested"
        })
      ])
    );
    expect(accepted).not.toContain("not accepted");
    expect(f.publications()).toBe(0);
    expect(f.calls()).toBe(1);
    if (snapshot.type !== "snapshot") throw new Error("Wrong snapshot");
    const intent = snapshot.state.followUpIntentions.find(
      (item) => item.type === "settle-operational-outcome"
    )!;
    expect(await f.command("publish", { meeting_id: id, revision: 2 })).toContain(
      canonical.url
    );
    const executed = await f.command("actions", {
      meeting_id: id,
      revision: 2,
      choice: "execute",
      intent_id: intent.id
    });
    expect(executed).toContain("Action completed");
    expect(executed).toContain("LUM-102");
    expect(f.work.createWorkItem).toHaveBeenCalledTimes(1);
    expect(f.outcomeMarkdown()).toContain("LUM-102");
    expect(f.outcomeMarkdown()).toContain("Luma — Operational Outcome");
    expect(
      await f.command("actions", {
        meeting_id: id,
        revision: 2,
        choice: "recover",
        intent_id: intent.id
      })
    ).toContain("Action completed");
    expect(f.work.createWorkItem).toHaveBeenCalledTimes(1);
    expect(f.publications()).toBe(1);
    expect(f.calls()).toBe(1);
  }, 30_000);
  it("rejects stale details and a guest owner without changing the synthesis", async () => {
    const f = await setup(true),
      added = await f.add("granola-stale-action"),
      id = added.logicalMeeting.id;
    const initial = await f.query(id);
    if (initial.type !== "capture-synthesis" || !initial.synthesis)
      throw new Error("Missing synthesis");
    const values = {
      meeting_id: id,
      revision: 1,
      claim_id: initial.synthesis.claims[0]!.id,
      choice: "resolve-action",
      modality: "commitment",
      due_date: "2026-09-15",
      owner: "guest"
    };
    expect(await f.command("judge", values)).not.toContain(
      "Human resolve-action recorded"
    );
    expect(
      await f.command("judge", { ...values, revision: 2, owner: founder })
    ).toContain("changed");
    const after = await f.query(id);
    expect(after.type === "capture-synthesis" && after.synthesis?.revision).toBe(1);
    expect(await f.command("actions", { meeting_id: id }, "guest")).not.toContain(
      "Wir könnten"
    );
    expect(f.calls()).toBe(1);
  }, 30_000);
});
