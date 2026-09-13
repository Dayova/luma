import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import type {
  createGranolaOAuthConnections,
  GranolaOwnerActor,
  GranolaOwnerChoices
} from "../granola/oauth-connections.js";
import { GranolaOAuthError } from "../granola/oauth-http.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";

type Manager = Awaited<ReturnType<typeof createGranolaOAuthConnections>>;
export type DiscordGranolaCommand = DiscordCommandBase &
  (
    | { type: "granola-connect" }
    | { type: "granola-status"; page: number }
    | { type: "granola-disconnect" }
    | { type: "granola-inspect"; page: number }
    | {
        type: "granola-attest";
        confirmAccount: boolean;
        sharing: "four-founders";
        automaticInternalMeetings?: boolean;
        includeUrls?: string;
        excludeUrls?: string;
        founderEmails?: string;
      }
    | {
        type: "granola-configure";
        sharing: "four-founders";
        automaticInternalMeetings?: boolean;
        includeUrls?: string;
        excludeUrls?: string;
        founderEmails?: string;
      }
  );
export type DiscordGranolaSourceStatus = {
  active: boolean;
  scheduled: boolean;
  /** A completed scan of this exact connection, not a different owner's scan. */
  checked: boolean;
  failureCodes: readonly string[];
};
export type DiscordGranolaRuntime = {
  handle(input: {
    command: DiscordGranolaCommand;
    actorPersonId: string;
  }): Promise<DiscordCommandResponse>;
};
export function isGranolaCommand(command: {
  type: string;
}): command is DiscordGranolaCommand {
  return [
    "granola-connect",
    "granola-status",
    "granola-inspect",
    "granola-attest",
    "granola-configure",
    "granola-disconnect"
  ].includes(command.type);
}
export class DiscordGranolaUnavailableError extends Error {
  constructor(
    message = "Luma could not complete this Granola step. Use /granola status; reconnect if required. Existing shared captures and receipts remain retained."
  ) {
    super(message);
  }
}

