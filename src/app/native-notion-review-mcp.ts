import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Socket } from "node:net";
import type { NativeReviewDiscovery } from "../native-review/native-review-access.js";
import { NativeReviewUnavailable } from "../native-review/native-review-access.js";
import type { NativeNotionReviewRuntime } from "./native-notion-review-runtime.js";

const locators = z
  .object({ sessionId: z.string().uuid(), eventId: z.string().uuid() })
  .strict();
const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(256), z.number().finite()]).optional(),
    method: z.string().max(128),
    params: z.unknown().optional()
  })
  .strict();
const versions = ["2025-03-26", "2025-06-18", "2025-11-25"];
const tool = {
  name: "review_meeting_note",
  description:
    "Read-only Luma work reconciliation. The founder must first send exactly: Luma review <Meeting Note URL>. Use find_review_requests to obtain real provider session and original user-message event IDs; never invent them. Arguments only locate provider evidence; they cannot grant access. No task or page is changed.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", format: "uuid" },
      eventId: { type: "string", format: "uuid" }
    },
    required: ["sessionId", "eventId"],
    additionalProperties: false
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
};

const discoveryTool = {
  name: "find_review_requests",
  description:
    "Find authentic founder requests for the configured Meeting Note in the configured Custom Agent. No arguments. Returns only verified locators, founder labels and times within a bounded seven-day search. Does not identify the current invocation; do not guess which request to review when several match. No model call or external change.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
};

/** Stateless Streamable HTTP MCP with authenticated read-only tools, no ambient Human fields. */
export function createNativeNotionReviewMcp(input: {
  runtime: NativeNotionReviewRuntime;
  discovery?: NativeReviewDiscovery;
  bearerToken: string;
  hostname?: string;
  port?: number;
  path?: string;
  allowedOrigins?: readonly string[];
}) {
  if (input.bearerToken.length < 32)
    throw new Error("Native review MCP bearer must contain at least 32 characters");
  const path = input.path ?? "/notion/review/mcp";
  if (!/^\/[A-Za-z0-9/_-]+$/u.test(path))
    throw new Error("Native review MCP requires an exact HTTP path");
  const origins = new Set(input.allowedOrigins ?? []);
  const expected = hash(`Bearer ${input.bearerToken}`);
  const active = new Set<Promise<void>>(),
    reading = new Set<IncomingMessage>();
  const sockets = new Set<Socket>(),
    busySockets = new Set<Socket>();
  let stopped = false,
    started = false;
  let starting: Promise<void> | undefined;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body?: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (stopped) return send(503);
    if (request.url !== path) return send(404);
    if (request.headers.origin && !origins.has(request.headers.origin)) return send(403);
    if (!timingSafeEqual(hash(request.headers.authorization ?? ""), expected))
      return send(401);
    if (request.method !== "POST") return send(405);
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return send(415);
    const version = request.headers["mcp-protocol-version"];
    if (version && (typeof version !== "string" || !versions.includes(version)))
      return send(400);
    if (active.size >= 4) return send(429);
    reading.add(request);
    let raw: unknown;
    const timer = setTimeout(() => request.destroy(), 10_000);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.byteLength;
        if (size > 16_384) return send(413);
        chunks.push(buffer);
      }
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      return send(400);
    } finally {
      clearTimeout(timer);
      reading.delete(request);
    }
    if (stopped) return send(503);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return send(400);
    const message = parsed.data;
    const result = (value: unknown) =>
      send(200, { jsonrpc: "2.0", id: message.id, result: value });
    const error = (code: number, text: string) =>
      send(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    if (message.id === undefined)
      return message.method === "notifications/initialized" ? send(202) : send(400);
    if (message.method === "initialize") {
      const params = z.object({ protocolVersion: z.string() }).safeParse(message.params);
      if (!params.success) return error(-32602, "Invalid initialization");
      return result({
        protocolVersion: versions.includes(params.data.protocolVersion)
          ? params.data.protocolVersion
          : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "luma-native-review", version: "1.0.0" }
      });
    }
    if (message.method === "ping") return result({});
    if (message.method === "tools/list")
      return result({ tools: input.discovery ? [discoveryTool, tool] : [tool] });
    if (message.method !== "tools/call") return error(-32601, "Method not found");
    const params = z
      .discriminatedUnion("name", [
        z
          .object({ name: z.literal("review_meeting_note"), arguments: locators })
          .strict(),
        z
          .object({
            name: z.literal("find_review_requests"),
            arguments: z.object({}).strict()
          })
          .strict()
      ])
      .safeParse(message.params);
    if (!params.success)
      return error(
        -32602,
        "Review accepts exact session/event locators; discovery accepts no arguments"
      );
    try {
      if (params.data.name === "find_review_requests") {
        if (!input.discovery) return error(-32602, "Request discovery is not configured");
        const found = await input.discovery.discover();
        const text = JSON.stringify({
          ...found.result,
          nextStep:
            "Use only these authentic locators with review_meeting_note for the intended request. If multiple requests could match the current conversation, have the founder choose using the returned name/time; do not infer a current actor or select a request merely because it is newest. Partial or empty results do not prove that no other request exists."
        });
        if (Buffer.byteLength(text) > 262_144)
          throw new NativeReviewUnavailable("review-unavailable");
        await found.requireCurrent();
        return result({ content: [{ type: "text", text }], isError: false });
      }
      const review = await input.runtime.review(params.data.arguments);
      const text = JSON.stringify({
        ...review,
        nextStep:
          "Review the proposed reconciliation. This read-only native tool cannot authorize or perform task/page changes; use Luma's authenticated work review commands for that action."
      });
      if (Buffer.byteLength(text) > 262_144)
        throw new NativeReviewUnavailable("review-unavailable");
      await input.runtime.requireCurrent(params.data.arguments, review);
      return result({ content: [{ type: "text", text }], isError: false });
    } catch (caught) {
      const text =
        caught instanceof NativeReviewUnavailable
          ? caught.message
          : "Luma could not verify or complete this review. No external change was made.";
      return result({ content: [{ type: "text", text }], isError: true });
    }
  };
  const server = createServer((request, response) => {
    busySockets.add(request.socket);
    const run = handle(request, response).catch(() => {
      if (!response.destroyed) {
        response.writeHead(500);
        response.end();
      }
    });
    active.add(run);
    void run.finally(() => {
      active.delete(run);
      busySockets.delete(request.socket);
    });
  });
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return {
    async start(): Promise<{ hostname: string; port: number }> {
      if (stopped || started)
        throw new Error("Native review listener cannot be started twice");
      started = true;
      starting = new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port ?? 3003, input.hostname ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      await starting;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Native review listener has no TCP address");
      return { hostname: address.address, port: address.port };
    },
    async stop() {
      stopped = true;
      for (const request of reading) request.destroy();
      await starting?.catch(() => undefined);
      for (const socket of sockets) if (!busySockets.has(socket)) socket.destroy();
      const closed = server.listening
        ? new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          })
        : Promise.resolve();
      await Promise.allSettled([...active]);
      await Promise.all([input.runtime.stop(), input.discovery?.stop()]);
      await closed;
    }
  };
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
