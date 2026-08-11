import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { NotionMeetingNotesObservationHost } from "./notion-meeting-notes-observation-host.js";

const DEFAULT_PATH = "/notion/webhook";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type CreateNotionWebhookHttpServerInput = {
  observationHost: NotionMeetingNotesObservationHost;
  hostname?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
  /** Bounds slow headers/body uploads before they can occupy a listener slot. */
  requestTimeoutMs?: number;
};

export type NotionWebhookHttpServerAddress = {
  hostname: string;
  port: number;
};

/**
 * Node HTTP Adapter for the Notion-only observation host. It owns request
 * framing and raw-byte preservation; source capture stays behind the host.
 */
export interface NotionWebhookHttpServer {
  start(): Promise<NotionWebhookHttpServerAddress>;
  /** Quiesces admissions, aborts incomplete HTTP bodies, then settles accepted work. */
  stop(): Promise<void>;
}

export function createNotionWebhookHttpServer(
  input: CreateNotionWebhookHttpServerInput
): NotionWebhookHttpServer {
  const hostname = input.hostname ?? "127.0.0.1";
  const port = input.port ?? 3001;
  const path = requiredWebhookPath(input.path ?? DEFAULT_PATH);
  const maxBodyBytes = boundedBodyBytes(input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const requestTimeoutMs = boundedRequestTimeout(
    input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  let server: Server | null = null;
  let address: NotionWebhookHttpServerAddress | null = null;
  let starting: Promise<NotionWebhookHttpServerAddress> | null = null;
  let stopping: Promise<void> | null = null;

  const start = (): Promise<NotionWebhookHttpServerAddress> => {
    if (address) {
      return Promise.resolve(address);
    }

    if (starting) {
      return starting;
    }

    if (stopping) {
      return stopping.then(start);
    }

    const run = startHttpListener({
      hostname,
      port,
      path,
      maxBodyBytes,
      requestTimeoutMs,
      observationHost: input.observationHost,
      assignServer: (created) => {
        server = created;
      },
      assignAddress: (bound) => {
        address = bound;
      },
      clearServer: () => {
        server = null;
        address = null;
      }
    });
    starting = run;

    return run.finally(() => {
      if (starting === run) {
        starting = null;
      }
    });
  };

  const stop = (): Promise<void> => {
    if (stopping) {
      return stopping;
    }

    const activeStart = starting;
    // `stop()` executes this synchronously up to its first await, so a slow
    // client can never keep the host accepting while Node waits to close its
    // listener or finish reading that client's body.
    const hostStop = input.observationHost.stop();
    const run = (async () => {
      try {
        await activeStart?.catch(() => undefined);
        const activeServer = server;

        if (activeServer?.listening) {
          await close(activeServer);
        }
      } finally {
        try {
          await hostStop;
        } finally {
          server = null;
          address = null;
        }
      }
    })();
    stopping = run.finally(() => {
      stopping = null;
    });

    return stopping;
  };

  return {
    start,
    stop
  };
}

type StartHttpListenerInput = {
  hostname: string;
  port: number;
  path: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  observationHost: NotionMeetingNotesObservationHost;
  assignServer(server: Server): void;
  assignAddress(address: NotionWebhookHttpServerAddress): void;
  clearServer(): void;
};

async function startHttpListener(
  input: StartHttpListenerInput
): Promise<NotionWebhookHttpServerAddress> {
  input.observationHost.start();
  const created = createServer((request, response) => {
    void handleWebhookRequest({
      request,
      response,
      path: input.path,
      maxBodyBytes: input.maxBodyBytes,
      observationHost: input.observationHost
    });
  });
  // A webhook delivery is small and promptly acknowledged. Explicit bounds
  // prevent an unauthenticated slow body from occupying the listener for
  // Node's much larger defaults before HMAC verification can begin.
  created.headersTimeout = input.requestTimeoutMs;
  created.requestTimeout = input.requestTimeoutMs;
  input.assignServer(created);

  try {
    await listen(created, input.hostname, input.port);
    const bound = created.address();

    if (!bound || typeof bound === "string") {
      await close(created);
      input.clearServer();
      await input.observationHost.stop();
      throw new Error("Notion webhook HTTP server did not expose a TCP address");
    }

    const address = { hostname: bound.address, port: bound.port };
    input.assignAddress(address);
    return address;
  } catch (error) {
    input.clearServer();
    await input.observationHost.stop();
    throw error;
  }
}

type HandleWebhookRequestInput = {
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  maxBodyBytes: number;
  observationHost: NotionMeetingNotesObservationHost;
};

async function handleWebhookRequest(input: HandleWebhookRequestInput): Promise<void> {
  const { request, response } = input;

  if (request.method !== "POST") {
    rejectUnreadRequest(request, response, 405);
    return;
  }

  if (request.url !== input.path) {
    rejectUnreadRequest(request, response, 404);
    return;
  }

  if (!isJson(request.headers["content-type"]) || !isIdentityEncoding(request)) {
    rejectUnreadRequest(request, response, 415);
    return;
  }

  const signature = singleRawHeader(request, "x-notion-signature");

  if (!signature || !hasBoundedContentLength(request, input.maxBodyBytes)) {
    rejectUnreadRequest(request, response, signature ? 413 : 204);
    return;
  }

  const body = await readRawBody(request, input.maxBodyBytes);

  if (body === "too-large") {
    rejectUnreadRequest(request, response, 413);
    return;
  }

  if (body === null) {
    emptyResponse(response, 503);
    return;
  }

  try {
    const receipt = input.observationHost.receive({
      rawBody: body,
      headers: { "x-notion-signature": signature }
    });

    if (receipt.status === "unavailable") {
      emptyResponse(response, 503);
      return;
    }

    if (receipt.status === "rejected") {
      // An unauthenticated sender has supplied a bounded body, but is not
      // entitled to retain a reusable listener socket after that attempt.
      closeResponse(response, 200);
      return;
    }

    // Notion treats an exact HTTP 200 as its successful delivery receipt.
    // The payload remains only a wake-up: accepted and safely ignored signals
    // both refetch no provider content inline and must not be retried merely
    // because their current source scope is no longer relevant.
    emptyResponse(response, 200);
  } catch {
    emptyResponse(response, 503);
  }
}

function requiredWebhookPath(value: string): string {
  if (
    value.length === 0 ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value !== value.trim()
  ) {
    throw new Error(
      "Notion webhook path must be a non-blank exact path without query or fragment"
    );
  }

  return value;
}

function boundedBodyBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_BODY_BYTES) {
    throw new Error(
      `Notion webhook maxBodyBytes must be between 1 and ${DEFAULT_MAX_BODY_BYTES}`
    );
  }

  return value;
}

function boundedRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error("Notion webhook requestTimeoutMs must be between 1000 and 60000");
  }

  return value;
}

function isJson(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

function isIdentityEncoding(request: IncomingMessage): boolean {
  const value = request.headers["content-encoding"];

  return (
    value === undefined ||
    (typeof value === "string" && value.toLowerCase() === "identity")
  );
}

function singleRawHeader(request: IncomingMessage, expectedName: string): string | null {
  const values: string[] = [];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];

    if (name?.toLowerCase() === expectedName && value !== undefined) {
      values.push(value);
    }
  }

  const [signature] = values;
  return values.length === 1 && signature !== undefined && signature.trim().length > 0
    ? signature
    : null;
}

function hasBoundedContentLength(
  request: IncomingMessage,
  maxBodyBytes: number
): boolean {
  const value = request.headers["content-length"];

  if (value === undefined) {
    return true;
  }

  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return false;
  }

  const length = Number(value);
  return Number.isSafeInteger(length) && length <= maxBodyBytes;
}

async function readRawBody(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<Uint8Array | "too-large" | null> {
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
      // Copy each chunk before retaining it. IncomingMessage is typed as an
      // unbounded byte stream at the Node boundary; no untyped chunk reaches
      // the authenticated delivery Interface.
      const bytes = Uint8Array.from(chunk);
      received += bytes.byteLength;

      if (received > maxBodyBytes) {
        return "too-large";
      }

      chunks.push(bytes);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks);
}

function emptyResponse(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;

  // RFC 9110 forbids Content-Length on a 204 response. The normal Notion
  // acknowledgement path is 200; 204 remains available for malformed early
  // rejections without producing an invalid HTTP framing response.
  if (statusCode !== 204) {
    response.setHeader("content-length", "0");
  }

  response.end();
}

/**
 * Early HTTP rejection happens before the raw body has been authenticated or
 * fully read. Close this connection after the empty response rather than let
 * an unauthenticated peer retain a listener socket by trickling its body.
 */
function rejectUnreadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number
): void {
  request.resume();
  closeResponse(response, statusCode);
}

function closeResponse(response: ServerResponse, statusCode: number): void {
  response.shouldKeepAlive = false;
  response.setHeader("connection", "close");
  emptyResponse(response, statusCode);
}

function listen(server: Server, hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: hostname, port });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
    // `server.close()` waits for an incomplete request body. The host has
    // already quiesced admissions, so abort raw-body reads rather than let an
    // unauthenticated peer delay shutdown for Node's timeout window.
    server.closeAllConnections();
  });
}
