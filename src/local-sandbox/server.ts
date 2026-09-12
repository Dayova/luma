import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { page } from "./page.js";

type Session = {
  view(): Promise<unknown>;
  execute(input: unknown): Promise<unknown>;
  close(): Promise<void>;
};

async function readCommand(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > maxBytes)
      throw new Error("Request exceeds the local input limit");
  }
  return JSON.parse(body) as unknown;
}

export async function startSandboxServer(options: {
  session: Session;
  evaluate?: () => Promise<unknown>;
  page?: string;
  maxBodyBytes?: number;
  port?: number;
}) {
  let origin = "";
  let busy = false;
  let active: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    if (
      `http://${request.headers.host ?? ""}` !== origin ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, { error: "Only the local sandbox origin is accepted" });
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(options.page ?? page);
      return;
    }
    if (
      request.method !== "POST" ||
      !["/api/state", "/api/command", "/api/checks"].includes(request.url ?? "")
    ) {
      send(404, { error: "Not found" });
      return;
    }
    if (
      request.headers.origin !== origin ||
      request.headers["content-type"] !== "application/json"
    ) {
      send(403, { error: "A same-origin JSON request is required" });
      return;
    }
    if (busy) {
      send(409, { error: "A check or command is running; try again when it completes" });
      return;
    }
    busy = true;
    active = (async () => {
      try {
        const input = await readCommand(request, options.maxBodyBytes ?? 8192);
        const result =
          request.url === "/api/checks"
            ? options.evaluate
              ? await options.evaluate()
              : { error: "Offline checks are available in pnpm local" }
            : request.url === "/api/state"
              ? await options.session.view()
              : await options.session.execute(input);
        send(200, result);
      } catch (error) {
        send(400, {
          error: error instanceof Error ? error.message : "Sandbox operation failed"
        });
      } finally {
        busy = false;
      }
    })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeIdleConnections();
      await active;
      await closed;
      await options.session.close();
    }
  };
}
