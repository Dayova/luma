import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { decisionStandingGrantSchema } from "../../src/decision-intelligence/automatic-policy.js";
import { audience, founderId, standingFixture } from "./standing-permission-fixture.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
});

describe("durable native Human automatic recording permission", () => {
  it("starts off, retains an exact scoped original slash receipt, and survives recreation without duplicate consent", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    expect(await policy.read({ audience })).toEqual([]);
    const result = await policy.command(f.command());
    expect(result.state).toBe("active");
    expect(result.grant?.source.url).toBe(
      `https://discord.com/channels/${f.command().guildId}/${f.command().channelId}`
    );
    expect(result.grant?.source.objectType).toBe("other");
    expect(result.grant?.actions).toEqual(["create", "link"]);
    expect(result.grant?.authorizedBy).toBe("person_jakob");
    expect(decisionStandingGrantSchema.parse(result.grant)).toEqual(result.grant);
    await policy.stop();
    const recreated = await f.make();
    expect(await recreated.command(f.command())).toEqual(result);
    expect(await recreated.read({ audience })).toEqual([result.grant]);
    const rows = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM decision_standing_instructions"
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
  it("does not restore revoked permission on replay or late delivery of an older enable", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const old = (await policy.command(f.command(1))).grant!;
    await policy.command(f.command(5, { action: "disable" }));
    expect((await policy.command(f.command(1))).state).toBe("disabled");
    expect((await policy.command(f.command(3))).state).toBe("disabled");
    expect(await policy.read({ audience })).toEqual([]);
    await expect(policy.requireCurrent({ audience, grant: old })).rejects.toThrow(
      "revoked"
    );
    expect((await policy.command(f.command(6))).state).toBe("active");
    await expect(policy.requireCurrent({ audience, grant: old })).rejects.toThrow(
      "revoked"
    );
  });
  it("records a new class immutably and refuses changed options under an existing interaction", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const original = (await policy.command(f.command())).grant!;
    const next = f.command(2, {
      action: "enable",
      permissionClass: "decisions-and-corrections",
      sharing: "four-founders"
    });
    expect((await policy.command(next)).grant?.actions).toContain("reverse");
    await expect(policy.requireCurrent({ audience, grant: original })).rejects.toThrow();
    await expect(policy.command({ ...next, scopeId: "different" })).rejects.toThrow(
      "different permission options"
    );
    const rows = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM decision_standing_instructions"
    );
    expect(rows.rows[0]?.count).toBe(2);
  });
  it.each(["scope", "other-founder", "provisional", "ambiguous"])(
    "withholds enable without own proven scope: %s",
    async (mode) => {
      const f = standingFixture(database),
        policy = await f.make(),
        command = f.command();
      if (mode === "scope") command.scopeId = "technology";
      if (mode === "other-founder") command.actorDiscordUserId = "726409024894926869";
      if (mode === "provisional") {
        f.snapshot.grants[0]!.kind = "provisional-role";
        f.snapshot.grants[0]!.standing = "provisional";
      }
      if (mode === "ambiguous")
        f.snapshot.grants.push({
          ...f.snapshot.grants[0]!,
          id: "other",
          personId: "person_fabius"
        });
      await expect(policy.command(command)).rejects.toThrow("accountable owner");
      expect(await policy.read({ audience })).toEqual([]);
    }
  );
  it("supports a proven delegation and harmless authority revisions while withholding a changed accountable owner", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const first = await policy.command(f.command());
    f.snapshot.revision = "ownership-v2";
    f.snapshot.contentHash = "new verified original";
    await expect(
      policy.requireCurrent({ audience, grant: first.grant! })
    ).resolves.toBeUndefined();
    f.snapshot.grants.push({
      ...f.snapshot.grants[0]!,
      id: "delegated",
      kind: "delegation",
      personId: "person_fabius",
      delegatedBy: "person_jakob"
    });
    await expect(
      policy.requireCurrent({ audience, grant: first.grant! })
    ).rejects.toThrow("accountable owner");
    const delegated = await policy.command({
      ...f.command(2),
      actorDiscordUserId: "726409024894926869"
    });
    expect(delegated.state).toBe("active");
    expect((await policy.read({ audience })).map((grant) => grant.authorizedBy)).toEqual([
      "person_fabius"
    ]);
  });
  it.each([
    "identity",
    "channel",
    "ownership",
    "missing-founder",
    "guest-admin",
    "moved-thread"
  ])(
    "rechecks current founder identity, original audience and ownership: %s",
    async (mode) => {
      const f = standingFixture(database),
        policy = await f.make();
      const grant = (await policy.command(f.command())).grant!;
      if (mode === "identity") f.revokeIdentity();
      if (mode === "channel") f.revokeChannel();
      if (mode === "ownership") f.revokeAuthority();
      if (mode === "missing-founder") f.missingReader("726409024894926869");
      if (mode === "guest-admin") f.addGuest();
      if (mode === "moved-thread") f.moveThread();
      await expect(policy.requireCurrent({ audience, grant })).rejects.toThrow();
      await expect(policy.read({ audience }).catch(() => [])).resolves.toEqual([]);
    }
  );
  it("lets the original founder disable after losing scope ownership without granting another founder control", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const grant = (await policy.command(f.command())).grant!;
    f.revokeAuthority();
    expect((await policy.command(f.command(2, { action: "status" }))).state).toBe(
      "unavailable"
    );
    const other = await policy.command({
      ...f.command(3, { action: "disable" }),
      actorDiscordUserId: "726409024894926869"
    });
    expect(other.personId).toBe("person_fabius");
    expect((await policy.command(f.command(4, { action: "status" }))).grant?.id).toBe(
      grant.id
    );
    expect((await policy.command(f.command(5, { action: "disable" }))).state).toBe(
      "disabled"
    );
  });
  it("fences revocation during the final async authority proof", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const grant = (await policy.command(f.command())).grant!;
    f.duringAuthority(async () => {
      await policy.command(f.command(2, { action: "disable" }));
    });
    await expect(policy.requireCurrent({ audience, grant })).rejects.toThrow("revoked");
    expect(await policy.read({ audience })).toEqual([]);
  });
  it("does not activate a partially persisted permission and retries the same original command safely", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    await database.exec(
      `CREATE FUNCTION reject_standing_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fault'; END $$; CREATE TRIGGER reject_standing_head BEFORE INSERT ON decision_standing_heads FOR EACH ROW EXECUTE FUNCTION reject_standing_head();`
    );
    await expect(policy.command(f.command())).rejects.toThrow("fault");
    expect(await policy.read({ audience })).toEqual([]);
    const rows = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM decision_standing_instructions"
    );
    expect(rows.rows[0]?.count).toBe(0);
    await database.exec("DROP TRIGGER reject_standing_head ON decision_standing_heads");
    expect((await policy.command(f.command())).state).toBe("active");
  });
  it("refuses forged original evidence, changed recipients and mismatched identity bindings", async () => {
    const f = standingFixture(database),
      policy = await f.make(),
      grant = (await policy.command(f.command())).grant!;
    await expect(
      policy.requireCurrent({
        audience: { ...audience, personIds: ["person_jakob"] },
        grant
      })
    ).rejects.toThrow("audience");
    await expect(
      policy.requireCurrent({
        audience,
        grant: {
          ...grant,
          actor: { ...grant.actor, providerUserId: "726409024894926869" }
        }
      })
    ).rejects.toThrow();
    await database.query("UPDATE decision_standing_instructions SET payload_hash=$1", [
      decisionDigest("forged")
    ]);
    await expect(policy.read({ audience })).rejects.toThrow("integrity");
  });
  it("drains an admitted permission and rejects new admission during stop", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      admitted = new Promise<void>((resolve) => {
        entered = resolve;
      });
    f.duringAuthority(async () => {
      entered();
      await gate;
    });
    const active = policy.command(f.command());
    await admitted;
    let stopped = false;
    const stop = policy.stop().then(() => {
      stopped = true;
    });
    await expect(policy.read({ audience })).rejects.toThrow("stopped");
    expect(stopped).toBe(false);
    release();
    expect((await active).state).toBe("active");
    await stop;
    expect(stopped).toBe(true);
  });
  it("withholds a command whose actor mapping changes during the live source proof", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    f.duringSource(() => {
      f.revokeIdentity();
      return Promise.resolve();
    });
    await expect(
      policy.command({ ...f.command(), actorDiscordUserId: founderId })
    ).rejects.toThrow();
    expect(await policy.read({ audience })).toEqual([]);
  });
  it("bounds active permission discovery and shares fresh original-channel proofs within each complete pass", async () => {
    const f = standingFixture(database),
      policy = await f.make();
    const original = structuredClone(f.snapshot.grants[0]!);
    f.snapshot.grants = Array.from({ length: 21 }, (_, index) => ({
      ...original,
      id: `owner-${index}`,
      scopeId: `scope-${index}`
    }));
    for (let index = 0; index < 20; index++)
      await policy.command({ ...f.command(index + 1), scopeId: `scope-${index}` });
    await expect(
      policy.command({ ...f.command(21), scopeId: "scope-20" })
    ).rejects.toThrow("At most 20");
    f.read.mockClear();
    expect(await policy.read({ audience })).toHaveLength(20);
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(24);
    await policy.command({ ...f.command(30, { action: "disable" }), scopeId: "scope-0" });
    expect((await policy.command({ ...f.command(31), scopeId: "scope-20" })).state).toBe(
      "active"
    );
  });
});
