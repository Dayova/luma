import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createNotionReadOnlyKnowledgeCatalogForTest } from "../../src/knowledge/notion-read-only-knowledge-catalog.js";
import {
  createNotionDecisionAuthority,
  decisionAuthorityContentHash,
  type NotionDecisionAuthorityPolicy
} from "../../src/decision-intelligence/notion-decision-authority.js";

const pageId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
const audience = { workspaceId: "dayova", personIds: ["jakob", "fabius"] };
let database: LumaDatabase, folder: string;
beforeEach(async () => {
  database = await createPgliteDatabase();
  folder = await mkdtemp(join(tmpdir(), "luma-authority-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
  await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  let markdown =
      "Jakob owns Luma, including technical work.\nFabius is provisionally CTO. Responsibilities remain provisional until a Human decision.",
    granted = true,
    deleted = false;
  const policy: NotionDecisionAuthorityPolicy = {
    schemaVersion: 1,
    workspaceId: "dayova",
    documentId: pageId,
    contentHash: decisionAuthorityContentHash(markdown),
    grants: [
      {
        id: "luma-owner",
        personId: "jakob",
        scopeId: "luma",
        kind: "project-ownership",
        standing: "current",
        excerpt: "Jakob owns Luma, including technical work.",
        delegatedBy: null,
        consultedPersonIds: []
      },
      {
        id: "provisional-cto",
        personId: "fabius",
        scopeId: "technology",
        kind: "provisional-role",
        standing: "provisional",
        excerpt: "Fabius is provisionally CTO.",
        delegatedBy: null,
        consultedPersonIds: []
      }
    ]
  };
  const policyPath = join(folder, "authority.json");
  const save = () => writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  await save();
  const knowledge = createNotionReadOnlyKnowledgeCatalogForTest(
    {
      workspaceId: "dayova",
      credentialScopeId: "responsibility",
      pageIds: [pageId],
      readOnlyApiToken: "test-only-read-token",
      authorize: () => Promise.resolve(granted)
    },
    {
      retrievePage: () =>
        Promise.resolve({
          object: "page",
          id: pageId,
          url: `https://notion.so/${pageId}`,
          archived: deleted,
          in_trash: deleted,
          last_edited_time: "2026-09-11T10:00:00Z",
          properties: {
            title: { type: "title", title: [{ plain_text: "Responsibility" }] }
          }
        }),
      retrieveMarkdown: () =>
        Promise.resolve({
          object: "page_markdown",
          id: pageId,
          markdown,
          truncated: false,
          unknown_block_ids: []
        })
    }
  );
  const make = (path = policyPath) =>
    createNotionDecisionAuthority({
      database,
      workspaceId: "dayova",
      policyPath: path,
      knowledge,
      recipientPersonIds: audience.personIds
    });
  return {
    make,
    policy,
    policyPath,
    save,
    changeText: (text: string) => {
      markdown = text;
    },
    text: () => markdown,
    revoke: () => {
      granted = false;
    },
    remove: () => {
      deleted = true;
    }
  };
}
describe("Governed source-backed Decision authority", () => {
  it("withholds authority if source permission changes while the original snapshot is retained", async () => {
    const f = await fixture();
    const query = database.query.bind(database);
    vi.spyOn(database, "query").mockImplementation(async (sql, params, options) => {
      const result = await query(sql, params, options);
      if (sql.startsWith("INSERT INTO decision_authority_snapshots")) f.revoke();
      return result;
    });
    await expect(f.make().read({ audience })).rejects.toThrow("could not be verified");
  });
  it("captures exact ownership proof while keeping provisional titles provisional", async () => {
    const f = await fixture();
    const snapshot = await f.make().read({ audience });
    expect(snapshot.grants[0]).toMatchObject({
      personId: "jakob",
      kind: "project-ownership",
      standing: "current",
      evidence: [{ sourceObjectId: pageId, excerpt: f.policy.grants[0]!.excerpt }]
    });
    expect(snapshot.grants[1]).toMatchObject({
      personId: "fabius",
      kind: "provisional-role",
      standing: "provisional"
    });
    expect(snapshot.contentHash).toBe(f.policy.contentHash);
    await f.make().requireCurrent({ audience, snapshot });
    expect(await f.make().authorizeRetainedAuthority({ audience, snapshot })).toBe(true);
  });
  it("invalidates execution freshness when wording changes but retains accessible original authority history", async () => {
    const f = await fixture(),
      snapshot = await f.make().read({ audience });
    f.changeText("Later Human responsibilities were agreed.");
    await expect(f.make().requireCurrent({ audience, snapshot })).rejects.toThrow();
    expect(await f.make().authorizeRetainedAuthority({ audience, snapshot })).toBe(true);
  });
  it.each(["revoke", "remove"] as const)(
    "withholds retained authority after %s",
    async (change) => {
      const f = await fixture(),
        snapshot = await f.make().read({ audience });
      f[change]();
      expect(await f.make().authorizeRetainedAuthority({ audience, snapshot })).toBe(
        false
      );
      await expect(f.make().read({ audience })).rejects.toThrow();
    }
  );
  it("does not accept a forged snapshot or expand an original reader grant", async () => {
    const f = await fixture(),
      snapshot = await f.make().read({ audience: { ...audience, personIds: ["jakob"] } });
    const forged = structuredClone(snapshot);
    forged.grants[0]!.personId = "fabius";
    expect(
      await f.make().authorizeRetainedAuthority({ audience, snapshot: forged })
    ).toBe(false);
    expect(await f.make().authorizeRetainedAuthority({ audience, snapshot })).toBe(false);
    expect(
      await f.make().authorizeRetainedAuthority({
        audience: { ...audience, personIds: ["jakob"] },
        snapshot
      })
    ).toBe(true);
  });
  it("requires a new current authority snapshot after an explicit protected mapping revision", async () => {
    const f = await fixture(),
      snapshot = await f.make().read({ audience });
    f.policy.grants[0]!.standing = "superseded";
    await f.save();
    await expect(f.make().requireCurrent({ audience, snapshot })).rejects.toThrow();
    const current = await f.make().read({ audience });
    expect(current.revision).not.toBe(snapshot.revision);
    expect(await f.make().authorizeRetainedAuthority({ audience, snapshot })).toBe(true);
  });
  it.each(["hash", "excerpt", "duplicate-excerpt", "guest"] as const)(
    "refuses %s mismatch before retaining an authority snapshot",
    async (kind) => {
      const f = await fixture();
      if (kind === "hash") f.policy.contentHash = "0".repeat(64);
      if (kind === "excerpt") f.policy.grants[0]!.excerpt = "Invented owner";
      if (kind === "guest") f.policy.grants[0]!.personId = "guest";
      if (kind === "duplicate-excerpt") {
        f.changeText(`${f.text()}\n${f.policy.grants[0]!.excerpt}`);
        f.policy.contentHash = decisionAuthorityContentHash(f.text());
      }
      await f.save();
      await expect(f.make().read({ audience })).rejects.toThrow();
      expect(
        (await database.query(`SELECT snapshot_hash FROM decision_authority_snapshots`))
          .rows
      ).toHaveLength(0);
    }
  );
  it("requires an owner-readable protected regular file and never follows a policy symlink", async () => {
    const f = await fixture();
    await chmod(f.policyPath, 0o644);
    await expect(f.make().read({ audience })).rejects.toThrow();
    await chmod(f.policyPath, 0o600);
    const link = join(folder, "link.json");
    await symlink(f.policyPath, link);
    await expect(f.make(link).read({ audience })).rejects.toThrow();
  });
});
