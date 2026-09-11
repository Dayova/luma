import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import {
  createGranolaMcpClient,
  GranolaSourceError,
  type GranolaOAuthCredential,
  type GranolaMcpClient
} from "./mcp-client.js";
import {
  granolaAccountFingerprint,
  requireGranolaReadTools,
  toolText
} from "./wire-format.js";
import {
  createGranolaOAuthHttp,
  GranolaOAuthError,
  granolaOAuthIssuer,
  granolaOAuthResource
} from "./oauth-http.js";
import { createGranolaOAuthStore, type GranolaOAuthState } from "./oauth-store.js";
import { granolaPolicySchema, type GranolaPolicy } from "./policy.js";

export type GranolaOwnerActor = { providerId: string; providerUserId: string };
type Founder = (typeof dayovaFounderPersonIds)[number];
export type GranolaOwnerChoices = {
  audiencePersonIds: Founder[];
  automaticInternalMeetings?: boolean;
  participantDirectory?: { email: string; personId: Founder }[];
  includedMeetingIds: string[];
  excludedMeetingIds: string[];
};
/** Every owner action requires the caller adapter's authenticated actor, never provider names. */
export async function createGranolaOAuthConnections(input: {
  database: LumaDatabase;
  workspaceId: string;
  encryptionKey: Uint8Array;
  redirectUri: string;
  authorizeOwner: (actor: GranolaOwnerActor) => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}) {
  const redirect = new URL(input.redirectUri);
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(redirect.hostname)
      ))
  )
    throw new GranolaOAuthError("unavailable");
  const redirectUri = redirect.href;
  const store = await createGranolaOAuthStore(input),
    http = createGranolaOAuthHttp(input),
    now = input.now ?? (() => new Date());
  await store.list(); // Wrong key/corrupt credentials fail startup, rather than silently losing connections.
  let stopped = false;
  const authorizationFlights = new Set<string>();
  const active = new Set<Promise<unknown>>(),
    refreshes = new Map<string, Promise<GranolaOAuthCredential>>();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new GranolaOAuthError("stopped"));
    const pending = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        if (error instanceof GranolaOAuthError || error instanceof GranolaSourceError)
          throw error;
        throw new GranolaOAuthError("unavailable");
      });
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  };
  const owner = async (actor: GranolaOwnerActor): Promise<Founder> => {
    const selected = await input.authorizeOwner(structuredClone(actor));
    if (!dayovaFounderPersonIds.some((person) => person === selected))
      throw new GranolaOAuthError("owner-required");
    return selected as Founder;
  };
  const sameOwner = async (actor: GranolaOwnerActor, person: Founder) => {
    if ((await owner(actor)) !== person) throw new GranolaOAuthError("owner-required");
  };
  const exact = (
    state: GranolaOAuthState | null,
    connectionId: string
  ): GranolaOAuthState => {
    if (!state || state.connectionId !== connectionId)
      throw new GranolaOAuthError("reauthentication-required");
    return state;
  };
  const tokens = (
    response: Awaited<ReturnType<typeof http.exchange>>,
    previous?: string
  ) => {
    const refreshToken = response.refresh_token ?? previous;
    if (!refreshToken) throw new GranolaOAuthError("reauthentication-required");
    return {
      accessToken: response.access_token,
      refreshToken,
      expiresAt: new Date(now().getTime() + response.expires_in * 1_000).toISOString()
    };
  };
  const credentials = (
    person: Founder,
    connectionId: string,
    unattested = false
  ): Promise<GranolaOAuthCredential> =>
    run(async () => {
      const existing = refreshes.get(connectionId);
      if (existing) return existing;
      const current = exact(await store.read(person), connectionId);
      if (
        (!unattested && !current.policy?.enabled) ||
        !current.tokens ||
        current.phase !== "connected"
      )
        throw new GranolaSourceError("reauthentication-required");
      if (Date.parse(current.tokens.expiresAt) > now().getTime() + 60_000)
        return {
          accessToken: current.tokens.accessToken,
          expiresAt: current.tokens.expiresAt
        };
      const joined = refreshes.get(connectionId);
      if (joined) return joined;
      const refreshing = (async () => {
        const claimed = await store.update(person, (state) => {
          const bound = exact(state, connectionId);
          if (bound.phase !== "connected" || !bound.tokens || !bound.clientId)
            throw new GranolaOAuthError("reauthentication-required");
          return { ...bound, phase: "refreshing" };
        });
        try {
          const refreshed = tokens(
            await http.refresh({
              clientId: claimed.clientId!,
              refreshToken: claimed.tokens!.refreshToken
            }),
            claimed.tokens!.refreshToken
          );
          const saved = await store.update(person, (state) => {
            const bound = exact(state, connectionId);
            if (bound.phase !== "refreshing")
              throw new GranolaOAuthError("reauthentication-required");
            return { ...bound, phase: "connected", tokens: refreshed, lastFailure: null };
          });
          return {
            accessToken: saved.tokens!.accessToken,
            expiresAt: saved.tokens!.expiresAt
          };
        } catch {
          await store
            .update(person, (state) => {
              const bound = exact(state, connectionId);
              if (bound.phase !== "refreshing") return bound;
              return {
                ...bound,
                phase: "reconnect-required",
                tokens: null,
                lastFailure: "refresh-unproven"
              };
            })
            .catch(() => undefined);
          throw new GranolaSourceError("reauthentication-required");
        }
      })();
      refreshes.set(connectionId, refreshing);
      try {
        return await refreshing;
      } finally {
        refreshes.delete(connectionId);
      }
    });
  const managedClient = (
    person: Founder,
    connectionId: string,
    unattested = false
  ): GranolaMcpClient => {
    let session: { token: string; client: GranolaMcpClient } | undefined;
    const operation = <T>(read: (client: GranolaMcpClient) => Promise<T>): Promise<T> =>
      run(async () => {
        const credential = await credentials(person, connectionId, unattested);
        if (!session || session.token !== credential.accessToken)
          session = {
            token: credential.accessToken,
            client: createGranolaMcpClient({
              credential: () => Promise.resolve(credential),
              ...(input.fetch ? { fetch: input.fetch } : {}),
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
            })
          };
        try {
          const result = await read(session.client);
          const current = exact(await store.read(person), connectionId);
          if (
            current.phase !== "connected" ||
            !current.tokens ||
            (!unattested && !current.policy?.enabled)
          )
            throw new GranolaSourceError("reauthentication-required");
          return result;
        } catch (error) {
          if (
            error instanceof GranolaSourceError &&
            error.code === "reauthentication-required"
          )
            await store
              .update(person, (state) => {
                const bound = exact(state, connectionId);
                return bound.phase === "connected"
                  ? { ...bound, phase: "reconnect-required", tokens: null }
                  : bound;
              })
              .catch(() => undefined);
          throw error;
        }
      });
    return {
      tools: () => operation((client) => client.tools()),
      call: (name, args) =>
        operation((client) => client.call(name, structuredClone(args)))
    };
  };
  const account = async (person: Founder, state: GranolaOAuthState) => {
    const client = managedClient(person, state.connectionId, true);
    requireGranolaReadTools(await client.tools());
    const result = await client.call("get_account_info", {}),
      accountText = toolText(result);
    if (accountText.length > 8_000) throw new GranolaOAuthError("attestation-required");
    return { accountText, accountFingerprint: granolaAccountFingerprint(result) };
  };
  const policy: GranolaPolicy = {
    read: (connectionId) =>
      run(async () => {
        const state = (await store.list()).find(
          (item) => item.connectionId === connectionId
        );
        if (
          !state?.policy?.enabled ||
          state.phase === "disconnected" ||
          state.phase === "registering" ||
          state.phase === "awaiting-authorization" ||
          state.phase === "exchanging"
        )
          throw new GranolaSourceError("policy-withheld");
        return structuredClone(state.policy);
      })
  };
  return {
    policy,
    begin: ({ actor }: { actor: GranolaOwnerActor }) =>
      run(async () => {
        actor = structuredClone(actor);
        const person = await owner(actor),
          connectionId = `granola:${randomUUID()}`;
        const attempt = {
          state: randomBytes(32).toString("base64url"),
          verifier: randomBytes(64).toString("base64url"),
          expiresAt: new Date(now().getTime() + 600_000).toISOString()
        };
        await sameOwner(actor, person);
        await store.update(person, () => ({
          ownerPersonId: person,
          connectionId,
          phase: "registering",
          attempt,
          clientId: null,
          tokens: null,
          policy: null,
          lastFailure: null
        }));
        authorizationFlights.add(connectionId);
        try {
          const clientId = await http.register(redirectUri);
          await sameOwner(actor, person);
          await store.update(person, (state) => {
            const bound = exact(state, connectionId);
            if (bound.phase !== "registering")
              throw new GranolaOAuthError("invalid-callback");
            return { ...bound, clientId, phase: "awaiting-authorization" };
          });
          const url = new URL(`${granolaOAuthIssuer}/oauth2/authorize`);
          url.search = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "mcp offline_access",
            resource: granolaOAuthResource,
            state: attempt.state,
            code_challenge: createHash("sha256")
              .update(attempt.verifier)
              .digest("base64url"),
            code_challenge_method: "S256"
          }).toString();
          return {
            connectionId,
            authorizationUrl: url.href,
            expiresAt: attempt.expiresAt
          };
        } catch {
          await store
            .update(person, (state) => {
              const bound = exact(state, connectionId);
              return bound.phase === "registering"
                ? {
                    ...bound,
                    phase: "reconnect-required",
                    attempt: null,
                    lastFailure: "authorization-incomplete"
                  }
                : bound;
            })
            .catch(() => undefined);
          throw new GranolaOAuthError("unavailable");
        } finally {
          authorizationFlights.delete(connectionId);
        }
      }),
    complete: ({
      actor,
      callbackUrl
    }: {
      actor: GranolaOwnerActor;
      callbackUrl: string;
    }) =>
      run(async () => {
        actor = structuredClone(actor);
        const person = await owner(actor),
          callback = new URL(callbackUrl);
        if (
          callback.origin !== redirect.origin ||
          callback.pathname !== redirect.pathname ||
          callback.hash ||
          callback.username ||
          callback.password ||
          [...callback.searchParams.keys()].some(
            (key) => !["code", "state", "iss", "error", "error_description"].includes(key)
          ) ||
          ["code", "state", "iss", "error"].some(
            (key) => callback.searchParams.getAll(key).length > 1
          )
        )
          throw new GranolaOAuthError("invalid-callback");
        const state = await store.read(person);
        if (
          !state ||
          state.phase !== "awaiting-authorization" ||
          !state.attempt ||
          state.attempt.state !== callback.searchParams.get("state") ||
          Date.parse(state.attempt.expiresAt) <= now().getTime() ||
          (callback.searchParams.has("iss") &&
            callback.searchParams.get("iss") !== granolaOAuthIssuer)
        )
          throw new GranolaOAuthError("invalid-callback");
        const code = callback.searchParams.get("code");
        await sameOwner(actor, person);
        if (callback.searchParams.has("error")) {
          await store.update(person, (current) => {
            const bound = exact(current, state.connectionId);
            if (
              bound.phase !== "awaiting-authorization" ||
              bound.attempt?.state !== state.attempt!.state
            )
              throw new GranolaOAuthError("invalid-callback");
            return {
              ...bound,
              phase: "reconnect-required",
              attempt: null,
              lastFailure: "authorization-incomplete"
            };
          });
          throw new GranolaOAuthError("authorization-declined");
        }
        if (!code || code.length > 8_000) throw new GranolaOAuthError("invalid-callback");
        await store.update(person, (current) => {
          const bound = exact(current, state.connectionId);
          if (
            bound.phase !== "awaiting-authorization" ||
            bound.attempt?.state !== state.attempt!.state
          )
            throw new GranolaOAuthError("invalid-callback");
          return { ...bound, phase: "exchanging" };
        });
        authorizationFlights.add(state.connectionId);
        try {
          const received = tokens(
            await http.exchange({
              clientId: state.clientId!,
              redirectUri,
              code,
              verifier: state.attempt.verifier
            })
          );
          await sameOwner(actor, person);
          await store.update(person, (current) => {
            const bound = exact(current, state.connectionId);
            if (bound.phase !== "exchanging")
              throw new GranolaOAuthError("invalid-callback");
            return {
              ...bound,
              phase: "connected",
              attempt: null,
              tokens: received,
              lastFailure: null
            };
          });
          return {
            connectionId: state.connectionId,
            status: "awaiting-owner-attestation" as const
          };
        } catch {
          await store
            .update(person, (current) => {
              const bound = exact(current, state.connectionId);
              return bound.phase === "exchanging"
                ? {
                    ...bound,
                    phase: "reconnect-required",
                    attempt: null,
                    tokens: null,
                    lastFailure: "exchange-unproven"
                  }
                : bound;
            })
            .catch(() => undefined);
          throw new GranolaOAuthError("reauthentication-required");
        } finally {
          authorizationFlights.delete(state.connectionId);
        }
      }),
    inspect: ({ actor }: { actor: GranolaOwnerActor }) =>
      run(async () => {
        actor = structuredClone(actor);
        const person = await owner(actor),
          state = await store.read(person);
        if (!state || state.phase !== "connected")
          throw new GranolaOAuthError("reauthentication-required");
        const result = await account(person, state);
        await sameOwner(actor, person);
        exact(await store.read(person), state.connectionId);
        return { connectionId: state.connectionId, ...result };
      }),
    attest: ({
      actor,
      connectionId,
      accountFingerprint,
      choices
    }: {
      actor: GranolaOwnerActor;
      connectionId: string;
      accountFingerprint: string;
      choices: GranolaOwnerChoices;
    }) =>
      run(async () => {
        actor = structuredClone(actor);
        choices = granolaPolicySchema.shape.connections.element
          .pick({
            audiencePersonIds: true,
            automaticInternalMeetings: true,
            participantDirectory: true,
            includedMeetingIds: true,
            excludedMeetingIds: true
          })
          .strict()
          .parse(structuredClone(choices));
        const person = await owner(actor),
          state = exact(await store.read(person), connectionId);
        if (state.policy) throw new GranolaOAuthError("attestation-required");
        const inspected = await account(person, state);
        if (inspected.accountFingerprint !== accountFingerprint)
          throw new GranolaOAuthError("attestation-required");
        const selected = granolaPolicySchema.shape.connections.element.parse({
          ...choices,
          connectionId,
          ownerPersonId: person,
          optInId: randomUUID(),
          accountFingerprint,
          enabled: true
        });
        if (
          !selected.audiencePersonIds.includes(person) ||
          new Set(selected.audiencePersonIds).size !==
            selected.audiencePersonIds.length ||
          new Set(selected.participantDirectory.map((item) => item.email)).size !==
            selected.participantDirectory.length
        )
          throw new GranolaOAuthError("attestation-required");
        await sameOwner(actor, person);
        await store.update(person, (current) => {
          const bound = exact(current, connectionId);
          if (bound.phase !== "connected" || bound.policy)
            throw new GranolaOAuthError("attestation-required");
          return { ...bound, policy: selected };
        });
        return { connectionId, status: "connected" as const };
      }),
    configure: ({
      actor,
      connectionId,
      choices,
      expectedPolicy
    }: {
      actor: GranolaOwnerActor;
      connectionId: string;
      choices: GranolaOwnerChoices;
      expectedPolicy?: NonNullable<GranolaOAuthState["policy"]>;
    }) =>
      run(async () => {
        actor = structuredClone(actor);
        const expected =
          expectedPolicy === undefined ? undefined : JSON.stringify(expectedPolicy);
        const person = await owner(actor),
          state = exact(await store.read(person), connectionId);
        if (
          !state.policy?.enabled ||
          state.phase !== "connected" ||
          (expected !== undefined && JSON.stringify(state.policy) !== expected)
        )
          throw new GranolaOAuthError("attestation-required");
        const selected = granolaPolicySchema.shape.connections.element
          .pick({
            audiencePersonIds: true,
            automaticInternalMeetings: true,
            participantDirectory: true,
            includedMeetingIds: true,
            excludedMeetingIds: true
          })
          .parse(structuredClone(choices));
        if (
          !selected.audiencePersonIds.includes(person) ||
          new Set(selected.audiencePersonIds).size !==
            selected.audiencePersonIds.length ||
          new Set(selected.participantDirectory.map((item) => item.email)).size !==
            selected.participantDirectory.length
        )
          throw new GranolaOAuthError("attestation-required");
        const inspected = await account(person, state);
        if (inspected.accountFingerprint !== state.policy.accountFingerprint)
          throw new GranolaOAuthError("attestation-required");
        await sameOwner(actor, person);
        await store.update(person, (current) => {
          const bound = exact(current, connectionId);
          if (
            !bound.policy?.enabled ||
            bound.phase !== "connected" ||
            JSON.stringify(bound.policy) !== JSON.stringify(state.policy)
          )
            throw new GranolaOAuthError("attestation-required");
          return { ...bound, policy: { ...bound.policy, ...selected } };
        });
        return { connectionId, status: "connected" as const };
      }),
    disconnect: ({ actor }: { actor: GranolaOwnerActor }) =>
      run(async () => {
        actor = structuredClone(actor);
        const person = await owner(actor);
        await sameOwner(actor, person);
        const state = await store.read(person);
        if (state)
          await store.update(person, (current) => ({
            ...exact(current, state.connectionId),
            phase: "disconnected",
            tokens: null,
            attempt: null,
            policy: current!.policy ? { ...current!.policy, enabled: false } : null
          }));
        return { status: "disconnected" as const };
      }),
    connections: () =>
      run(async () =>
        (await store.list())
          .filter((state) => state.policy?.enabled)
          .map((state) => ({
            connectionId: state.connectionId,
            client: managedClient(state.ownerPersonId, state.connectionId)
          }))
      ),
    status: () =>
      run(async () =>
        (await store.list()).map((state) => ({
          ownerPersonId: state.ownerPersonId,
          connectionId: state.connectionId,
          status:
            state.phase === "connected"
              ? state.policy?.enabled
                ? "connected"
                : "awaiting-owner-attestation"
              : (state.phase === "refreshing" && !refreshes.has(state.connectionId)) ||
                  ((state.phase === "registering" || state.phase === "exchanging") &&
                    !authorizationFlights.has(state.connectionId)) ||
                  (state.phase === "awaiting-authorization" &&
                    Date.parse(state.attempt?.expiresAt ?? "") <= now().getTime())
                ? "reconnect-required"
                : state.phase,
          lastFailure: state.lastFailure
        }))
      ),
    async stop() {
      stopped = true;
      await Promise.allSettled([...active]);
    }
  };
}
