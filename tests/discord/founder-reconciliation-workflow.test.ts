import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import {
  createDiscordMeetingBot,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import { createDiscordImportedMeetingAccess } from "../../src/discord/discord-imported-meeting-access.js";
import type { DiscordChannelSurface } from "../../src/discord/discord-channel-scope.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type { WorkProvider } from "../../src/work/interface.js";
import type {
  OperationalOutcome,
  OperationalOutcomeReceipt,
  OperationalOutcomeWriter
} from "../../src/knowledge/operational-outcome-writer.js";
import { OperationalOutcomeWriteNotAppliedError } from "../../src/knowledge/operational-outcome-writer.js";
import { renderOperationalOutcomeMarkdown } from "../../src/knowledge/operational-outcome-markdown.js";
import { createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier } from "../../src/knowledge/ledger-backed-operational-outcome-source-currentness.js";
import { createLedgerBackedOperationalOutcomeSourceExecutionFence } from "../../src/knowledge/ledger-backed-operational-outcome-source-execution-fence.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const time = "2026-09-11T07:00:00.000Z";
const pageId = "3ae2e872-28bf-80c7-9ae0-e722e0edb032";
const base = {
  guildId: "guild",
  channelId: "thread",
  actorDiscordUserId: "779381502311137301",
  occurredAt: time
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
class Transport implements DiscordTransport {
  handler: ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | undefined;
  sent: string[] = [];
  channels = new Map<string, DiscordChannelSurface>([
    [
      "parent",
      { id: "parent", guildId: "guild", kind: "text-channel", parentChannelId: null }
    ],
    [
      "thread",
      { id: "thread", guildId: "guild", kind: "public-thread", parentChannelId: "parent" }
    ],
    [
      "other-thread",
      {
        id: "other-thread",
        guildId: "guild",
        kind: "public-thread",
        parentChannelId: "parent"
      }
    ]
  ]);
  connect(handler: (command: DiscordCommand) => Promise<DiscordCommandResponse>) {
    this.handler = handler;
    return Promise.resolve();
  }
  disconnect() {
    return Promise.resolve();
  }
  resolveChannel({ channelId }: { channelId: string }) {
    return Promise.resolve(this.channels.get(channelId) ?? null);
  }
  createThread(): Promise<never> {
    return Promise.reject(new Error("Binding must not create a new thread"));
  }
  sendMessage({ content }: { content: string }) {
    this.sent.push(content);
    return Promise.resolve();
  }
  execute(command: DiscordCommand) {
    if (!this.handler) throw new Error("not connected");
    return this.handler(command);
  }
}
function snapshot(
  text = "Jakob will prepare the Luma release checklist by Friday."
): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Founder launch review",
    lifecycle: "ready",
    calendar: null,
    recording: null,
    sections: {
      summary: {
        state: "available",
        sourceBlockId: "summary",
        text: "Launch review",
        blocks: []
      },
      actionItemsAndNotes: {
        state: "available",
        sourceBlockId: "actions",
        text,
        blocks: [{ id: "action", type: "to-do", text, checked: false, children: [] }]
      },
      transcript: {
        state: "available",
        sourceBlockId: "transcript",
        text: "",
        blocks: []
      }
    },
    markdown: { content: text, truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
}
async function harness(
  input: {
    text?: string;
    sourceAccess?: boolean;
    outcomeFailsOnce?: boolean;
    catalogUnavailable?: boolean;
  } = {}
) {
  const db = await createPgliteDatabase();
  cleanup.push(() => db.close());
  const ledger = createObservedSourceLedger({ database: db });
  const source = await ledger.record({
    workspaceId: workspace.workspaceId,
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId: "meeting-root",
      parentObjectId: pageId,
      url: `https://notion.so/${pageId}`
    },
    providerVersion: time,
    observedAt: time,
    snapshot: snapshot(input.text)
  });
  let creates = 0;
  let outcomeFailures = input.outcomeFailsOnce ? 1 : 0;
  let catalogAvailable = !input.catalogUnavailable;
  const writes: OperationalOutcome[] = [];
  const work: WorkProvider = {
    providerId: "linear",
    searchWorkItems: () =>
      catalogAvailable
        ? Promise.resolve([])
        : Promise.reject(new Error("catalog unavailable")),
    getWorkItem: () => Promise.reject(new Error("no existing work")),
    createWorkItem: () => {
      creates++;
      return Promise.resolve({
        providerId: "linear",
        objectType: "work-item",
        externalId: "LUM-900",
        url: "https://linear.app/dayova/issue/LUM-900"
      });
    },
    updateWorkItem: () => Promise.reject(new Error("no updates expected")),
    addComment: () => Promise.reject(new Error("no comments expected"))
  };
  const receipts = new Map<string, OperationalOutcomeReceipt>();
  const writer: OperationalOutcomeWriter = {
    providerId: "notion",
    upsert: (request) => {
      if (outcomeFailures-- > 0)
        return Promise.reject(
          new OperationalOutcomeWriteNotAppliedError(
            "Outcome transport refused before write",
            true
          )
        );
      writes.push(request.outcome);
      const rendered = renderOperationalOutcomeMarkdown({
        outcome: request.outcome,
        idempotencyKey: request.idempotencyKey
      });
      const receipt: OperationalOutcomeReceipt = {
        externalReference: request.target.page,
        status: "inserted",
        payloadDigest: rendered.payloadDigest,
        contentDigest: rendered.contentDigest,
        operationDigest: rendered.operationDigest
      };
      receipts.set(request.idempotencyKey, receipt);
      return Promise.resolve(receipt);
    },
    findWrittenOutcome: (request) =>
      Promise.resolve(receipts.get(request.idempotencyKey) ?? null)
  };
  const intelligence = createMeetingIntelligence({
    database: db,
    reasoningModel: {
      generateStructured: () => Promise.reject(new Error("No paid model in this test"))
    },
    workCatalogs: [work],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: "linear"
    })
  });
  const ingested = await createMeetingNotesIngestion({
    meetingIntelligence: intelligence
  }).ingest({ workspace, source });
  expect(ingested.errors).toEqual([]);
  const identityDirectory = createLumaTeamIdentityDirectory();
  const execution = createFollowUpExecution({
    database: db,
    meetingIntelligence: intelligence,
    identityDirectory,
    workProvider: work,
    operationalOutcomeWriter: writer,
    operationalOutcomeSourceCurrentnessVerifier:
      createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({ ledger }),
    operationalOutcomeSourceExecutionFence:
      createLedgerBackedOperationalOutcomeSourceExecutionFence({ ledger })
  });
  let readable = true;
  let checks = 0;
  const access = createDiscordImportedMeetingAccess({
    workspace,
    authorizedPersonIds: dayovaFounderPersonIds,
    ledger,
    providerId: "notion",
    workItemProviderId: "linear",
    sourceAccess: {
      requireCurrent: (request) => {
        checks++;
        expect(request.audience.personIds).toEqual([...dayovaFounderPersonIds]);
        return readable ? Promise.resolve() : Promise.reject(new Error("revoked"));
      }
    }
  });
  const transport = new Transport();
  const bot = createDiscordMeetingBot({
    database: db,
    meetingIntelligence: intelligence,
    followUpExecution: execution,
    identityDirectory,
    authorizedPersonIds: dayovaFounderPersonIds,
    transport,
    workspace,
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    ...(input.sourceAccess === false ? {} : { importedMeetingAccess: access }),
    now: () => new Date(time)
  });
  await bot.start();
  const query = async () => {
    const result = await intelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: ingested.meetingId,
      query: { type: "action-item-reconciliation-review" }
    });
    if (result.type !== "action-item-reconciliation-review")
      throw new Error("wrong result");
    return result.reviews[0]!;
  };
  return {
    db,
    intelligence,
    transport,
    query,
    source,
    ledger,
    ingested,
    access,
    bind: () =>
      transport.execute({
        ...base,
        type: "bind",
        interactionId: "bind",
        sourcePage: `https://app.notion.com/p/${pageId.replaceAll("-", "")}?source=copy_link`
      }),
    setReadable: (value: boolean) => {
      readable = value;
    },
    setCatalogAvailable: (value: boolean) => {
      catalogAvailable = value;
    },
    getCreates: () => creates,
    writes,
    getChecks: () => checks
  };
}

