import { createHash } from "node:crypto";
import { GranolaSourceError, isRecord, type GranolaTool } from "./mcp-client.js";

/** A pinned account-info result is attested by the user during connection setup. */
export function granolaAccountFingerprint(result: unknown): string {
  const content = toolText(result);
  return digest(content);
}
export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
export function toolText(result: unknown): string {
  if (
    !isRecord(result) ||
    result["isError"] === true ||
    !Array.isArray(result["content"])
  )
    throw unsupported();
  const content = result["content"];
  if (
    content.length !== 1 ||
    !isRecord(content[0]) ||
    content[0]["type"] !== "text" ||
    typeof content[0]["text"] !== "string" ||
    !content[0]["text"].trim() ||
    content[0]["text"].length > 200_000
  )
    throw unsupported();
  return content[0]["text"];
}

/** Validate the small documented read surface against its live advertised schema. */
export function requireGranolaReadTools(tools: GranolaTool[]): void {
  for (const [name, parameters] of [
    ["get_account_info", []],
    ["list_meetings", ["limit"]],
    ["get_meetings", ["meeting_ids"]]
  ] as const) {
    const matches = tools.filter((tool) => tool.name === name);
    if (matches.length !== 1) throw unsupported();
    const schema = matches[0]!.inputSchema;
    const properties = schema["properties"];
    const required = schema["required"] ?? [];
    if (
      schema["type"] !== "object" ||
      !isRecord(properties) ||
      !Array.isArray(required) ||
      required.some((key) => !(parameters as readonly unknown[]).includes(key))
    )
      throw unsupported();
    for (const parameter of parameters) {
      const field = properties[parameter];
      if (!isRecord(field)) throw unsupported();
      if (
        parameter === "limit" &&
        field["type"] !== "integer" &&
        field["type"] !== "number"
      )
        throw unsupported();
      if (
        parameter === "meeting_ids" &&
        (field["type"] !== "array" ||
          !isRecord(field["items"]) ||
          field["items"]["type"] !== "string")
      )
        throw unsupported();
    }
  }
}
export type GranolaMeetingDocument = {
  id: string;
  title: string;
  /** Original provider date text. No timezone or end-time is inferred. */
  date: string;
  participants: string | null;
  /** Original provider response for this capture, always derived provider Evidence. */
  body: string;
  hasNotes: boolean;
};

/**
 * Granola's documented MCP integration examples return an XML-like text envelope,
 * not a REST API note. Accept only complete meeting wrappers and exact IDs. No
 * HTML parser, entity expansion, fallback LLM or ambiguous best-effort extraction.
 */
export function granolaMeetingDocuments(result: unknown): GranolaMeetingDocument[] {
  const text = toolText(result).trim();
  let body = text;
  if (body.startsWith("<meetings_data ") || body.startsWith("<meetings_data>")) {
    const openingEnd = body.indexOf(">");
    if (openingEnd < 0 || !body.endsWith("</meetings_data>")) throw unsupported();
    body = body.slice(openingEnd + 1, -"</meetings_data>".length).trim();
  }
  const output: GranolaMeetingDocument[] = [];
  while (body.length) {
    const header =
      /^<meeting\s+id="([a-zA-Z0-9-]{1,128})"\s+title="([^"<>]{1,1000})"\s+date="([^"<>]{1,100})"\s*>/.exec(
        body
      );
    if (!header || output.length >= 50) throw unsupported();
    const end = body.indexOf("</meeting>", header[0].length);
    if (end < 0) throw unsupported();
    const inner = body.slice(header[0].length, end);
    if (/<\/?meeting(?:\s|>)/.test(inner)) throw unsupported();
    const document = body.slice(0, end + "</meeting>".length);
    const participants = uniqueSection(inner, "known_participants");
    const notes = uniqueSection(inner, "notes");
    const summary = uniqueSection(inner, "summary");
    output.push({
      id: header[1]!,
      title: header[2]!,
      date: header[3]!,
      participants,
      body: document,
      hasNotes: Boolean(notes?.trim() || summary?.trim())
    });
    body = body.slice(document.length).trim();
  }
  if (new Set(output.map((entry) => entry.id)).size !== output.length)
    throw unsupported();
  return output;
}
function uniqueSection(body: string, tag: string): string | null {
  const opening = `<${tag}>`;
  const closing = `</${tag}>`;
  const start = body.indexOf(opening);
  const end = body.indexOf(closing);
  if (start < 0 && end < 0) return null;
  if (
    start < 0 ||
    end < start ||
    body.indexOf(opening, start + opening.length) >= 0 ||
    body.indexOf(closing, end + closing.length) >= 0
  )
    throw unsupported();
  return body.slice(start + opening.length, end);
}
function unsupported(): GranolaSourceError {
  return new GranolaSourceError("provider-shape-unsupported");
}