type Inspection = {
  connection_id: string;
  account_fingerprint: string;
  inspected_at: string;
  actor_json: string;
  proof_hash: string;
};
/** Owner-ephemeral ingress. Provider text cannot select the founder or grant sharing. */
export async function createDiscordGranolaRuntime(input: {
  database: LumaDatabase;
  workspaceId: string;
  connections: Pick<
    Manager,
    "status" | "inspect" | "attest" | "configure" | "disconnect" | "policy"
  >;
  begin: Manager["begin"];
  afterConnectionsChanged(): Promise<void>;
  sourceStatus?(connectionId: string): Promise<DiscordGranolaSourceStatus | null>;
  now?: () => Date;
}): Promise<DiscordGranolaRuntime> {
  await input.database.exec(`CREATE TABLE IF NOT EXISTS discord_granola_account_reviews (
    workspace_id TEXT NOT NULL, owner_person_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    account_fingerprint TEXT NOT NULL, inspected_at TEXT NOT NULL, actor_json TEXT NOT NULL,
    proof_hash TEXT NOT NULL, PRIMARY KEY(workspace_id,owner_person_id)
  )`);
  const now = input.now ?? (() => new Date());
  const statusFor = async (owner: string) =>
    (await input.connections.status()).find((s) => s.ownerPersonId === owner);
  async function sourceStatus(
    connectionId: string
  ): Promise<DiscordGranolaSourceStatus | null> {
    try {
      const status = await input.sourceStatus?.(connectionId);
      return status ? structuredClone(status) : null;
    } catch {
      return null;
    }
  }
  const actorFor = (command: DiscordGranolaCommand): GranolaOwnerActor => ({
    providerId: "discord",
    providerUserId: command.actorDiscordUserId
  });
  async function requireConnection(owner: string, connectionId: string) {
    if ((await statusFor(owner))?.connectionId !== connectionId)
      throw new DiscordGranolaUnavailableError(
        "Your Granola connection changed. Inspect the current account again before continuing."
      );
  }
  async function readInspection(owner: string, actor: GranolaOwnerActor) {
    const row = (
      await input.database.query<Inspection>(
        "SELECT connection_id,account_fingerprint,inspected_at,actor_json,proof_hash FROM discord_granola_account_reviews WHERE workspace_id=$1 AND owner_person_id=$2",
        [input.workspaceId, owner]
      )
    ).rows[0];
    if (
      !row ||
      row.actor_json !== JSON.stringify(actor) ||
      hash([
        input.workspaceId,
        owner,
        row.connection_id,
        row.account_fingerprint,
        row.inspected_at,
        row.actor_json
      ]) !== row.proof_hash ||
      !Number.isFinite(Date.parse(row.inspected_at)) ||
      now().getTime() - Date.parse(row.inspected_at) > 600_000 ||
      Date.parse(row.inspected_at) > now().getTime()
    )
      throw new DiscordGranolaUnavailableError(
        "First use /granola inspect to review your connected account and workspace. That account review is valid for 10 minutes."
      );
    await requireConnection(owner, row.connection_id);
    return row;
  }
  async function changed<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } finally {
      await input.afterConnectionsChanged();
    }
  }
  return {
    async handle({ command, actorPersonId }) {
      if (!dayovaFounderPersonIds.some((id) => id === actorPersonId))
        throw new DiscordGranolaUnavailableError();
      const actor = actorFor(command);
      try {
        if (command.type === "granola-connect") {
          const started = await input.begin({ actor });
          const url = new URL(started.authorizationUrl);
          if (
            url.origin !== "https://mcp-auth.granola.ai" ||
            url.pathname !== "/oauth2/authorize" ||
            started.authorizationUrl.length > 1450
          )
            throw new DiscordGranolaUnavailableError();
          return {
            content: `Connect your own Granola account and workspace:\n${started.authorizationUrl}\n\nThis personal link expires at ${started.expiresAt}. Return here after login and use /granola inspect. Nothing is shared until you explicitly attest the account and sharing choices.`,
            requireCurrent: () => requireConnection(actorPersonId, started.connectionId)
          };
        }
        if (command.type === "granola-status") {
          const state = await statusFor(actorPersonId);
          let scope = "No meetings are shared from this connection.";
          let policySnapshot: string | null = null;
          if (state?.status === "connected") {
            const policy = await input.connections.policy.read(state.connectionId);
            policySnapshot = JSON.stringify(policy);
            scope = `Sharing: ${policy.audiencePersonIds.length === 4 ? "all four founders" : "restricted existing audience"}.\nAutomatic mapped internal meetings: ${policy.automaticInternalMeetings ? "on" : "off"}.\nExclusions take priority.\nIncluded meeting URLs:\n${policy.includedMeetingIds.map((id) => `https://notes.granola.ai/d/${id}`).join("\n") || "none"}\nExcluded meeting URLs:\n${policy.excludedMeetingIds.map((id) => `https://notes.granola.ai/d/${id}`).join("\n") || "none"}\nExplicit founder email mappings:\n${policy.participantDirectory.map((item) => `${item.personId.replace("person_", "")}: ${item.email}`).join("\n") || "none"}`;
          }
          const intake =
            state?.status === "connected" ? await sourceStatus(state.connectionId) : null;
          const intakeText =
            state?.status === "connected"
              ? renderSourceStatus(intake)
              : "Source intake remains disabled until the account is connected and attested.";
          const pages = split(
            `${intakeText}\n${state?.lastFailure ? "The connection needs attention.\n" : ""}${scope}\n${nextStep(state?.status)}\nGranola Basic does not provide raw transcripts; notes remain provider-derived.`.replaceAll(
              "@",
              "@\u200b"
            )
          );
          if (
            !Number.isSafeInteger(command.page) ||
            command.page < 1 ||
            command.page > pages.length
          )
            throw new DiscordGranolaUnavailableError(
              `Choose a status page from 1 to ${pages.length}.`
            );
          return {
            content: `Your Granola connection: ${state?.status ?? "not-connected"} · page ${command.page}/${pages.length}.\n${pages[command.page - 1]}`,
            requireCurrent: async () => {
              if (
                JSON.stringify(await statusFor(actorPersonId)) !==
                  JSON.stringify(state) ||
                (policySnapshot !== null &&
                  state &&
                  JSON.stringify(
                    await input.connections.policy.read(state.connectionId)
                  ) !== policySnapshot) ||
                (state?.status === "connected" &&
                  JSON.stringify(await sourceStatus(state.connectionId)) !==
                    JSON.stringify(intake))
              )
                throw new DiscordGranolaUnavailableError(
                  "Connection, sharing or ingestion status changed. Use /granola status again."
                );
            }
          };
        }
        if (command.type === "granola-disconnect") {
          await changed(() => input.connections.disconnect({ actor }));
          return {
            content:
              "Your Granola connection is disconnected in Luma. New access is disabled, and original captures remain retained. To revoke Granola's own OAuth authorization, use Granola's account settings.",
            requireCurrent: async () => {
              const state = await statusFor(actorPersonId);
              if (state && state.status !== "disconnected")
                throw new DiscordGranolaUnavailableError(
                  "Your connection changed. Use /granola status."
                );
            }
          };
        }
        if (command.type === "granola-inspect") {
          const inspected = await input.connections.inspect({ actor });
          await requireConnection(actorPersonId, inspected.connectionId);
          const pages = split(inspected.accountText.replaceAll("@", "@\u200b"));
          if (
            !Number.isSafeInteger(command.page) ||
            command.page < 1 ||
            command.page > pages.length
          )
            throw new DiscordGranolaUnavailableError(
              `Choose an account review page from 1 to ${pages.length}.`
            );
          const at = now().toISOString(),
            actorJson = JSON.stringify(actor);
          await input.database.query(
            `INSERT INTO discord_granola_account_reviews(workspace_id,owner_person_id,connection_id,account_fingerprint,inspected_at,actor_json,proof_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,owner_person_id) DO UPDATE SET connection_id=excluded.connection_id,account_fingerprint=excluded.account_fingerprint,inspected_at=excluded.inspected_at,actor_json=excluded.actor_json,proof_hash=excluded.proof_hash`,
            [
              input.workspaceId,
              actorPersonId,
              inspected.connectionId,
              inspected.accountFingerprint,
              at,
              actorJson,
              hash([
                input.workspaceId,
                actorPersonId,
                inspected.connectionId,
                inspected.accountFingerprint,
                at,
                actorJson
              ])
            ]
          );
          return {
            content: `Your Granola account and workspace · page ${command.page}/${pages.length}\nProvider account information:\n${pages[command.page - 1]}\n\nReview every page. If this is your account and workspace, use /granola attest confirm_account:true sharing:four-founders with your sharing choices. Use /granola configure for an already shared connection. Account text never sets permissions.`,
            requireCurrent: async () => {
              await requireConnection(actorPersonId, inspected.connectionId);
              const current = await input.connections.inspect({ actor });
              if (
                current.connectionId !== inspected.connectionId ||
                current.accountFingerprint !== inspected.accountFingerprint
              )
                throw new DiscordGranolaUnavailableError(
                  "Your Granola account changed. Inspect it again."
                );
            }
          };
        }
        if (
          command.sharing !== "four-founders" ||
          (command.type === "granola-attest" && command.confirmAccount !== true)
        )
          throw new DiscordGranolaUnavailableError(
            "Sharing needs your explicit confirmation of your own account/workspace and the four-founder audience."
          );
        const inspected = await readInspection(actorPersonId, actor);
        const prior =
          command.type === "granola-configure"
            ? await input.connections.policy.read(inspected.connection_id)
            : null;
        if (prior && prior.ownerPersonId !== actorPersonId)
          throw new DiscordGranolaUnavailableError();
        const choices: GranolaOwnerChoices = {
          audiencePersonIds: [...dayovaFounderPersonIds],
          automaticInternalMeetings:
            command.automaticInternalMeetings ??
            prior?.automaticInternalMeetings ??
            false,
          includedMeetingIds:
            command.includeUrls === undefined
              ? (prior?.includedMeetingIds ?? [])
              : meetingIds(command.includeUrls),
          excludedMeetingIds:
            command.excludeUrls === undefined
              ? (prior?.excludedMeetingIds ?? [])
              : meetingIds(command.excludeUrls),
          participantDirectory:
            command.founderEmails === undefined
              ? (prior?.participantDirectory ?? [])
              : directory(command.founderEmails)
        };
        if (
          choices.automaticInternalMeetings &&
          (!choices.participantDirectory?.some((p) => p.personId === actorPersonId) ||
            new Set(choices.participantDirectory.map((p) => p.personId)).size < 2)
        )
          throw new DiscordGranolaUnavailableError(
            "Automatic internal capture needs explicit founder email mappings, including yours and at least one other founder. Unknown attendees remain excluded. Use founder_emails like Jakob=jakob@example.com,Fabius=fabius@example.com, or keep internal_meetings off and include exact meeting URLs."
          );
        if (command.type === "granola-attest")
          await changed(() =>
            input.connections.attest({
              actor,
              connectionId: inspected.connection_id,
              accountFingerprint: inspected.account_fingerprint,
              choices
            })
          );
        else
          await changed(() =>
            input.connections.configure({
              actor,
              connectionId: inspected.connection_id,
              choices,
              ...(prior ? { expectedPolicy: prior } : {})
            })
          );
        const expected = await input.connections.policy.read(inspected.connection_id);
        return {
          content: `Your Granola sharing choices are saved for all four founders.\nAutomatic mapped internal meetings: ${choices.automaticInternalMeetings ? "on" : "off"}.\nExplicitly included: ${choices.includedMeetingIds.length}; excluded: ${choices.excludedMeetingIds.length}. Exclusions take priority.\n${choices.automaticInternalMeetings || choices.includedMeetingIds.length ? "Eligible captures will appear under /meeting captures after the next scan." : "No meetings are selected yet. Use /granola configure to add exact meeting URLs or opt into mapped internal meetings."}\nUnknown participants and private exclusions never become automatically shared.`,
          requireCurrent: async () => {
            await requireConnection(actorPersonId, inspected.connection_id);
            if (
              JSON.stringify(
                await input.connections.policy.read(inspected.connection_id)
              ) !== JSON.stringify(expected)
            )
              throw new DiscordGranolaUnavailableError(
                "Sharing changed after this command. Use /granola status."
              );
          }
        };
      } catch (error) {
        if (error instanceof DiscordGranolaUnavailableError) throw error;
        if (error instanceof GranolaOAuthError && error.code === "owner-required")
          throw new DiscordGranolaUnavailableError(
            "Only the authenticated owner can manage this Granola connection."
          );
        throw new DiscordGranolaUnavailableError();
      }
    }
  };
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function split(value: string): string[] {
  const pages: string[] = [];
  for (let i = 0; i < value.length; i += 1200) pages.push(value.slice(i, i + 1200));
  return pages.length ? pages : ["No account information was returned."];
}
function meetingIds(value: string): string[] {
  if (value.trim().toLowerCase() === "none") return [];
  const ids = value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((text) => {
      try {
        const url = new URL(text);
        const match = /^\/d\/([A-Za-z0-9-]{1,128})\/?$/u.exec(url.pathname);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "notes.granola.ai" ||
          url.port ||
          url.username ||
          url.password ||
          !match
        )
          throw new Error();
        return match[1]!;
      } catch {
        throw new DiscordGranolaUnavailableError(
          "Use exact https://notes.granola.ai/d/<meeting-ID> URLs separated by commas, or 'none' to clear this list."
        );
      }
    });
  if (!ids.length || ids.length > 100)
    throw new DiscordGranolaUnavailableError(
      "Choose between 1 and 100 exact meeting URLs, or 'none'."
    );
  return [...new Set(ids)];
}
function directory(
  value: string
): NonNullable<GranolaOwnerChoices["participantDirectory"]> {
  if (value.trim().toLowerCase() === "none") return [];
  const names: Record<string, (typeof dayovaFounderPersonIds)[number]> = {
    jakob: "person_jakob",
    fabius: "person_fabius",
    gamius: "person_fabius",
    philipp: "person_philipp",
    julius: "person_julius"
  };
  const rows = value
    .split(/[,;\n]/u)
    .filter((v) => v.trim())
    .map((row) => {
      const match = /^\s*([a-z]+)\s*=\s*([^\s@]+@[^\s@]+\.[^\s@]+)\s*$/iu.exec(row),
        person = match && names[match[1]!.toLowerCase()];
      if (!match || !person)
        throw new DiscordGranolaUnavailableError(
          "Use founder name=email pairs, such as Jakob=jakob@example.com,Fabius=fabius@example.com. Only the four founders may be mapped."
        );
      return { email: match[2]!.toLowerCase(), personId: person };
    });
  if (
    !rows.length ||
    rows.length > 16 ||
    new Set(rows.map((p) => p.email)).size !== rows.length
  )
    throw new DiscordGranolaUnavailableError(
      "Use up to 16 distinct founder email mappings, or 'none' to clear them."
    );
  return rows;
}
function nextStep(status: string | undefined): string {
  if (status === "connected")
    return "Use /granola inspect and /granola configure to review or change sharing; /granola disconnect stops access.";
  if (status === "awaiting-owner-attestation")
    return "Use /granola inspect, then explicitly attest your account and sharing choices.";
  if (status === "awaiting-authorization")
    return "Finish the private login link, then return to /granola inspect.";
  return "Use /granola connect to start a new login for your own account.";
}

