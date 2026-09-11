import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { DiscordCommand } from "../../src/discord/discord-meeting-bot.js";
import {
  captureFixture,
  receiptFixture,
  requestFixture,
  subject,
  workspace
} from "../consultation/harness.js";
import type { ConsultationProvider } from "../../src/consultation/interface.js";
const founders =
  "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841";
function env(): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "test-only",
    DISCORD_CLIENT_ID: "application",
    DISCORD_GUILD_ID: "guild",
    LUMA_WORKSPACE_ID: workspace.workspaceId,
    LUMA_REASONING_MODEL_PROVIDER: "disabled",
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_CONSULTATION_ENABLED: "1",
    LUMA_DISCORD_TEAM_ROLE_ID: "500000000000000001",
    LUMA_DISCORD_CONSULTATION_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS: founders
  };
}
async function fixture() {
  const database = await createPgliteDatabase();
  const evidence = captureFixture();
  let allowed = true;
  let handler: Parameters<DiscordJsTransport["connect"]>[0] | undefined;
  const publish = vi.fn<ConsultationProvider["publish"]>(({ consultation }) =>
    Promise.resolve({
      ...receiptFixture(consultation),
      mention: "incomplete"
    })
  );
  const read = vi.fn<ConsultationProvider["read"]>(({ consultation }) =>
    Promise.resolve(receiptFixture(consultation))
  );
  const close = vi.fn<ConsultationProvider["close"]>(() =>
    Promise.reject(new Error("Lost close response"))
  );
  const capture = vi.fn<DiscordJsTransport["capture"]>(() =>
    Promise.resolve(structuredClone(evidence))
  );
  const model = vi.fn(() => {
    throw new Error("No AI needed");
  });
  const transport: DiscordJsTransport = {
    connect: (next) => {
      handler = next;
      return Promise.resolve();
    },
    disconnect: async () => {},
    capture,
    createConsultationProvider: ({ resolveRecipients }) => ({
      providerId: "discord",
      publish: async (input) => {
        expect(
          await resolveRecipients(input.consultation.recipientPersonIds)
        ).toHaveLength(4);
        return publish(input);
      },
      read,
      findPublished: () => Promise.resolve(null),
      close
    }),
    resolveChannel: ({ channelId }) =>
      Promise.resolve(
        allowed
          ? {
              id: channelId,
              guildId: "guild",
              kind: "public-thread",
              parentChannelId: "100000000000000001",
              botCanRead: true,
              botCanReply: true,
              botCanCreatePublicThreads: false
            }
          : null
      ),
    createThread: () =>
      Promise.reject(new Error("Consultation must not create a Meeting thread")),
    sendMessage: () =>
      Promise.reject(new Error("Poll belongs to approved provider execution"))
  };
  const app = await startServer(env(), {
    createDatabase: () => Promise.resolve(database),
    createDiscordTransport: () => transport,
    createOpenAIReasoningModel: model,
    createOpenAIContextAnswerer: model
  });
  const base = {
    interactionId: "request-1",
    guildId: "guild",
    channelId: subject.conversationObjectId,
    sourceMessageId: subject.anchorMessageId,
    actorDiscordUserId: requestFixture().actor.providerUserId,
    occurredAt: "2026-09-11T10:00:00.000Z"
  };
  const command = async (value: DiscordCommand) => {
    if (!handler) throw new Error("No command handler");
    return handler(value);
  };
  return {
    app,
    database,
    evidence,
    publish,
    read,
    close,
    capture,
    model,
    base,
    command,
    deny: () => {
      allowed = false;
    }
  };
}
describe("Single-runtime Conversation consultations", () => {
  it("starts without an AI key or Ask, publishes from a founder command, and exposes incomplete notification without sending again", async () => {
    const h = await fixture();
    try {
      const start: DiscordCommand = {
        ...h.base,
        type: "consultation-start",
        ...requestFixture().instruction
      };
      const result = await h.command(start);
      expect(result.content).toContain("notification was not fully verified");
      expect(result.content).toContain("Consultation ID: request-1");
      await h.command(start);
      expect(h.publish).toHaveBeenCalledTimes(1);
      const status = await h.command({
        ...h.base,
        interactionId: "status",
        type: "consultation-status",
        consultationId: "request-1"
      });
      expect(status.content).toContain("Results are unknown");
      expect(status.content).toContain("not establish unanimity");
      expect(h.capture.mock.calls[0]?.[0].purpose).toBe("consultation");
      expect((await h.database.query("SELECT * FROM meetings")).rows).toHaveLength(0);
      expect(h.model).not.toHaveBeenCalled();
      h.evidence.snapshot.messages[0]!.text = "Changed source";
      await expect(result.requireCurrent?.()).rejects.toThrow();
    } finally {
      await h.app.stop();
    }
  });
  it("admits founder/live destination before capture and keeps Human reasoning separate from results", async () => {
    const h = await fixture();
    try {
      const start: DiscordCommand = {
        ...h.base,
        type: "consultation-start",
        ...requestFixture().instruction
      };
      expect(
        (await h.command({ ...start, actorDiscordUserId: "guest" })).content
      ).toContain("do not have access");
      expect(h.capture).not.toHaveBeenCalled();
      await h.command(start);
      await h.command({
        ...h.base,
        interactionId: "reason",
        type: "consultation-judgment",
        consultationId: "request-1",
        choice: "Pause",
        rationale: "Important objections remain despite positive votes."
      });
      const status = await h.command({
        ...h.base,
        type: "consultation-status",
        consultationId: "request-1"
      });
      expect(status.content).toContain("Important objections remain");
      const captured = h.capture.mock.calls.length;
      h.deny();
      expect((await h.command({ ...start, interactionId: "another" })).content).toContain(
        "not enabled"
      );
      expect(h.capture).toHaveBeenCalledTimes(captured);
    } finally {
      await h.app.stop();
    }
  });
  it("keeps repeated close instructions attached to one uncertain operation and exposes explicit closure recovery", async () => {
    const h = await fixture();
    try {
      await h.command({
        ...h.base,
        type: "consultation-start",
        ...requestFixture().instruction
      });
      const close = {
        ...h.base,
        type: "consultation-close" as const,
        consultationId: "request-1"
      };
      expect((await h.command({ ...close, interactionId: "close-1" })).content).toContain(
        "uncertain"
      );
      await h.command({ ...close, interactionId: "close-2" });
      expect(h.close).toHaveBeenCalledTimes(1);
      await h.command({
        ...h.base,
        type: "consultation-recover",
        consultationId: "request-1",
        recovery: "closure"
      });
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
    } finally {
      await h.app.stop();
    }
  });
  it("rejects an incomplete founder scope before resource allocation", async () => {
    const createDatabase = vi.fn(() => {
      throw new Error("Must not open");
    });
    await expect(
      startServer(
        {
          ...env(),
          LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
        },
        { createDatabase }
      )
    ).rejects.toThrow("exact four");
    expect(createDatabase).not.toHaveBeenCalled();
  });
});
