import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags, PermissionFlagsBits, Routes } from "discord.js";
import { createDiscordConsultationProvider } from "../../src/discord/discord-consultation-provider.js";
import {
  ConsultationNotPublishedError,
  type AdvisoryConsultation
} from "../../src/consultation/interface.js";
import { discordAudienceFixture } from "./discord-audience-fixture.js";

function consultation(): AdvisoryConsultation {
  return {
    id: "consultation-one",
    choice: { type: "conversation-evidence", messageIds: ["anchor"], pollMessageIds: [] },
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
      contentHash: "source-hash",
      authorizationHash: "stable-source-hash"
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
        mention_roles: ["team"],
        flags: 4,
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
  const resolveRecipients = vi.fn((people: readonly string[]) =>
    Promise.resolve(people.length === 1 && people[0] === "jakob" ? ["founder"] : null)
  );
  const authorizeHumanReader = vi.fn((user: string) =>
    Promise.resolve(user === "founder")
  );
  const create = () =>
    createDiscordConsultationProvider({
      rest: { get, post },
      guildId: "guild",
      allowedParentChannelIds: ["parent"],
      botUserId: () => "bot",
      teamRoleId: "team",
      resolveRecipients,
      authorizeHumanReader,
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
    resolveRecipients,
    authorizeHumanReader,
    advance: () => {
      now = new Date("2026-09-15T12:00:00Z");
    }
  };
}
afterEach(() => vi.useRealTimers());

describe("advisory Discord consultation provider", () => {
  it("cannot read or close an identical own poll from a different discussion", async () => {
    const f = fixture();
    const original = await f.provider.publish({
      consultation: f.plan,
      operationId: "op"
    });
    const otherDiscussion = structuredClone(f.plan);
    otherDiscussion.source.subject.anchorMessageId = "unrelated-anchor";
    otherDiscussion.choice = {
      type: "conversation-evidence",
      messageIds: ["unrelated-anchor"],
      pollMessageIds: []
    };
    expect(
      await f.provider.read({
        consultation: otherDiscussion,
        reference: original.reference
      })
    ).toBeNull();
    await expect(
      f.provider.close({ consultation: otherDiscussion, reference: original.reference })
    ).rejects.toMatchObject({ code: "consultation-close-refused" });
    expect(f.post).toHaveBeenCalledOnce();
  });

  it.each(["source", "authorization", "identity", "choice"])(
    "binds operation recovery to the approved %s",
    async (variant) => {
      const f = fixture();
      const original = await f.provider.publish({
        consultation: f.plan,
        operationId: "same-operation"
      });
      const changed = structuredClone(f.plan);
      if (variant === "source") changed.source.contentHash = "different-source";
      if (variant === "authorization")
        changed.authorization.evidenceId = "different-instruction";
      if (variant === "identity") changed.id = "different-consultation";
      if (variant === "choice")
        changed.choice = {
          type: "conversation-evidence",
          messageIds: ["anchor", "different-message"],
          pollMessageIds: []
        };
      await expect(
        f.provider.findPublished({ consultation: changed, operationId: "same-operation" })
      ).rejects.toMatchObject({ code: "consultation-operation-conflict" });
      await expect(
        f.provider.publish({ consultation: changed, operationId: "same-operation" })
      ).rejects.toMatchObject({ code: "consultation-operation-conflict" });
      expect(
        await f.provider.read({ consultation: changed, reference: original.reference })
      ).toBeNull();
      expect(f.post).toHaveBeenCalledOnce();
    }
  );

  it("requires every intended founder to be able to read the destination", async () => {
    const f = fixture();
    f.plan.recipientPersonIds.push("fabius");
    f.resolveRecipients.mockResolvedValue(["founder", "second-founder"]);
    f.authorizeHumanReader.mockImplementation((user) =>
      Promise.resolve(["founder", "second-founder"].includes(user))
    );
    f.audience.state.members.push({
      user: { id: "second-founder", bot: false },
      roles: ["team"]
    });
    f.audience.state.overwrites.push({
      id: "second-founder",
      type: 1,
      allow: "0",
      deny: String(PermissionFlagsBits.ViewChannel)
    });
    await expect(
      f.provider.publish({ consultation: f.plan, operationId: "op" })
    ).rejects.toMatchObject({ code: "consultation-destination-refused" });
    expect(f.post).not.toHaveBeenCalled();
  });

  it("preserves incomplete role notification as a successful publication without repeating the ping", async () => {
    const f = fixture();
    const actualPost = f.post.getMockImplementation()!;
    f.post.mockImplementation(async (route, options) => {
      const result = await actualPost(route, options);
      f.messages[0]!["flags"] = MessageFlags.FailedToMentionSomeRolesInThread;
      return { ...result, flags: MessageFlags.FailedToMentionSomeRolesInThread };
    });
    const request = { consultation: f.plan, operationId: "op" };
    expect(await f.provider.publish(request)).toMatchObject({
      disposition: "published",
      mention: "incomplete"
    });
    expect(await f.create().findPublished(request)).toMatchObject({
      disposition: "reused",
      mention: "incomplete"
    });
    expect(await f.create().publish(request)).toMatchObject({
      disposition: "reused",
      mention: "incomplete"
    });
    expect(f.post).toHaveBeenCalledOnce();
  });

  it("reuses a captured founder poll that preceded the trigger without a reply reference", async () => {
    const f = fixture();
    await f.provider.publish({ consultation: f.plan, operationId: "fixture" });
    f.messages[0]!["author"] = { id: "founder", bot: false };
    f.messages[0]!["content"] = "Our release decision";
    delete f.messages[0]!["message_reference"];
    const get = f.get.getMockImplementation()!;
    f.get.mockImplementation((route, options) =>
      route === Routes.channelMessages("thread")
        ? Promise.resolve([])
        : get(route, options)
    );
    f.plan.choice = {
      type: "conversation-evidence",
      messageIds: ["published", "anchor"],
      pollMessageIds: ["published"]
    };
    f.post.mockClear();
    expect(
      await f.provider.publish({ consultation: f.plan, operationId: "new" })
    ).toMatchObject({
      disposition: "reused",
      origin: "human",
      mention: "not-requested",
      reference: { externalId: "published" }
    });
    expect(f.post).not.toHaveBeenCalled();
  });

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