function renderSourceStatus(status: DiscordGranolaSourceStatus | null): string {
  if (!status)
    return "Meeting intake status is unavailable. This does not confirm that discovery or synthesis is working. Check /granola status again after the runtime is available.";
  const state = status.active
    ? "A source scan is in progress."
    : status.checked
      ? "A source scan has completed."
      : "Waiting for the first source scan.";
  const retry = status.scheduled
    ? "Scheduled source scans will retry eligible work; unresolved AI attempts still require review."
    : "Automatic source scans are paused. They will not retry until intake resumes.";
  const reasons: Record<string, string> = {
    "analysis-budget-exhausted":
      "AI synthesis is blocked by the current usage limit. Use /meeting usage for spending and reset information; processing can resume when budget is available.",
    "analysis-provider-quota":
      "AI synthesis is blocked by the provider's quota. Check /meeting usage and the provider account before retrying.",
    "analysis-rate-limited":
      "The AI provider is rate limiting synthesis. A later eligible scan can retry.",
    "analysis-timeout":
      "AI synthesis timed out. Use /meeting synthesis to check whether review is required before another attempt.",
    "analysis-request-indeterminate":
      "A previous AI request has an unknown outcome. Review it before another paid attempt; scheduled scans cannot safely resend it.",
    "analysis-not-configured":
      "AI synthesis is not configured. The runtime configuration needs attention.",
    "analysis-request-too-large":
      "The captured material exceeds the AI request limit. The retained capture needs a bounded processing adjustment.",
    "analysis-unavailable": "AI synthesis is temporarily unavailable.",
    "rate-limited": "Granola is rate limiting source reads. A later scan can retry.",
    "reauthentication-required":
      "Granola requires a new login. Use /granola connect for your own account.",
    "connection-unavailable":
      "The Granola connection is unavailable. Inspect /granola status and reconnect if needed.",
    "provider-shape-unsupported":
      "Granola returned an unsupported response. Source compatibility needs an implementation fix before these captures can be processed.",
    "policy-withheld":
      "The source sharing policy withheld material. Review your account and explicit choices with /granola inspect and /granola configure.",
    "source-changed":
      "Source material changed during its proof. A later scan can retry the current revision.",
    "source-unavailable":
      "Granola source material is unavailable. A later scan can retry if access is restored.",
    "context-unavailable":
      "Synthesis cannot currently prove access to all required capture context. A later scan can retry after that access is restored."
  };
  const failures = [
    ...new Set(
      status.failureCodes.map(
        (code) =>
          (Object.hasOwn(reasons, code) ? reasons[code] : undefined) ??
          "A source or synthesis step failed. Its safe operational details need review."
      )
    )
  ];
  return `Meeting intake: ${state}\n${retry}\n${failures.length ? failures.join("\n") : status.checked ? "The last completed scan reported no failure for your connection. Discovery is bounded and does not promise a complete history." : "No completed scan is available yet."}`;
}
