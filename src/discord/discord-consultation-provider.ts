import { createHash } from "node:crypto";
import { Routes } from "discord.js";
import { z } from "zod";
import {
  ConsultationNotPublishedError,
  type AdvisoryConsultation,
  type ConsultationProvider,
  type ConsultationReceipt
} from "../consultation/interface.js";
import type { ExternalReference } from "../domain/model.js";
import type { ConversationEvidenceProof } from "../context-intelligence/conversation-evidence-source.js";
import {
  createDiscordLiveAudience,
  type DiscordAudienceReader
} from "./discord-live-audience.js";
import { discordPollEvidence } from "./discord-poll-evidence.js";

const id = z.string().min(1).max(64);
const membersSchema = z
  .array(
    z.object({
      user: z.object({ id, bot: z.boolean().optional().default(false) }),
      roles: z.array(id).max(1_000)
    })
  )
  .min(1)
  .max(999);
const rolesSchema = z
  .array(z.object({ id, mentionable: z.boolean() }))
  .min(1)
  .max(1_000);
const messageSchema = z.object({
  id,
  channel_id: id,
  author: z.object({ id, bot: z.boolean().optional().default(false) }),
  webhook_id: id.nullable().optional(),
  content: z.string().max(4_000),
  timestamp: z.string().datetime({ offset: true }),
  message_reference: z
    .object({ message_id: id.optional(), channel_id: id.optional() })
    .optional(),
  poll: z.unknown().optional()
});
type PollMessage = z.infer<typeof messageSchema>;
type PollInput = { consultation: AdvisoryConsultation; operationId: string };

/** The shared authenticated bot REST client; writes must have automatic retries disabled. */
export type DiscordConsultationRest = DiscordAudienceReader & {
  post(
    route: `/${string}`,
    options: { body?: unknown; signal: AbortSignal }
  ): Promise<unknown>;
};

