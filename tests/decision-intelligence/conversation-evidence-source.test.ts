import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationDecisionEvidenceSource } from "../../src/decision-intelligence/conversation-evidence-source.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { captureFixture, subject, workspace } from "../consultation/harness.js";
import type { CapturedConversationEvidence } from "../../src/context-intelligence/conversation-evidence-source.js";
import type { DecisionEvidenceSource } from "../../src/decision-intelligence/ports.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});

function fixture() {
  const current = captureFixture();
  const anchor = current.snapshot.messages[0]!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text = "<@luma> record this decision";
  const statement = {
    ...structuredClone(anchor),
    id: "original-statement",
    ordinal: 0,
    text: "Wir könnten RevenueCat verwenden; das ist noch nicht final.",
    author: { ...anchor.author, personId: "person_fabius" }
  };
  anchor.ordinal = 1;
  current.snapshot.messages.unshift(statement);
  current.snapshot.boundary.firstMessageId = statement.id;
  current.snapshot.boundary.messageIds.unshift(statement.id);
  const directory = createLumaTeamIdentityDirectory();
  let ambiguous = false;
  let switched = false;
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    authorizedPersonIds: dayovaFounderPersonIds,
    identityDirectory: {
      ...directory,
      async findPeopleByProviderUserId(request) {
        const people = await directory.findPeopleByProviderUserId(request);
        if (!people.length) return people;
        if (ambiguous) return [...people, { ...people[0]!, personId: "person_fabius" }];
        return switched ? [{ ...people[0]!, personId: "person_fabius" }] : people;
      }
    }
  });
  const capture = vi.fn((): Promise<CapturedConversationEvidence> =>
    Promise.resolve(structuredClone(current))
  );
  const ledger = createObservedSourceLedger({ database });
  const source = createConversationDecisionEvidenceSource({
    workspaceId: workspace.workspaceId,
    conversationEvidenceSource: { capture },
    ledger,
    accessPolicy,
    recipientPersonIds: dayovaFounderPersonIds
  });
  const request: Parameters<DecisionEvidenceSource["capture"]>[0] = {
    workspace,
    subject,
    instruction: "record this decision",
    actor: { providerId: "discord", providerUserId: "779381502311137301" },
    audience: {
      workspaceId: workspace.workspaceId,
      personIds: [...dayovaFounderPersonIds]
    }
  };
  return {
    source,
    current,
    capture,
    request,
    makeAmbiguous: () => {
      ambiguous = true;
    },
    switchIdentity: () => {
      switched = true;
    }
  };
}

describe("Bounded Conversation Decision Evidence", () => {
  it("retains exact source wording and immutable refs while resolving authors independently of raw person metadata", async () => {
    const f = fixture();
    const source = await f.source.capture(f.request);
    expect(source.evidence[0]).toMatchObject({
      text: "Wir könnten RevenueCat verwenden; das ist noch nicht final.",
      authorPersonId: "person_jakob",
      origin: "human",
      reference: {
        sourceObjectId: "original-statement",
        sourceVersion: "1",
        externalReference: { providerId: "discord" }
      }
    });
    expect(source.audience.personIds).toEqual([...dayovaFounderPersonIds].sort());
    const before = (await database.query("SELECT * FROM observed_source_snapshots")).rows;
    const heads = (await database.query("SELECT * FROM observed_sources")).rows;
    await f.source.requireCurrent(source);
    await f.source.requireCurrent(source);
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual(before);
    expect((await database.query("SELECT * FROM observed_sources")).rows).toEqual(heads);
    expect(await f.source.capture(f.request)).toEqual(source);
  });
  it("rejects wrong actors, guests, an expanded audience and actual Meetings without retaining a substitute source", async () => {
    const f = fixture();
    for (const request of [
      {
        ...f.request,
        actor: { providerId: "discord", providerUserId: "726409024894926869" }
      },
      { ...f.request, actor: { providerId: "discord", providerUserId: "guest" } },
      {
        ...f.request,
        audience: {
          ...f.request.audience,
          personIds: [...dayovaFounderPersonIds, "guest"]
        }
      },
      { ...f.request, subject: { type: "meeting" as const, meetingId: "real-meeting" } }
    ])
      await expect(f.source.capture(request)).rejects.toThrow();
    expect(
      (await database.query("SELECT * FROM observed_source_snapshots")).rows
    ).toEqual([]);
  });
  it.each(["partial", "boundary", "deleted", "duplicate", "wrong-source"])(
    "refuses a %s capture before it can support a decision",
    async (failure) => {
      const f = fixture();
      if (failure === "partial")
        f.current.snapshot.completeness = {
          state: "partial",
          reasons: [{ code: "history-truncated", message: "History omitted" }]
        };
      if (failure === "boundary")
        f.current.snapshot.boundary.messageIds = [subject.anchorMessageId];
      if (failure === "deleted")
        f.current.snapshot.messages[0] = {
          ...f.current.snapshot.messages[0]!,
          state: "deleted",
          text: null
        };
      if (failure === "duplicate")
        f.current.snapshot.messages[0]!.id = subject.anchorMessageId;
      if (failure === "wrong-source") f.current.source.parentObjectId = "another-thread";
      await expect(f.source.capture(f.request)).rejects.toThrow();
      expect(
        (await database.query("SELECT * FROM observed_source_snapshots")).rows
      ).toEqual([]);
    }
  );
  it.each([
    "wording",
    "identity",
    "ambiguous",
    "missing-original",
    "forged-evidence",
    "audience"
  ])("invalidates retained source proof after %s changes", async (change) => {
    const f = fixture();
    const source = await f.source.capture(f.request);
    if (change === "wording")
      f.current.snapshot.messages[0]!.text = "We have now decided something different.";
    if (change === "identity") f.switchIdentity();
    if (change === "ambiguous") f.makeAmbiguous();
    if (change === "missing-original") source.revision = "999";
    if (change === "forged-evidence")
      source.evidence[0]!.text = "Fabricated final decision";
    if (change === "audience") source.audience.personIds.push("guest");
    await expect(f.source.requireCurrent(source)).rejects.toThrow();
  });
  it("preserves advisory poll facts separately, permits result evolution, and rejects changed choices", async () => {
    const f = fixture();
    const message = f.current.snapshot.messages[0]!;
    if (message.state !== "available") throw new Error("fixture");
    message.author = { providerUserId: "luma", displayName: "Luma" };
    message.text = "Luma-generated advisory wording";
    message.poll = {
      question: "RevenueCat or Stripe?",
      options: [
        { id: "1", text: "RevenueCat", emoji: null },
        { id: "2", text: "Stripe", emoji: null }
      ],
      allowsMultiple: false,
      wordingOrigin: "luma-generated",
      closesAt: "2026-09-12T10:00:00.000Z",
      results: { status: "unknown", reason: "missing" }
    };
    const source = await f.source.capture(f.request);
    expect(source.evidence[0]).toMatchObject({
      origin: "provider-derived",
      authorPersonId: null
    });
    expect(source.evidence[1]).toMatchObject({ origin: "poll", authorPersonId: null });
    message.poll.results = {
      status: "finalized",
      counts: [
        { optionId: "1", votes: 1 },
        { optionId: "2", votes: 3 }
      ]
    };
    message.poll.closesAt = null;
    await expect(f.source.requireCurrent(source)).resolves.toBeUndefined();
    expect(source.evidence[1]!.text).toContain('"status":"unknown"');
    message.poll.options[0]!.text = "Changed choice";
    await expect(f.source.requireCurrent(source)).rejects.toThrow();
  });
});
