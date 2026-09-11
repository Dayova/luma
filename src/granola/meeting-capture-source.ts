import type { LumaDatabase } from "../persistence/db.js";
import { isDeepStrictEqual } from "node:util";
import type { ContextAudience } from "../organizational-context/interface.js";
import type {
  CaptureRevisionVerifier,
  MeetingCaptureAddress,
  MeetingCaptureRevision,
  MeetingCaptureSource
} from "../logical-meetings/interface.js";
import { meetingCaptureTitleFingerprint } from "../knowledge/meeting-capture-title-fingerprint.js";
import { GranolaSourceError, type GranolaMcpClient } from "./mcp-client.js";
import type { GranolaConnectionPolicy, GranolaPolicy } from "./policy.js";
import {
  digest,
  granolaAccountFingerprint,
  granolaMeetingDocuments,
  requireGranolaReadTools,
  type GranolaMeetingDocument
} from "./wire-format.js";

export type GranolaDiscovery = Awaited<ReturnType<MeetingCaptureSource["discover"]>> & {
  coverage: { complete: false; reasons: readonly string[]; historyWindowDays: number };
};
export interface GranolaMeetingCaptureSource extends MeetingCaptureSource {
  discover(
    input: Parameters<MeetingCaptureSource["discover"]>[0]
  ): Promise<GranolaDiscovery>;
  verifier: CaptureRevisionVerifier;
  /** The only source-content read; always checks original and current sharing + provider bytes. */
  readCurrent(input: {
    revision: MeetingCaptureRevision;
    audience: ContextAudience;
  }): Promise<{
    text: string;
    provenance: "provider-derived";
    authorizationScopeId: string;
  }>;
  knownCaptures(): Promise<MeetingCaptureAddress[]>;
}
type Archive = {
  descriptor_json: string;
  material: string | null;
  audience_json: string;
  account_fingerprint: string;
  opt_in_id: string;
};

