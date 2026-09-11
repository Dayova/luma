import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { ExecuteDecisionFollowUpInput } from "../../src/follow-up-execution/interface.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createConversationDecisionEvidenceSource } from "../../src/decision-intelligence/conversation-evidence-source.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import {
  createDiscordMeetingBot,
  type DiscordTransport,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordContextAskResponse
} from "../../src/discord/discord-meeting-bot.js";
import type { DiscordContextAskMention } from "../../src/discord/discord-context-ask-runtime.js";
import type {
  CanonicalDecisionRecord,
  DecisionAuthoritySnapshot,
  DecisionCandidate,
  DecisionWriteReceipt
} from "../../src/domain/decision-records.js";
import type { DecisionInterpreter } from "../../src/decision-intelligence/ports.js";
import type { DecisionRecords } from "../../src/knowledge/decision-records.js";
import { captureFixture, subject, workspace } from "../consultation/harness.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});

function fixture() {
  const raw = captureFixture();
  const anchor = raw.snapshot.messages[0]!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text = "<@luma> record this decision";
  anchor.ordinal = 1;
  const statement = {
    ...structuredClone(anchor),
    id: "300000000000000000",
    ordinal: 0,
    text: "Luma bleibt vorerst nur für uns vier Gründer intern.",
    url: "https://discord.com/channels/guild/thread/300000000000000000"
  };
  raw.snapshot.messages.unshift(statement);
  raw.snapshot.boundary.firstMessageId = statement.id;
  raw.snapshot.boundary.messageIds.unshift(statement.id);
  let currentIdentity = true,
    currentAuthority = true,
    currentChannel = true;
  const directory = createLumaTeamIdentityDirectory();
  const identityDirectory = {
    ...directory,
    findPeopleByProviderUserId: (
      request: Parameters<typeof directory.findPeopleByProviderUserId>[0]
    ) =>
      currentIdentity
        ? directory.findPeopleByProviderUserId(request)
        : Promise.resolve([])
  };
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    identityDirectory,
    authorizedPersonIds: dayovaFounderPersonIds
  });
  const capture = vi.fn(() => Promise.resolve(structuredClone(raw)));
  const evidenceSource = createConversationDecisionEvidenceSource({
    workspaceId: workspace.workspaceId,
    conversationEvidenceSource: { capture },
    ledger: createObservedSourceLedger({ database }),
    accessPolicy,
    recipientPersonIds: dayovaFounderPersonIds
  });
  const authority: DecisionAuthoritySnapshot = {
    id: "ownership",
    revision: "ownership-v1",
    contentHash: "verified-ownership",
    source: {
      providerId: "notion",
      objectType: "document",
      externalId: "ownership",
      url: "https://notion.so/ownership"
    },
    grants: [
      {
        id: "luma-owner",
        personId: "person_jakob",
        scopeId: "luma",
        kind: "project-ownership",
        standing: "current",
        delegatedBy: null,
        consultedPersonIds: [],
        evidence: [
          {
            evidenceId: "ownership-evidence",
            source: "external-activity",
            sourceObjectId: "ownership",
            sourceVersion: "ownership-v1",
            excerpt: "Jakob owns Luma."
          }
        ]
      }
    ]
  };
  let modality: DecisionCandidate["modality"] = "final-decision";
  let interpretationError: Error | null = null;
  const interpret = vi.fn<DecisionInterpreter["interpret"]>(({ source }) => {
    if (interpretationError) return Promise.reject(interpretationError);
    const original = source.evidence.find(
      (item) => item.reference.sourceObjectId === statement.id
    )!;
    return Promise.resolve({
      candidate: {
        statement: { text: original.text, evidenceIds: [original.id] },
        modality,
        scopeId: "luma",
        decisionMakerPersonIds: ["person_jakob"],
        acceptanceEvidenceIds: [original.id],
        context: null,
        rationale: [],
        alternatives: [],
        consequences: [],
        effectiveAt: null,
        disposition: "adopt",
        objections: [],
        unresolved: [],
        relatedWork: [],
        implementationEvidence: []
      },
      reconciliation: { action: "create" }
    });
  });
  const records = new Map<string, CanonicalDecisionRecord>(),
    receipts = new Map<string, DecisionWriteReceipt>();
  const digest = () =>
    createHash("sha256")
      .update(JSON.stringify([...records.values()]))
      .digest("hex");
  let ambiguousAfterWrite = false;
  let throwAfterExecution = false;
  const write = vi.fn<DecisionRecords["write"]>(({ stage, operationId }) => {
    if (stage.type !== "create-record")
      return Promise.reject(new Error("Unexpected stage"));
    const record: CanonicalDecisionRecord = {
      content: structuredClone(stage.record),
      version: "v1",
      reference: {
        providerId: "notion",
        objectType: "document",
        externalId: stage.record.id,
        url: `https://notion.so/${stage.record.id}`,
        version: "v1"
      }
    };
    records.set(record.reference.externalId, record);
    const receipt = { record, operationId, observedAt: "2026-09-11T10:00:00Z" };
    receipts.set(operationId, receipt);
    return ambiguousAfterWrite
      ? Promise.reject(new Error("socket timed out after remote write"))
      : Promise.resolve(structuredClone(receipt));
  });
  const provider: DecisionRecords = {
    providerId: "notion",
    discover: () =>
      Promise.resolve({
        id: "canonical",
        revision: digest(),
        complete: true,
        records: structuredClone([...records.values()])
      }),
    requireCurrent: ({ snapshot }) =>
      snapshot.revision === digest()
        ? Promise.resolve()
        : Promise.reject(new Error("catalog changed")),
    read: ({ recordId }) =>
      Promise.resolve(structuredClone(records.get(recordId) ?? null)),
    readReference: ({ audience, reference }) =>
      provider.read({ audience, recordId: reference.externalId }),
    findWritten: vi.fn<DecisionRecords["findWritten"]>(({ operationId }) =>
      Promise.resolve(structuredClone(receipts.get(operationId) ?? null))
    ),
    write
  };
  const configuration = {
    evidenceSource,
    authority: {
      read: () => Promise.resolve(structuredClone(authority)),
      requireCurrent: () =>
        currentAuthority
          ? Promise.resolve()
          : Promise.reject(new Error("ownership changed"))
    },
    interpreter: { interpret },
    records: provider,
    accessPolicy,
    audience: () =>
      Promise.resolve({
        workspaceId: workspace.workspaceId,
        personIds: [...dayovaFounderPersonIds]
      })
  };
  const mention: DiscordContextAskMention = {
    guildId: "guild",
    channelId: subject.conversationObjectId,
    parentChannelId: "100000000000000001",
    actorDiscordUserId: "779381502311137301",
    messageId: subject.anchorMessageId,
    question: "record this decision",
    occurredAt: "2026-09-11T10:00:00Z",
    purpose: "decision-record"
  };
  function make() {
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () =>
          Promise.reject(new Error("No synthetic Meeting analysis"))
      },
      decisionIntelligence: configuration
    });
    const execution = createFollowUpExecution({ database, meetingIntelligence: mi });
    let ask:
      | ((ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null>)
      | undefined;
    let command:
      ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | undefined;
    const transport: DiscordTransport = {
      connect(handler, context) {
        command = handler;
        ask = context;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      resolveChannel({ channelId }) {
        return Promise.resolve(
          currentChannel
            ? {
                id: channelId,
                guildId: "guild",
                kind: "public-thread",
                parentChannelId: mention.parentChannelId
              }
            : null
        );
      },
      createThread: () => Promise.reject(new Error("No synthetic Meeting thread")),
      sendMessage: () => Promise.reject(new Error("No unrelated message"))
    };
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence: mi,
      followUpExecution: execution,
      identityDirectory,
      authorizedPersonIds: dayovaFounderPersonIds,
      transport,
      workspace,
      guildId: "guild",
      allowedParentChannelIds: [mention.parentChannelId],
      decisionRecords: {
        meetingIntelligence: mi,
        execution: {
          async execute(request: ExecuteDecisionFollowUpInput) {
            const result = await execution.execute(request);
            if (throwAfterExecution) throw new Error("A later local completion failure");
            return result;
          },
          recover: (request: ExecuteDecisionFollowUpInput) => execution.recover(request)
        },
        config: {
          parentChannelIds: [mention.parentChannelId],
          allowedDiscordUserIds: [mention.actorDiscordUserId],
          maxMessages: 50,
          maxEvidenceChars: 32000,
          minIntervalMs: 1000
        }
      }
    });
    return {
      mi,
      execution,
      bot,
      invoke: (value = mention) => ask!(value),
      command: (value: DiscordCommand) => command!(value)
    };
  }
  const address = (
    type: "decision-record-status" | "decision-record-recover"
  ): DiscordCommand => ({
    type,
    guildId: "guild",
    channelId: mention.channelId,
    actorDiscordUserId: mention.actorDiscordUserId,
    occurredAt: mention.occurredAt,
    interactionId: "status",
    requestId: `discord:${mention.messageId}:decision-record`,
    sourceMessageId: mention.messageId
  });
  return {
    make,
    raw,
    authority,
    records,
    interpret,
    provider,
    write,
    capture,
    mention,
    address,
    proposal: () => {
      modality = "proposal";
      statement.text = "Wir könnten Luma vorerst intern verwenden.";
    },
    ambiguousWrite: () => {
      ambiguousAfterWrite = true;
    },
    failAfterExecution: () => {
      throwAfterExecution = true;
    },
    failInterpretation: (error: Error) => {
      interpretationError = error;
    },
    revoke: (kind: "source" | "identity" | "authority" | "channel") => {
      if (kind === "source")
        raw.snapshot.messages[0]!.text = "A different source decision";
      if (kind === "identity") currentIdentity = false;
      if (kind === "authority") currentAuthority = false;
      if (kind === "channel") currentChannel = false;
    }
  };
}