export function createDiscordConsultationProvider(input: {
  rest: DiscordConsultationRest;
  guildId: string;
  allowedParentChannelIds: readonly string[];
  botUserId: () => string | null;
  teamRoleId: string;
  /** Configured policy maps immutable people; display names never grant recipients. */
  resolveRecipients(personIds: readonly string[]): Promise<string[] | null>;
  authorizeHumanReader(discordUserId: string): Promise<boolean>;
  requireSourceCurrent(proof: ConversationEvidenceProof): Promise<void>;
  now?: () => Date;
}): ConsultationProvider {
  const now = input.now ?? (() => new Date());
  const audience = createDiscordLiveAudience({
    reader: input.rest,
    guildId: input.guildId,
    allowedParentChannelIds: input.allowedParentChannelIds,
    botUserId: input.botUserId,
    authorizeHumanReader: (userId) => input.authorizeHumanReader(userId)
  });

  async function admitted(
    plan: AdvisoryConsultation,
    signal: AbortSignal
  ): Promise<void> {
    if (!validPlan(plan, input.teamRoleId))
      throw refusal(
        "consultation-input-invalid",
        "The advisory poll requires an exact source, recipient group, purpose and distinct bounded alternatives."
      );
    const bot = input.botUserId();
    if (!bot)
      throw refusal(
        "consultation-bot-unavailable",
        "The authenticated Luma bot is unavailable."
      );
    await bounded(input.requireSourceCurrent(plan.source), signal);
    const channel = await bounded(
      audience.resolveChannel(plan.source.subject.conversationObjectId),
      signal
    );
    if (!channel || channel.kind !== "public-thread")
      throw refusal(
        "consultation-destination-refused",
        "The poll destination is not an admitted founder-only thread."
      );
    const recipients = await bounded(
      input.resolveRecipients(plan.recipientPersonIds),
      signal
    );
    if (
      !recipients ||
      !recipients.length ||
      new Set(recipients).size !== recipients.length
    )
      throw refusal(
        "consultation-recipients-unresolved",
        "The intended poll recipients cannot be mapped uniquely."
      );
    const [rawRoles, rawMembers] = await Promise.all([
      bounded(input.rest.get(Routes.guildRoles(input.guildId), { signal }), signal),
      bounded(
        input.rest.get(Routes.guildMembers(input.guildId), {
          signal,
          query: new URLSearchParams({ limit: "1000" })
        }),
        signal
      )
    ]);
    const roles = rolesSchema.safeParse(rawRoles);
    const members = membersSchema.safeParse(rawMembers);
    if (
      !roles.success ||
      !members.success ||
      roles.data.filter((role) => role.id === input.teamRoleId).length !== 1 ||
      new Set(members.data.map((member) => member.user.id)).size !== members.data.length
    )
      throw refusal(
        "consultation-group-unverified",
        "The configured recipient role or complete membership cannot be verified."
      );
    const roleMembers = members.data.filter((member) =>
      member.roles.includes(input.teamRoleId)
    );
    if (
      roleMembers.length !== recipients.length ||
      roleMembers.some(
        (member) => member.user.bot || !recipients.includes(member.user.id)
      )
    )
      throw refusal(
        "consultation-group-mismatch",
        "The configured role does not contain exactly the intended founders."
      );
    // A mentionable role avoids relying on an unrelated permission to mention everyone.
    if (!roles.data.find((role) => role.id === input.teamRoleId)?.mentionable)
      throw refusal(
        "consultation-group-not-mentionable",
        "The reviewed team role cannot currently be mentioned."
      );
    for (const recipient of recipients)
      if (!(await bounded(input.authorizeHumanReader(recipient), signal)))
        throw refusal(
          "consultation-recipient-refused",
          "A poll recipient is no longer admitted."
        );
  }

  async function message(
    plan: AdvisoryConsultation,
    reference: ExternalReference,
    signal: AbortSignal
  ): Promise<PollMessage | null> {
    if (!validReference(plan, reference, input.guildId)) return null;
    const raw = await bounded(
      input.rest.get(
        Routes.channelMessage(
          plan.source.subject.conversationObjectId,
          reference.externalId
        ),
        { signal }
      ),
      signal
    );
    const parsed = messageSchema.safeParse(raw);
    return parsed.success &&
      parsed.data.id === reference.externalId &&
      parsed.data.channel_id === plan.source.subject.conversationObjectId
      ? parsed.data
      : null;
  }

  async function receipt(
    plan: AdvisoryConsultation,
    candidate: PollMessage,
    disposition: ConsultationReceipt["disposition"],
    signal: AbortSignal
  ): Promise<ConsultationReceipt | null> {
    if (
      candidate.channel_id !== plan.source.subject.conversationObjectId ||
      candidate.webhook_id
    )
      return null;
    const origin = candidate.author.bot
      ? candidate.author.id === input.botUserId()
        ? "luma"
        : null
      : "human";
    if (
      !origin ||
      (origin === "human" &&
        !(await bounded(input.authorizeHumanReader(candidate.author.id), signal)))
    )
      return null;
    const poll = discordPollEvidence(
      candidate.poll,
      origin === "human" ? "human" : "luma-generated"
    );
    if (
      !poll ||
      poll.question !== plan.question ||
      poll.allowsMultiple !== plan.allowsMultiple ||
      poll.options.length !== plan.options.length ||
      poll.options.some(
        (option, index) => option.text !== plan.options[index] || option.emoji !== null
      )
    )
      return null;
    return {
      reference: {
        providerId: "discord",
        objectType: "other",
        externalId: candidate.id,
        url: `https://discord.com/channels/${input.guildId}/${candidate.channel_id}/${candidate.id}`
      },
      origin,
      disposition,
      observedAt: now().toISOString(),
      poll
    };
  }

  async function find(
    request: PollInput,
    onlyOperation: boolean,
    signal: AbortSignal
  ): Promise<ConsultationReceipt | null> {
    const plan = request.consultation;
    const anchor = plan.source.subject.anchorMessageId;
    const raw = await bounded(
      input.rest.get(Routes.channelMessages(plan.source.subject.conversationObjectId), {
        signal,
        query: new URLSearchParams({ after: anchor, limit: "100" })
      }),
      signal
    );
    const parsed = z.array(messageSchema).max(100).safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.length === 100 ||
      new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length
    )
      throw refusal(
        "consultation-search-incomplete",
        "The bounded discussion cannot establish whether a matching poll already exists."
      );
    const matches: ConsultationReceipt[] = [];
    for (const candidate of parsed.data) {
      const ownMarker =
        candidate.author.bot &&
        candidate.author.id === input.botUserId() &&
        candidate.content.includes(operationMarker(request.operationId));
      const sameDiscussion =
        candidate.message_reference?.message_id === anchor &&
        (!candidate.message_reference.channel_id ||
          candidate.message_reference.channel_id ===
            plan.source.subject.conversationObjectId);
      if (!ownMarker && (onlyOperation || !sameDiscussion)) continue;
      const found = await receipt(plan, candidate, "reused", signal);
      if (
        ownMarker &&
        (!found ||
          candidate.content !== renderContent(plan, request.operationId, input.guildId))
      )
        throw refusal(
          "consultation-operation-conflict",
          "The existing poll operation does not match its immutable approved request."
        );
      if (!found) continue;
      if (
        !onlyOperation &&
        !ownMarker &&
        (found.poll.closesAt === null ||
          Date.parse(found.poll.closesAt) <= now().getTime() ||
          found.poll.results.status === "finalized")
      )
        continue;
      matches.push(found);
    }
    if (matches.length > 1)
      throw refusal(
        "consultation-match-ambiguous",
        "Several polls match the source and alternatives; no new poll will be posted."
      );
    return matches[0] ?? null;
  }

  return {
    providerId: "discord",
    async publish(request) {
      let publicationStarted = false;
      try {
        return await withDeadline(async (signal) => {
          await admitted(request.consultation, signal);
          if (!validOperationId(request.operationId))
            throw refusal(
              "consultation-operation-invalid",
              "The poll operation identity is invalid."
            );
          const existing = await find(request, false, signal);
          await admitted(request.consultation, signal);
          if (existing) return existing;
          const plan = request.consultation;
          const content = renderContent(plan, request.operationId, input.guildId);
          let raw: unknown;
          try {
            // The executor persists its claim before calling this capability. This
            // boundary distinguishes a proved pre-dispatch refusal from uncertainty.
            signal.throwIfAborted();
            publicationStarted = true;
            raw = await bounded(
              input.rest.post(
                Routes.channelMessages(plan.source.subject.conversationObjectId),
                {
                  signal,
                  body: {
                    content,
                    poll: {
                      question: { text: plan.question },
                      answers: plan.options.map((text) => ({ poll_media: { text } })),
                      duration: plan.durationHours,
                      allow_multiselect: plan.allowsMultiple,
                      layout_type: 1
                    },
                    message_reference: {
                      message_id: plan.source.subject.anchorMessageId,
                      channel_id: plan.source.subject.conversationObjectId,
                      fail_if_not_exists: true
                    },
                    allowed_mentions: {
                      parse: [],
                      roles: [input.teamRoleId],
                      users: [],
                      replied_user: false
                    },
                    nonce: operationMarker(request.operationId).slice(-25),
                    enforce_nonce: true,
                    flags: 4
                  }
                }
              ),
              signal
            );
          } catch (error) {
            if (knownProviderRefusal(error))
              throw refusal(
                "consultation-provider-refused",
                "Discord refused the poll without publishing it."
              );
            throw error; // Timeout/5xx/unknown are never proof of no publication.
          }
          const parsed = messageSchema.safeParse(raw);
          if (
            !parsed.success ||
            !parsed.data.author.bot ||
            parsed.data.author.id !== input.botUserId() ||
            parsed.data.content !== content
          )
            throw new Error("The poll publication outcome could not be proved");
          const published = await receipt(plan, parsed.data, "published", signal);
          if (!published)
            throw new Error("The poll publication outcome could not be proved");
          // Local execution records the receipt before a separate final audience fence.
          return published;
        });
      } catch (error) {
        if (!publicationStarted && !(error instanceof ConsultationNotPublishedError))
          throw refusal(
            "consultation-preflight-unavailable",
            "The source, destination or existing-poll check could not be completed; no poll was sent."
          );
        throw error;
      }
    },
    async findPublished(request) {
      return withDeadline(async (signal) => {
        if (!validOperationId(request.operationId)) return null;
        await admitted(request.consultation, signal);
        const found = await find(request, true, signal);
        await admitted(request.consultation, signal);
        return found;
      });
    },
    async read({ consultation, reference }) {
      return withDeadline(async (signal) => {
        await admitted(consultation, signal);
        const candidate = await message(consultation, reference, signal);
        const found = candidate
          ? await receipt(consultation, candidate, "reused", signal)
          : null;
        await admitted(consultation, signal);
        return found;
      });
    },
    async close({ consultation, reference }) {
      return withDeadline(async (signal) => {
        await admitted(consultation, signal);
        const candidate = await message(consultation, reference, signal);
        const found = candidate
          ? await receipt(consultation, candidate, "reused", signal)
          : null;
        if (!found || found.origin !== "luma")
          throw refusal(
            "consultation-close-refused",
            "Only Luma's own exact poll can be closed."
          );
        if (found.poll.results.status === "finalized") return found;
        await admitted(consultation, signal);
        const raw = await bounded(
          input.rest.post(
            `/channels/${consultation.source.subject.conversationObjectId}/polls/${reference.externalId}/expire`,
            { signal }
          ),
          signal
        );
        const parsed = messageSchema.safeParse(raw);
        const closed =
          parsed.success && parsed.data.id === reference.externalId
            ? await receipt(consultation, parsed.data, "reused", signal)
            : null;
        if (
          !closed ||
          closed.origin !== "luma" ||
          (closed.poll.results.status !== "finalized" &&
            (closed.poll.closesAt === null ||
              Date.parse(closed.poll.closesAt) > now().getTime()))
        )
          throw new Error("The poll closure outcome is unknown");
        return closed;
      });
    }
  };
}

