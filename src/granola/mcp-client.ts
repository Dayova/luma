import { z } from "zod";

const endpoint = "https://mcp.granola.ai/mcp";
const protocol = "2025-06-18";
const toolSchema = z.object({
  name: z.string(),
  inputSchema: z.record(z.unknown())
});
export type GranolaTool = z.infer<typeof toolSchema>;
export type GranolaReadTool = "get_account_info" | "list_meetings" | "get_meetings";
export interface GranolaMcpClient {
  tools(): Promise<GranolaTool[]>;
  call(name: GranolaReadTool, args: Record<string, unknown>): Promise<unknown>;
}
export class GranolaSourceError extends Error {
  constructor(
    readonly code:
      | "connection-unavailable"
      | "reauthentication-required"
      | "rate-limited"
      | "provider-shape-unsupported"
      | "source-unavailable"
      | "policy-withheld"
      | "source-changed"
  ) {
    super(`Granola source: ${code}`);
    this.name = "GranolaSourceError";
  }
}

/** An already authorized per-user OAuth credential. This port never discovers credentials. */
export type GranolaOAuthCredential = {
  accessToken: string;
  expiresAt: string;
};

/** Restricted Streamable HTTP client. No writer, sampling, prompt or transcript tool exists. */
export function createGranolaMcpClient(input: {
  credential: () => Promise<GranolaOAuthCredential>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): GranolaMcpClient {
  const http = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new GranolaSourceError("connection-unavailable");
  let requestId = 0;
  let negotiatedProtocol: string = protocol;
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;
  let sessionCredential: Promise<GranolaOAuthCredential> | undefined;
  const request = async (method: string, params: unknown, notification = false) => {
    const id = ++requestId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const credential = await withSignal(
        (sessionCredential ??= input.credential()),
        controller.signal
      );
      if (
        !credential.accessToken.trim() ||
        !Number.isFinite(Date.parse(credential.expiresAt)) ||
        Date.parse(credential.expiresAt) <= Date.now() + timeoutMs
      ) {
        sessionCredential = undefined;
        initialized = undefined;
        sessionId = undefined;
        throw new GranolaSourceError("reauthentication-required");
      }
      const response = await withSignal(
        http(endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential.accessToken}`,
            "MCP-Protocol-Version": negotiatedProtocol,
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(notification ? {} : { id }),
            method,
            params
          })
        }),
        controller.signal
      );
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status)) {
          sessionCredential = undefined;
          initialized = undefined;
          sessionId = undefined;
        }
        throw new GranolaSourceError(
          response.status === 401 || response.status === 403
            ? "reauthentication-required"
            : response.status === 429
              ? "rate-limited"
              : "connection-unavailable"
        );
      }
      if (notification) {
        await response.body?.cancel();
        if (response.status !== 202)
          throw new GranolaSourceError("provider-shape-unsupported");
        return undefined;
      }
      const assigned = response.headers.get("mcp-session-id");
      if (method === "initialize" && assigned) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(assigned))
          throw new GranolaSourceError("provider-shape-unsupported");
        sessionId = assigned;
      }
      const type = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (type !== "application/json" && type !== "text/event-stream")
        throw new GranolaSourceError("provider-shape-unsupported");
      const reader = response.body?.getReader();
      if (!reader) throw new GranolaSourceError("provider-shape-unsupported");
      let text = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await withSignal(reader.read(), controller.signal);
          if (part.done) {
            text += decoder.decode();
            if (type !== "application/json") break;
            return rpcResult(JSON.parse(text) as unknown, id);
          }
          const chunk: unknown = part.value;
          if (!(chunk instanceof Uint8Array))
            throw new GranolaSourceError("provider-shape-unsupported");
          bytes += chunk.byteLength;
          if (bytes > 2_000_000)
            throw new GranolaSourceError("provider-shape-unsupported");
          text += decoder.decode(chunk, { stream: true });
          if (type === "text/event-stream") {
            text = text.replace(/\r\n/g, "\n");
            for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
              const event = text.slice(0, end);
              text = text.slice(end + 2);
              const data = event
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const frame: unknown = JSON.parse(data);
              if (isRecord(frame) && frame["id"] === id && !("method" in frame))
                return rpcResult(frame, id);
              // Server-initiated requests are unsupported; never perform side effects.
              if (!isRecord(frame) || "id" in frame)
                throw new GranolaSourceError("provider-shape-unsupported");
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      throw new GranolaSourceError("provider-shape-unsupported");
    } catch (error) {
      throw error instanceof GranolaSourceError
        ? error
        : new GranolaSourceError("connection-unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const initialize = () =>
    (initialized ??= (async () => {
      const result = await request("initialize", {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "luma-granola-reader", version: "1" }
      });
      if (
        !isRecord(result) ||
        !["2025-03-26", protocol].includes(String(result["protocolVersion"]))
      )
        throw new GranolaSourceError("provider-shape-unsupported");
      negotiatedProtocol = String(result["protocolVersion"]);
      await request("notifications/initialized", {}, true);
    })().catch((error) => {
      initialized = undefined;
      sessionCredential = undefined;
      sessionId = undefined;
      throw error;
    }));
  return {
    async tools() {
      await initialize();
      const tools: GranolaTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 4; page += 1) {
        const parsed = z
          .object({
            tools: z.array(toolSchema).max(100),
            nextCursor: z.string().min(1).optional()
          })
          .safeParse(await request("tools/list", cursor ? { cursor } : {}));
        if (!parsed.success) throw new GranolaSourceError("provider-shape-unsupported");
        tools.push(...parsed.data.tools);
        if (!parsed.data.nextCursor) return tools;
        if (seen.has(parsed.data.nextCursor)) break;
        cursor = parsed.data.nextCursor;
        seen.add(cursor);
      }
      throw new GranolaSourceError("provider-shape-unsupported");
    },
    async call(name, args) {
      if (!["get_account_info", "list_meetings", "get_meetings"].includes(name))
        throw new GranolaSourceError("provider-shape-unsupported");
      await initialize();
      const result = await request("tools/call", { name, arguments: args });
      if (!isRecord(result) || result["isError"] === true)
        throw new GranolaSourceError("source-unavailable");
      return result;
    }
  };
}
function rpcResult(value: unknown, id: number): unknown {
  if (
    !isRecord(value) ||
    value["jsonrpc"] !== "2.0" ||
    value["id"] !== id ||
    "error" in value ||
    !("result" in value)
  )
    throw new GranolaSourceError("provider-shape-unsupported");
  return value["result"];
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(new GranolaSourceError("connection-unavailable"));
        signal.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