/** Uses an attested personal connection and archives only organizationally eligible material. */
export async function createGranolaMeetingCaptureSource(input: {
  database: LumaDatabase;
  workspaceId: string;
  connectionId: string;
  client: GranolaMcpClient;
  policy: GranolaPolicy;
  now?: () => Date;
}): Promise<GranolaMeetingCaptureSource> {
  const now = input.now ?? (() => new Date());
  const historyWindowDays = 30;
  if (!input.workspaceId.trim() || !input.connectionId.trim())
    throw new GranolaSourceError("policy-withheld");
  await input.database.exec(`CREATE TABLE IF NOT EXISTS granola_capture_locks (
    workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, PRIMARY KEY(workspace_id,connection_id)
  ); CREATE TABLE IF NOT EXISTS granola_capture_revisions (
    workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, capture_id TEXT NOT NULL,
    revision INTEGER NOT NULL, descriptor_json TEXT NOT NULL, material TEXT,
    audience_json TEXT NOT NULL, account_fingerprint TEXT NOT NULL, opt_in_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id,connection_id,capture_id,revision)
  )`);
  const address = (id: string): MeetingCaptureAddress => ({
    providerId: "granola",
    providerConnectionId: input.connectionId,
    externalCaptureId: id,
    sourceKind: "meeting-capture"
  });
  const checkAddress = (capture: MeetingCaptureAddress) => {
    if (
      capture.providerId !== "granola" ||
      capture.providerConnectionId !== input.connectionId ||
      capture.sourceKind !== "meeting-capture" ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(capture.externalCaptureId)
    )
      throw new GranolaSourceError("policy-withheld");
  };
  const policy = async () => {
    const current = await input.policy.read(input.connectionId);
    if (current.connectionId !== input.connectionId)
      throw new GranolaSourceError("policy-withheld");
    return current;
  };
  const requireAccount = async (bound: GranolaConnectionPolicy) => {
    if (!bound.enabled) throw new GranolaSourceError("policy-withheld");
    if (
      granolaAccountFingerprint(await input.client.call("get_account_info", {})) !==
      bound.accountFingerprint
    )
      throw new GranolaSourceError("policy-withheld");
  };
  const requirePolicy = async (bound: GranolaConnectionPolicy) => {
    if (digest(await policy()) !== digest(bound))
      throw new GranolaSourceError("policy-withheld");
  };
  const archived = async (revision: MeetingCaptureRevision): Promise<Archive> => {
    checkAddress(revision.address);
    const rows = await input.database.query<Archive>(
      `SELECT descriptor_json,material,audience_json,account_fingerprint,opt_in_id FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id=$2 AND capture_id=$3 AND revision=$4`,
      [
        input.workspaceId,
        input.connectionId,
        revision.address.externalCaptureId,
        revision.sourceRevision
      ]
    );
    const row = rows.rows[0];
    if (!row || !isDeepStrictEqual(JSON.parse(row.descriptor_json) as unknown, revision))
      throw new GranolaSourceError("source-changed");
    return row;
  };
  const readDocument = async (id: string, bound: GranolaConnectionPolicy) => {
    await requireAccount(bound);
    requireGranolaReadTools(await input.client.tools());
    const documents = granolaMeetingDocuments(
      await input.client.call("get_meetings", { meeting_ids: [id] })
    );
    if (documents.length !== 1 || documents[0]!.id !== id)
      throw new GranolaSourceError("source-unavailable");
    await requireAccount(bound);
    await requirePolicy(bound);
    return documents[0]!;
  };
  const discovered = new Map<string, GranolaMeetingDocument>();
  const source: GranolaMeetingCaptureSource = {
    async discover(request) {
      if (
        request.workspaceId !== input.workspaceId ||
        request.providerConnectionId !== input.connectionId ||
        request.cursor
      )
        throw new GranolaSourceError("policy-withheld");
      const limit = request.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new GranolaSourceError("provider-shape-unsupported");
      const bound = await policy();
      await requireAccount(bound);
      requireGranolaReadTools(await input.client.tools());
      const documents = granolaMeetingDocuments(
        await input.client.call("list_meetings", { limit })
      );
      if (documents.length > limit)
        throw new GranolaSourceError("provider-shape-unsupported");
      await requireAccount(bound);
      await requirePolicy(bound);
      discovered.clear();
      for (const document of documents) discovered.set(document.id, document);
      // Metadata stays transient. No personal title/attendees are archived here.
      return {
        captures: documents.map((item) => address(item.id)),
        nextCursor: null,
        coverage: {
          complete: false,
          historyWindowDays,
          reasons: ["rolling-history-window", "bounded-provider-discovery"]
        }
      };
    },
    async fetchCapture(request) {
      if (request.workspaceId !== input.workspaceId)
        throw new GranolaSourceError("policy-withheld");
      checkAddress(request.capture);
      const id = request.capture.externalCaptureId;
      const bound = await policy();
      let document: GranolaMeetingDocument | null = null;
      let eligibility: MeetingCaptureRevision["eligibility"] = {
        state: "requires-human-import"
      };
      if (!bound.enabled || bound.excludedMeetingIds.includes(id))
        eligibility = { state: "excluded", reason: "private" };
      else if (
        bound.includedMeetingIds.includes(id) ||
        (discovered.has(id) && eligible(discovered.get(id)!, bound))
      ) {
        document = await readDocument(id, bound);
        if (eligible(document, bound)) eligibility = { state: "eligible" };
        else document = null;
      }
      await requirePolicy(bound);
      const audience =
        eligibility.state === "eligible" ? [...bound.audiencePersonIds].sort() : [];
      const material = document?.body ?? null;
      const descriptorBase = describe(request.capture, document, eligibility);
      const hash = digest({
        material,
        descriptor: descriptorBase,
        account: bound.accountFingerprint,
        optInId: bound.optInId
      });
      return input.database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO granola_capture_locks VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [input.workspaceId, input.connectionId]
        );
        await tx.query(
          `SELECT connection_id FROM granola_capture_locks WHERE workspace_id=$1 AND connection_id=$2 FOR UPDATE`,
          [input.workspaceId, input.connectionId]
        );
        const rows = await tx.query<Archive & { revision: number }>(
          `SELECT revision,descriptor_json,material,audience_json,account_fingerprint,opt_in_id FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id=$2 AND capture_id=$3 ORDER BY revision DESC LIMIT 1`,
          [input.workspaceId, input.connectionId, id]
        );
        const last = rows.rows[0];
        const previous = last
          ? (JSON.parse(last.descriptor_json) as MeetingCaptureRevision)
          : null;
        // Sharing is immutable for an unchanged raw revision. Current narrowing
        // is checked separately; widening cannot retroactively rewrite its grant.
        if (previous?.contentHash === hash) return previous;
        const revision: MeetingCaptureRevision = {
          ...descriptorBase,
          sourceRevision: (last?.revision ?? 0) + 1,
          contentHash: hash,
          providerVersion: null,
          capturedAt: now().toISOString()
        };
        await tx.query(
          `INSERT INTO granola_capture_revisions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.workspaceId,
            input.connectionId,
            id,
            revision.sourceRevision,
            JSON.stringify(revision),
            material,
            JSON.stringify(audience),
            bound.accountFingerprint,
            bound.optInId
          ]
        );
        return revision;
      });
    },
    verifier: {
      async verify({ workspaceId, revision }) {
        try {
          if (workspaceId !== input.workspaceId)
            throw new GranolaSourceError("policy-withheld");
          const row = await archived(revision);
          const bound = await policy();
          if (
            row.account_fingerprint !== bound.accountFingerprint ||
            row.opt_in_id !== bound.optInId
          )
            throw new GranolaSourceError("policy-withheld");
          if (revision.eligibility.state === "eligible") {
            await source.readCurrent({
              revision,
              audience: {
                workspaceId,
                personIds: JSON.parse(row.audience_json) as string[]
              }
            });
          } else if (
            revision.eligibility.state === "excluded" &&
            revision.eligibility.reason === "private"
          ) {
            if (
              bound.enabled &&
              !bound.excludedMeetingIds.includes(revision.address.externalCaptureId)
            )
              throw new GranolaSourceError("policy-withheld");
          }
          return { status: "verified" };
        } catch {
          return {
            status: "unavailable",
            message:
              "Granola capture or its original sharing grant could not be verified.",
            retryable: true
          };
        }
      }
    },
    async readCurrent({ revision, audience }) {
      const row = await archived(revision);
      const original = JSON.parse(row.audience_json) as string[];
      const bound = await policy();
      if (
        !bound.enabled ||
        bound.excludedMeetingIds.includes(revision.address.externalCaptureId) ||
        audience.workspaceId !== input.workspaceId ||
        !audience.personIds.length ||
        new Set(audience.personIds).size !== audience.personIds.length ||
        audience.personIds.some(
          (person) =>
            !original.includes(person) ||
            !(bound.audiencePersonIds as string[]).includes(person)
        ) ||
        row.material === null ||
        revision.eligibility.state !== "eligible" ||
        row.account_fingerprint !== bound.accountFingerprint ||
        row.opt_in_id !== bound.optInId
      )
        throw new GranolaSourceError("policy-withheld");
      const document = await readDocument(revision.address.externalCaptureId, bound);
      if (!eligible(document, bound)) throw new GranolaSourceError("policy-withheld");
      const latest = await input.database.query<{ revision: number }>(
        `SELECT revision FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id=$2 AND capture_id=$3 ORDER BY revision DESC LIMIT 1`,
        [input.workspaceId, input.connectionId, revision.address.externalCaptureId]
      );
      if (
        latest.rows[0]?.revision !== revision.sourceRevision ||
        document.body !== row.material
      )
        throw new GranolaSourceError("source-changed");
      await requirePolicy(bound);
      return {
        text: row.material,
        provenance: "provider-derived",
        authorizationScopeId: digest([
          input.workspaceId,
          input.connectionId,
          row.account_fingerprint,
          row.opt_in_id
        ])
      };
    },
    async knownCaptures() {
      const known: string[] = [];
      let after = "";
      for (;;) {
        const page = await input.database.query<{ capture_id: string }>(
          `SELECT DISTINCT capture_id FROM granola_capture_revisions WHERE workspace_id=$1 AND connection_id=$2 AND capture_id>$3 ORDER BY capture_id LIMIT 500`,
          [input.workspaceId, input.connectionId, after]
        );
        known.push(...page.rows.map((row) => row.capture_id));
        if (page.rows.length < 500) break;
        after = page.rows.at(-1)!.capture_id;
      }
      const bound = await policy();
      return [...new Set([...known, ...bound.includedMeetingIds])].map(address);
    }
  };
  return source;
}
function eligible(
  document: GranolaMeetingDocument,
  policy: GranolaConnectionPolicy
): boolean {
  if (!policy.enabled || policy.excludedMeetingIds.includes(document.id)) return false;
  if (policy.includedMeetingIds.includes(document.id)) return true;
  if (!policy.automaticInternalMeetings || !document.participants) return false;
  const emails = [...document.participants.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map(
    (match) => match[1]!.toLowerCase()
  );
  // This rule is explicitly opted in: all reported participants must resolve
  // through the owner's declared founder directory, with at least two founders.
  const lines = document.participants
    .trim()
    .split(/\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (emails.length !== lines.length || emails.length < 2) return false;
  const people = emails.map(
    (email) =>
      policy.participantDirectory.find((entry) => entry.email === email)?.personId
  );
  return (
    people.every(Boolean) &&
    new Set(people).size >= 2 &&
    people.includes(policy.ownerPersonId)
  );
}
function describe(
  address: MeetingCaptureAddress,
  document: GranolaMeetingDocument | null,
  eligibility: MeetingCaptureRevision["eligibility"]
): Omit<
  MeetingCaptureRevision,
  "sourceRevision" | "contentHash" | "providerVersion" | "capturedAt"
> {
  const externalReference = {
    providerId: "granola",
    objectType: "document" as const,
    externalId: address.externalCaptureId,
    url: `https://notes.granola.ai/d/${encodeURIComponent(address.externalCaptureId)}`
  };
  return {
    address,
    eligibility,
    availability: document?.hasNotes ? "partial" : "not-ready",
    capabilities: {
      enhancedNotes: document?.hasNotes ? "available" : "unknown",
      rawTranscript: "unavailable",
      speakerIdentity: "unavailable",
      attendees: document?.participants ? "partial" : "unavailable",
      revisionMetadata: "unavailable"
    },
    identityFacts: {
      calendarEventKeys: [],
      conferenceKeys: [],
      interval: null,
      attendeePersonIds: [],
      titleFingerprint: document ? meetingCaptureTitleFingerprint(document.title) : null,
      contextKeys: []
    },
    materials: document?.hasNotes
      ? [
          {
            kind: "derived-notes",
            provenance: "provider-derived",
            sourceObjectId: address.externalCaptureId,
            sourceVersion: digest(document.body),
            externalReference
          }
        ]
      : [],
    externalReference
  };
}