describe("Explicit Discord Decision Record workflow through owned MI", () => {
  it("records once from original discussion without a Meeting, then replays and reads status without more paid interpretation or writes", async () => {
    const f = fixture();
    const first = f.make();
    await first.bot.start();
    const response = await first.invoke();
    expect(response?.content).toContain("Decision Record: recorded");
    expect(response?.content).toContain("https://notion.so/");
    await response?.requireCurrent?.();
    expect(f.records.size).toBe(1);
    expect([...f.records.values()][0]?.content.candidate.statement.text).toBe(
      "Luma bleibt vorerst nur für uns vier Gründer intern."
    );
    expect(f.interpret).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledOnce();
    await expect(first.invoke()).resolves.toBeNull();
    await first.bot.stop();
    const restarted = f.make();
    await restarted.bot.start();
    expect((await restarted.invoke())?.content).toContain("Decision Record: recorded");
    expect(
      (await restarted.command(f.address("decision-record-status"))).content
    ).toContain("Decision Record: recorded");
    expect(f.interpret).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledOnce();
    expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(0);
    await restarted.bot.stop();
  });
  it("returns clarification for tentative source instead of creating canonical knowledge", async () => {
    const f = fixture();
    f.proposal();
    const live = f.make();
    await live.bot.start();
    expect((await live.invoke())?.content).toContain("needs-clarification");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
    await live.bot.stop();
  });
  it("keeps unknown remote outcomes durable and recovers only the exact existing write", async () => {
    const f = fixture();
    f.ambiguousWrite();
    const live = f.make();
    await live.bot.start();
    expect((await live.invoke())?.content).toContain("unknown");
    expect(f.write).toHaveBeenCalledOnce();
    const recovered = await live.command(f.address("decision-record-recover"));
    expect(recovered.content).toContain("recorded");
    expect(recovered.content).toContain("https://notion.so/");
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.interpret).toHaveBeenCalledOnce();
    await live.bot.stop();
  });
  it.each(["source", "identity", "authority", "channel"] as const)(
    "fences delivery after current %s changes",
    async (kind) => {
      const f = fixture();
      const live = f.make();
      await live.bot.start();
      const response = await live.invoke();
      expect(response?.requireCurrent).toBeDefined();
      f.revoke(kind);
      await expect(response!.requireCurrent!()).rejects.toThrow();
      expect(f.write).toHaveBeenCalledOnce();
      await live.bot.stop();
    }
  );
  it("preserves a known canonical receipt when later execution completion throws", async () => {
    const f = fixture();
    f.failAfterExecution();
    const live = f.make();
    await live.bot.start();
    const response = await live.invoke();
    expect(response?.content).toContain("Decision Record: recorded");
    expect(response?.content).toContain("https://notion.so/");
    expect(f.write).toHaveBeenCalledOnce();
    await response?.requireCurrent?.();
    await live.bot.stop();
  });
  it("does not deliver an old clarification after an explicit Human correction changes the canonical request", async () => {
    const f = fixture();
    f.proposal();
    const live = f.make();
    await live.bot.start();
    const response = await live.invoke();
    const state = await live.mi.query({
      workspaceId: workspace.workspaceId,
      subject,
      query: {
        type: "decision-request",
        requestId: `discord:${f.mention.messageId}:decision-record`
      }
    });
    if (!state.candidate) throw new Error("Expected retained proposal");
    await live.mi.observe({
      workspace,
      subject,
      observations: [
        {
          type: "decision-candidate-corrected",
          observationId: "human-correction",
          requestId: state.requestId,
          actor: { providerId: "discord", providerUserId: f.mention.actorDiscordUserId },
          candidate: { ...state.candidate, disposition: "pause" },
          reason: "We put this idea on hold."
        }
      ]
    });
    await expect(response!.requireCurrent!()).rejects.toThrow("changed");
    expect(f.write).not.toHaveBeenCalled();
    await live.bot.stop();
  });
  it("exposes a reached AI budget while retaining source and preventing paid replay", async () => {
    const f = fixture();
    f.failInterpretation(
      new AiServiceError("budget-exhausted", "private provider details")
    );
    const live = f.make();
    await live.bot.start();
    const response = await live.invoke();
    expect(response?.content).toContain("AI usage budget is exhausted");
    expect(response?.content).toContain("source was retained");
    expect(response?.content).not.toContain("private provider details");
    expect(f.write).not.toHaveBeenCalled();
    await live.bot.stop();
    const restarted = f.make();
    await restarted.bot.start();
    expect((await restarted.invoke())?.content).toContain("AI usage budget is exhausted");
    expect(f.interpret).toHaveBeenCalledOnce();
    await restarted.bot.stop();
  });
  it("does not admit guests, wrong parents or a forged non-instruction purpose", async () => {
    const f = fixture();
    const live = f.make();
    await live.bot.start();
    for (const mention of [
      { ...f.mention, actorDiscordUserId: "guest" },
      { ...f.mention, parentChannelId: "other" },
      { ...f.mention, question: "What did we decide?" }
    ])
      await expect(live.invoke(mention)).resolves.toBeNull();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.interpret).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    await live.bot.stop();
  });
});
