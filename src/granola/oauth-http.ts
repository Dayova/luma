import { z } from "zod";

export const granolaOAuthIssuer = "https://mcp-auth.granola.ai";
export const granolaOAuthResource = "https://mcp.granola.ai/mcp";
export class GranolaOAuthError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "owner-required"
      | "invalid-callback"
      | "authorization-declined"
      | "reauthentication-required"
      | "attestation-required"
      | "store-unavailable"
      | "stopped"
  ) {
    super(`Granola connection: ${code}`);
    this.name = "GranolaOAuthError";
  }
}
const token = z.object({
  access_token: z.string().min(1).max(32_000),
  refresh_token: z.string().min(1).max(32_000).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(60).max(31_536_000)
});
/** Fixed-origin OAuth transport. Metadata never selects a credential destination. */
export function createGranolaOAuthHttp(input: {
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const http = input.fetch ?? fetch,
    timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new GranolaOAuthError("unavailable");
  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GranolaOAuthError("unavailable"));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        http(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json", ...init?.headers }
        }),
        deadline
      ]);
      if (!response.ok) throw new GranolaOAuthError("unavailable");
      if (
        response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        throw new GranolaOAuthError("unavailable");
      reader = response.body?.getReader();
      if (!reader) throw new GranolaOAuthError("unavailable");
      let bytes = 0,
        body = "";
      const decoder = new TextDecoder();
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 100_000) throw new GranolaOAuthError("unavailable");
        body += decoder.decode(part.value, { stream: true });
      }
      return JSON.parse(body + decoder.decode()) as unknown;
    } catch {
      throw new GranolaOAuthError("unavailable");
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  };
  const verifyMetadata = async () => {
    z.object({
      resource: z.literal(granolaOAuthResource),
      authorization_servers: z.array(z.literal(granolaOAuthIssuer)).length(1),
      bearer_methods_supported: z
        .array(z.string())
        .refine((values) => values.includes("header")),
      scopes_supported: z.array(z.string()).refine((values) => values.includes("mcp"))
    }).parse(
      await request("https://mcp.granola.ai/.well-known/oauth-protected-resource")
    );
    z.object({
      issuer: z.literal(granolaOAuthIssuer),
      authorization_endpoint: z.literal(`${granolaOAuthIssuer}/oauth2/authorize`),
      token_endpoint: z.literal(`${granolaOAuthIssuer}/oauth2/token`),
      registration_endpoint: z.literal(`${granolaOAuthIssuer}/oauth2/register`),
      code_challenge_methods_supported: z
        .array(z.string())
        .refine((values) => values.includes("S256")),
      grant_types_supported: z
        .array(z.string())
        .refine(
          (values) =>
            values.includes("authorization_code") && values.includes("refresh_token")
        ),
      token_endpoint_auth_methods_supported: z
        .array(z.string())
        .refine((values) => values.includes("none")),
      scopes_supported: z
        .array(z.string())
        .refine((values) => values.includes("offline_access"))
    }).parse(
      await request(`${granolaOAuthIssuer}/.well-known/oauth-authorization-server`)
    );
  };
  const post = (path: string, body: URLSearchParams) =>
    request(`${granolaOAuthIssuer}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
  return {
    async register(redirectUri: string) {
      await verifyMetadata();
      const registration = z
        .object({
          client_id: z.string().min(1).max(4_000),
          token_endpoint_auth_method: z.literal("none"),
          redirect_uris: z.array(z.string()).length(1),
          client_secret: z.never().optional()
        })
        .parse(
          await request(`${granolaOAuthIssuer}/oauth2/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "Luma internal meeting capture",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none"
            })
          })
        );
      if (registration.redirect_uris[0] !== redirectUri)
        throw new GranolaOAuthError("unavailable");
      return registration.client_id;
    },
    async exchange(input: {
      clientId: string;
      redirectUri: string;
      code: string;
      verifier: string;
    }) {
      await verifyMetadata();
      return token.parse(
        await post(
          "/oauth2/token",
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: input.clientId,
            code: input.code,
            code_verifier: input.verifier,
            redirect_uri: input.redirectUri,
            resource: granolaOAuthResource
          })
        )
      );
    },
    async refresh(input: { clientId: string; refreshToken: string }) {
      await verifyMetadata();
      return token.parse(
        await post(
          "/oauth2/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: input.clientId,
            refresh_token: input.refreshToken,
            resource: granolaOAuthResource
          })
        )
      );
    }
  };
}