function validPlan(plan: AdvisoryConsultation, roleId: string): boolean {
  return (
    typeof plan === "object" &&
    !!plan &&
    typeof plan.id === "string" &&
    plan.id.length > 0 &&
    typeof plan.purpose === "string" &&
    plan.purpose.trim().length > 0 &&
    plan.purpose.length <= 500 &&
    typeof plan.question === "string" &&
    plan.question.trim().length > 0 &&
    plan.question.length <= 300 &&
    Array.isArray(plan.options) &&
    plan.options.length >= 2 &&
    plan.options.length <= 10 &&
    plan.options.every(
      (option) =>
        typeof option === "string" && option.trim().length > 0 && option.length <= 55
    ) &&
    new Set(plan.options.map((option) => option.trim().toLocaleLowerCase("en-US")))
      .size === plan.options.length &&
    Number.isSafeInteger(plan.durationHours) &&
    plan.durationHours >= 1 &&
    plan.durationHours <= 768 &&
    typeof plan.allowsMultiple === "boolean" &&
    plan.recipientGroupId === roleId &&
    !!roleId &&
    Array.isArray(plan.recipientPersonIds) &&
    plan.recipientPersonIds.length > 0 &&
    plan.recipientPersonIds.length <= 20 &&
    new Set(plan.recipientPersonIds).size === plan.recipientPersonIds.length &&
    plan.recipientPersonIds.every((person) => typeof person === "string" && !!person) &&
    !!plan.source &&
    plan.source.subject?.providerId === "discord" &&
    plan.source.subject.type === "conversation-thread" &&
    id.safeParse(plan.source.subject.conversationObjectId).success &&
    id.safeParse(plan.source.subject.anchorMessageId).success
  );
}
function validReference(
  plan: AdvisoryConsultation,
  reference: ExternalReference,
  guildId: string
): boolean {
  return (
    reference.providerId === "discord" &&
    reference.objectType === "other" &&
    id.safeParse(reference.externalId).success &&
    reference.url ===
      `https://discord.com/channels/${guildId}/${plan.source.subject.conversationObjectId}/${reference.externalId}`
  );
}
function operationMarker(operationId: string): string {
  return `Luma advisory ${createHash("sha256").update(operationId).digest("hex")}`;
}
function validOperationId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}
function renderContent(
  plan: AdvisoryConsultation,
  operationId: string,
  guildId: string
): string {
  const source = `https://discord.com/channels/${guildId}/${plan.source.subject.conversationObjectId}/${plan.source.subject.anchorMessageId}`;
  return `<@&${plan.recipientGroupId}> Advisory consultation\n${plan.purpose}\nOwner: ${plan.owner ? plan.owner.personId : "not established"}. Open for ${plan.durationHours} hours; Discord shows the exact closing time.\nSource: ${source}\nThe result informs a Human decision. Objections and owner reasoning remain relevant; no execution is authorized by votes.\n${operationMarker(operationId)}`;
}
function refusal(code: string, message: string): ConsultationNotPublishedError {
  return new ConsultationNotPublishedError(code, message);
}
function knownProviderRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    [400, 401, 403, 404, 429].includes(Number(error.status))
  );
}
async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Discord consultation deadline exceeded")),
    15_000
  );
  try {
    return await bounded(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Discord consultation cancelled")
      );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        const failure =
          error instanceof Error
            ? error
            : new Error("Discord consultation operation failed");
        if (
          !(error instanceof Error) &&
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number"
        )
          Object.defineProperty(failure, "status", { value: error.status });
        reject(failure);
      }
    );
  });
}
