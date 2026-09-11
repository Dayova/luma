import { afterEach, describe, expect, it, vi } from "vitest";
import { Routes } from "discord.js";
import { createDiscordConsultationProvider } from "../../src/discord/discord-consultation-provider.js";
import {
  ConsultationNotPublishedError,
  type AdvisoryConsultation
} from "../../src/consultation/interface.js";
import { discordAudienceFixture } from "./discord-audience-fixture.js";

function consultation(): AdvisoryConsultation {
  return {
    id: "consultation-one",
    meetingItemId: "decision-one",
    purpose: "Collect objections before choosing the internal release date.",
    question: "Release Luma internally?",
    options: ["Proceed", "Pause"],
    durationHours: 24,
    allowsMultiple: false,
    owner: null,
    recipientPersonIds: ["jakob"],
    recipientGroupId: "team",
    source: {
      workspaceId: "dayova",
      subject: {
        type: "conversation-thread",
        providerId: "discord",
        conversationObjectId: "thread",
        anchorMessageId: "anchor"
      },
      question: "Discuss release",
      contentHash: "source-hash"
    },
    authorization: {
      basis: "explicit-instruction",
      evidenceId: "instruction",
      authorizedBy: "jakob"
    },
    provenance: {
      evidence: [
        {
          evidenceId: "instruction",
          source: "human-judgment",
          sourceObjectId: "request-one"
        }
      ],
      confidence: "high",
      producedAtRevision: 1,
      analysisVersion: "consultation-v1"
    },
    replacesConsultationId: null
  };
}
function fixture() {
  const audience = discordAudienceFixture();
  let now = new Date("2026-09-11T12:00:00Z");
  const plan = consultation();
  const messages: Array<Record<string, unknown>> = [];
  const post = vi.fn(
    (route: `/${string}`, { body }: { body?: unknown; signal: AbortSignal }) => {
      if (route.endsWith("/expire")) {
        const match = messages[0]!;
        const poll = match["poll"] as Record<string, unknown>;
        poll["results"] = { is_finalized: true, answer_counts: [{ id: 4, count: 1 }] };
        return Promise.resolve(structuredClone(match));
      }
      const data = body as {
        content: string;
        poll: { duration: number };
        message_reference: unknown;
      };
      const result = {
        id: "published",
        channel_id: "thread",
        author: { id: "bot", bot: true },
        content: data.content,
        timestamp: now.toISOString(),
        message_reference: data.message_reference,
        poll: {
          question: { text: plan.question },
          answers: plan.options.map((text, index) => ({
            answer_id: 4 + index,
            poll_media: { text }
          })),
          expiry: new Date(now.getTime() + data.poll.duration * 3600000).toISOString(),
          allow_multiselect: plan.allowsMultiple,
          layout_type: 1
        }
      };
      messages.push(result);
      return Promise.resolve(structuredClone(result));
    }
  );
  const get = vi.fn(
    async (route: `/${string}`, options: Parameters<typeof audience.read>[1]) => {
      if (route === Routes.channelMessages("thread")) return structuredClone(messages);
      if (route === Routes.channelMessage("thread", "published"))
        return structuredClone(messages[0] ?? null);
      const result = await audience.read(route, options);
      if (route === Routes.guildRoles("guild"))
        return (result as Array<object>).map((role) => ({ ...role, mentionable: true }));
      return result;
    }
  );
  const requireSourceCurrent = vi.fn(() => Promise.resolve());
  const create = () =>
    createDiscordConsultationProvider({
      rest: { get, post },
      guildId: "guild",
      allowedParentChannelIds: ["parent"],
      botUserId: () => "bot",
      teamRoleId: "team",
      resolveRecipients: (people) =>
        Promise.resolve(
          people.length === 1 && people[0] === "jakob" ? ["founder"] : null
        ),
      authorizeHumanReader: (user) => Promise.resolve(user === "founder"),
      requireSourceCurrent,
      now: () => now
    });
  return {
    plan,
    provider: create(),
    create,
    messages,
    audience,
    post,
    get,
    requireSourceCurrent,
    advance: () => {
      now = new Date("2026-09-15T12:00:00Z");
    }
  };
}
afterEach(() => vi.useRealTimers());