describe("founder reconciliation workflow", () => {
  it("binds the original imported Meeting, resolves ownership, executes once and retains its original-note receipt", async () => {
    const h = await harness();
    expect((await h.bind()).content).toContain("Imported Meeting attached");
    const initial = await h.query();
    const review = await h.transport.execute({
      ...base,
      type: "review",
      interactionId: "review",
      page: 1
    });
    expect(review.content).toContain(initial.proposal.id);
    expect(review.content).toContain("Jakob will prepare");
    expect(review.requireCurrent).toBeTypeOf("function");
    const early = await h.transport.execute({
      ...base,
      type: "reconcile",
      interactionId: "too-early",
      reviewId: initial.proposal.id,
      choice: "select-create-new",
      execute: true
    });
    expect(early.content).toContain("owner must be confirmed");
    expect(h.getCreates()).toBe(0);
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "owner",
          interactionId: "owner",
          claimId: initial.ownershipClaimId,
          ownership: "confirm-owner",
          ownerDiscordUserId: base.actorDiscordUserId
        })
      ).content
    ).toContain("Human Judgment recorded");
    const owned = await h.query();
    expect(owned.ownership).toMatchObject({
      status: "confirmed",
      ownerPersonId: "person_jakob"
    });
    expect(owned.proposal.id).not.toBe(initial.proposal.id);
    const command: DiscordCommand = {
      ...base,
      type: "reconcile",
      interactionId: "execute",
      reviewId: owned.proposal.id,
      choice: "select-create-new",
      execute: true
    };
    expect((await h.transport.execute(command)).content).toContain("Follow-up completed");
    await h.transport.execute(command);
    expect(h.getCreates()).toBe(1);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.scope.pageExternalId).toBe(pageId);
    expect(h.writes[0]?.entries[0]?.workReferences[0]?.externalId).toBe("LUM-900");
    expect(
      (await h.db.query("SELECT meeting_id FROM discord_meeting_threads")).rows
    ).toEqual([{ meeting_id: h.ingested.meetingId }]);
  });
  it("shows a partial outcome and resumes only its unfinished original-note write", async () => {
    const h = await harness({ outcomeFailsOnce: true });
    await h.bind();
    const initial = await h.query();
    await h.transport.execute({
      ...base,
      type: "owner",
      interactionId: "unassign",
      claimId: initial.ownershipClaimId,
      ownership: "intentionally-unassigned"
    });
    const current = await h.query();
    expect(current.ownership.status).toBe("intentionally-unassigned");
    const response = await h.transport.execute({
      ...base,
      type: "reconcile",
      interactionId: "partial",
      reviewId: current.proposal.id,
      choice: "select-create-new",
      execute: true
    });
    expect(response.content).toContain("Follow-up needs attention");
    expect(h.getCreates()).toBe(1);
    expect(h.writes).toHaveLength(0);
    const state = await h.intelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: h.ingested.meetingId,
      query: { type: "snapshot" }
    });
    if (state.type !== "snapshot") throw new Error("wrong state");
    const intent = state.state.followUpIntentions.find(
      (value) => value.type === "settle-operational-outcome"
    )!;
    const recovered = await h.transport.execute({
      ...base,
      type: "recover",
      interactionId: "recover-partial",
      intentId: intent.id
    });
    expect(recovered.content).toContain("Follow-up recovered");
    expect(h.getCreates()).toBe(1);
    expect(h.writes).toHaveLength(1);
  });
  it("keeps review decisions read-only until execution is explicitly requested and refresh invalidates the old review", async () => {
    const h = await harness({ catalogUnavailable: true });
    await h.bind();
    const initial = await h.query();
    h.setCatalogAvailable(true);
    const refresh = await h.transport.execute({
      ...base,
      type: "refresh",
      interactionId: "refresh",
      reviewId: initial.proposal.id
    });
    expect(refresh.content).toContain("Human Judgment recorded");
    const current = await h.query();
    expect(current.proposal.id).not.toBe(initial.proposal.id);
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "reconcile",
          interactionId: "stale",
          reviewId: initial.proposal.id,
          choice: "reject-proposal",
          execute: false
        })
      ).content
    ).toContain("no longer current");
    const resolved = await h.transport.execute({
      ...base,
      type: "reconcile",
      interactionId: "clarify",
      reviewId: current.proposal.id,
      choice: "select-needs-clarification",
      reason: "Discuss scope",
      execute: false
    });
    expect(resolved.content).toContain("Reconciliation decision recorded");
    expect(h.getCreates()).toBe(0);
    expect(h.writes).toHaveLength(0);
  });
  it("refuses unmapped owners, arbitrary work targets, inaccessible source replay and relocated destinations", async () => {
    const h = await harness();
    await h.bind();
    const current = await h.query();
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "owner",
          interactionId: "outsider",
          claimId: current.ownershipClaimId,
          ownership: "confirm-owner",
          ownerDiscordUserId: "stranger"
        })
      ).content
    ).toContain("four authorized founders");
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "reconcile",
          interactionId: "arbitrary",
          reviewId: current.proposal.id,
          choice: "link-existing",
          externalId: "LUM-unknown",
          execute: true
        })
      ).content
    ).toContain("already shown");
    const response = await h.transport.execute({
      ...base,
      type: "review",
      interactionId: "cached",
      page: 1
    });
    h.setReadable(false);
    await expect(response.requireCurrent?.()).rejects.toThrow("current source access");
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "review",
          interactionId: "revoked",
          page: 1
        })
      ).content
    ).not.toContain("Jakob will prepare");
    h.setReadable(true);
    h.transport.channels.set("thread", {
      id: "thread",
      guildId: "guild",
      kind: "public-thread",
      parentChannelId: "public"
    });
    expect(
      (
        await h.transport.execute({
          ...base,
          type: "review",
          interactionId: "moved",
          page: 1
        })
      ).content
    ).toContain("not enabled");
    expect(h.getCreates()).toBe(0);
  });
  it("does not expose imported evidence without the configured source access and preserves existing bindings", async () => {
    const h = await harness({ sourceAccess: false });
    expect((await h.bind()).content).toContain("current source access");
    expect(
      (await h.db.query("SELECT meeting_id FROM discord_meeting_threads")).rows
    ).toHaveLength(0);
    const enabled = await harness();
    await enabled.bind();
    expect(
      (
        await enabled.transport.execute({
          ...base,
          channelId: "other-thread",
          type: "bind",
          interactionId: "redirect",
          sourcePage: pageId
        })
      ).content
    ).toContain("binding was preserved");
    expect(
      (
        await enabled.transport.execute({
          ...base,
          actorDiscordUserId: "stranger",
          type: "bind",
          interactionId: "unauthorized",
          sourcePage: pageId
        })
      ).content
    ).toContain("do not have access");
  });
  it("makes long original wording fully available across bounded review pages", async () => {
    const text =
      "Jakob will prepare the release. " +
      "Evidence stays original 🚀. ".repeat(170) +
      "End of original wording.";
    const h = await harness({ text });
    await h.bind();
    const pages: string[] = [];
    for (let page = 1; page < 20; page++) {
      const response = await h.transport.execute({
        ...base,
        type: "review",
        interactionId: `page-${page}`,
        page
      });
      if (response.content.startsWith("Choose a review page")) break;
      expect(response.content.length).toBeLessThan(1950);
      pages.push(response.content);
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("\n")).toContain("End of original wording.");
    expect(pages.join("\n")).toContain("Ownership claim:");
  });
});