describe("advisory Discord consultation provider", () => {
  it("does not report closure when Discord returns the unchanged open poll", async () => {
    const f = fixture();
    const published = await f.provider.publish({
      consultation: f.plan,
      operationId: "op"
    });
    f.post.mockImplementation(() => Promise.resolve(structuredClone(f.messages[0]!)));
    await expect(
      f.provider.close({ consultation: f.plan, reference: published.reference })
    ).rejects.toThrow("closure outcome is unknown");
  });
  it("publishes exact choices with one verified group mention and recovers after expiry without another ping", async () => {
    const f = fixture();
    const request = { consultation: f.plan, operationId: "stable-operation" };
    const first = await f.provider.publish(request);
    expect(first).toMatchObject({
      disposition: "published",
      origin: "luma",
      poll: { results: { status: "unknown", reason: "missing" } }
    });
    expect(f.post.mock.calls[0]?.[1].body).toMatchObject({
      allowed_mentions: { parse: [], roles: ["team"], users: [], replied_user: false },
      poll: {
        duration: 24,
        allow_multiselect: false,
        answers: [{ poll_media: { text: "Proceed" } }, { poll_media: { text: "Pause" } }]
      }
    });
    expect(f.post.mock.calls[0]?.[1].body).toHaveProperty(
      "content",
      expect.stringContaining("<@&team> Advisory consultation")
    );
    f.advance();
    expect(await f.create().findPublished(request)).toMatchObject({
      reference: first.reference,
      disposition: "reused"
    });
    expect(await f.create().publish(request)).toMatchObject({
      reference: first.reference,
      disposition: "reused"
    });
    expect(f.post).toHaveBeenCalledOnce();
  });

  it("reuses a matching founder poll for the exact discussion without mentioning or closing it", async () => {
    const f = fixture();
    await f.provider.publish({ consultation: f.plan, operationId: "source-fixture" });
    f.messages[0]!["author"] = { id: "founder", bot: false };
    f.messages[0]!["content"] = "Please weigh in, including objections.";
    f.post.mockClear();
    const found = await f.provider.publish({
      consultation: f.plan,
      operationId: "different-operation"
    });
    expect(found).toMatchObject({ origin: "human", disposition: "reused" });
    await expect(
      f.provider.close({ consultation: f.plan, reference: found.reference })
    ).rejects.toMatchObject({ code: "consultation-close-refused" });
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    "recipient",
    "role",
    "guest",
    "source",
    "parent",
    "choice",
    "duration",
    "unknown-group"
  ])("refuses %s mismatch before any mutation", async (variant) => {
    const f = fixture();
    if (variant === "recipient") f.plan.recipientPersonIds = ["someone"];
    if (variant === "role") f.plan.recipientGroupId = "different";
    if (variant === "guest")
      f.audience.state.members.push({
        user: { id: "guest", bot: false },
        roles: ["team"]
      });
    if (variant === "source")
      f.requireSourceCurrent.mockRejectedValue(new Error("revoked"));
    if (variant === "parent") f.plan.source.subject.conversationObjectId = "parent";
    if (variant === "choice") f.plan.options = ["Pause", " pause "];
    if (variant === "duration") f.plan.durationHours = 900;
    if (variant === "unknown-group")
      f.audience.state.roles = f.audience.state.roles.filter(
        (role) => role.id !== "team"
      );
    await expect(
      f.provider.publish({ consultation: f.plan, operationId: "op" })
    ).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429, 500])(
    "distinguishes proven Discord refusal from an uncertain %s response",
    async (status) => {
      const f = fixture();
      f.post.mockRejectedValue({ status });
      try {
        await f.provider.publish({ consultation: f.plan, operationId: "op" });
        throw new Error("Expected failure");
      } catch (error) {
        expect(error instanceof ConsultationNotPublishedError).toBe(status !== 500);
      }
      expect(f.post).toHaveBeenCalledOnce();
    }
  );

  it("bounds an unresponsive send and permits only positive recovery of its later provider receipt", async () => {
    const f = fixture();
    const realPost = f.post.getMockImplementation()!;
    let resolveSend: (value: unknown) => void = () => undefined;
    f.post.mockImplementation(async (route, options) => {
      const result = await realPost(route, options);
      return new Promise((resolve) => {
        resolveSend = () => resolve(result);
      });
    });
    vi.useFakeTimers();
    const request = { consultation: f.plan, operationId: "uncertain-operation" };
    const pending = f.provider.publish(request);
    const rejected = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    vi.useRealTimers();
    resolveSend(undefined);
    expect(await f.create().findPublished(request)).toMatchObject({
      origin: "luma",
      reference: { externalId: "published" }
    });
    expect(f.post).toHaveBeenCalledOnce();
  });

  it("does not treat another operation's poll or a forged Human marker as positive recovery", async () => {
    const f = fixture();
    await f.provider.publish({ consultation: f.plan, operationId: "original" });
    expect(
      await f.provider.findPublished({ consultation: f.plan, operationId: "other" })
    ).toBeNull();
    f.messages[0]!["author"] = { id: "founder", bot: false };
    expect(
      await f.provider.findPublished({ consultation: f.plan, operationId: "original" })
    ).toBeNull();
  });

  it("reads provisional/final aggregate results and closes only the proven own poll", async () => {
    const f = fixture();
    const published = await f.provider.publish({
      consultation: f.plan,
      operationId: "op"
    });
    const poll = f.messages[0]!["poll"] as Record<string, unknown>;
    poll["results"] = { is_finalized: false, answer_counts: [{ id: 4, count: 1 }] };
    expect(
      await f.provider.read({ consultation: f.plan, reference: published.reference })
    ).toMatchObject({ poll: { results: { status: "provisional" } } });
    expect(
      await f.provider.close({ consultation: f.plan, reference: published.reference })
    ).toMatchObject({ poll: { results: { status: "finalized" } } });
    await f.provider.close({ consultation: f.plan, reference: published.reference });
    expect(f.post).toHaveBeenCalledTimes(2);
  });
});
