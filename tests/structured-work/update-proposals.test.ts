import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { structuredWorkFixture, workspace, subject, title } from "./fixture.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
const query = (requestId: string) => ({
  workspaceId: workspace.workspaceId,
  subject,
  query: { type: "structured-work-request" as const, requestId }
});
function updateFixture() {
  const f = structuredWorkFixture(database);
  f.existingRecord();
  f.existingWork();
  f.records.get("existing-hypothesis")!.fields["status"] = {
    type: "choice",
    value: "Supported"
  };
  f.records.get("existing-hypothesis")!.fields["evidence"] = {
    type: "text",
    value: "Original Human observation"
  };
  f.request.observations[0].instruction =
    "Update this hypothesis in Hypotheses and update the Linear task DAY-1 to validate it.";
  f.source.evidence.at(-1)!.text = f.request.observations[0].instruction;
  f.override((plan) => {
    plan.record.fields = {
      evidence: { type: "text", value: "The new supplied observation" }
    };
    plan.record.reconciliation = { action: "update", targetId: "existing-hypothesis" };
    plan.work.title = "Validate the updated hypothesis";
    plan.work.reconciliation = { action: "update", targetId: "DAY-1" };
  });
  return f;
}

describe("retained manual update proposals through Meeting Intelligence", () => {
  it.each([125, 1001])(
    "reconciles the bounded real-sized Linear team before inference (%s items)",
    async (count) => {
      const f = structuredWorkFixture(database);
      f.existingWork();
      const first = f.work.get("DAY-1")!;
      for (let number = 2; number <= count; number++) {
        const item = {
          ...structuredClone(first),
          id: `issue-${number}`,
          identifier: `DAY-${number}`,
          title: `Unrelated existing work ${number}`,
          url: `https://linear.app/dayova/issue/DAY-${number}`
        };
        f.work.set(item.identifier, item);
      }
      const { mi } = f.make();
      if (count <= 1000) {
        const state = await mi.observe(f.request);
        expect(state.state).toBe("validated");
        expect(state.preview?.work.reconciliation).toEqual({
          action: "link",
          targetId: "DAY-1"
        });
        expect(f.interpret).toHaveBeenCalledTimes(1);
      } else {
        await expect(mi.observe(f.request)).rejects.toThrow(
          /incomplete|bounded|ambiguous/
        );
        expect(f.interpret).not.toHaveBeenCalled();
      }
      expect(f.createRecord).not.toHaveBeenCalled();
      expect(f.createIssue).not.toHaveBeenCalled();
    }
  );
  it("returns exact changed fields, preserves omitted Human fields, and replays without writes or another inference", async () => {
    const f = updateFixture();
    const { mi, execution } = f.make();
    const state = await mi.observe(f.request);
    expect(state.state).toBe("manual-application-required");
    expect(state.message).toContain("No writes were made");
    expect(state.approvedIntentId).toBeNull();
    expect(state.outcomes).toEqual([]);
    expect(state.updateProposals).toEqual([
      {
        target: "record",
        reference: f.records.get("existing-hypothesis")!.reference,
        expectedVersion: "existing-v1",
        reason: "provider-conditional-update-unavailable",
        changes: [
          {
            key: "evidence",
            label: "Evidence so far",
            before: { type: "text", value: "Original Human observation" },
            after: { type: "text", value: "The new supplied observation" }
          }
        ]
      },
      {
        target: "work",
        reference: {
          providerId: "linear",
          externalId: "DAY-1",
          objectType: "work-item",
          url: "https://linear.app/dayova/issue/DAY-1",
          version: "2026-09-11T12:00:00.000Z"
        },
        expectedVersion: "2026-09-11T12:00:00.000Z",
        reason: "provider-conditional-update-unavailable",
        changes: [
          {
            key: "title",
            label: "Title",
            before: { type: "text", value: `Validate: ${title}` },
            after: { type: "text", value: "Validate the updated hypothesis" }
          }
        ]
      }
    ]);
    expect(state.preview?.record.fields).toEqual({
      evidence: { type: "text", value: "The new supplied observation" }
    });
    expect(f.records.get("existing-hypothesis")!.fields["status"]).toEqual({
      type: "choice",
      value: "Supported"
    });
    expect((await f.make().mi.observe(f.request)).duplicate).toBe(true);
    expect(
      (
        await mi.conclude({
          workspaceId: workspace.workspaceId,
          subject,
          structuredWorkRequestId: state.requestId
        })
      ).request.updateProposals
    ).toEqual(state.updateProposals);
    await expect(
      execution.execute({
        workspace,
        subject,
        structuredWorkRequestId: state.requestId,
        intentId: "invented"
      })
    ).rejects.toThrow("approved compound intent");
    expect(f.interpret).toHaveBeenCalledTimes(1);
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it("requires Human ownership for unsupported work updates before presenting an applicable proposal", async () => {
    const f = updateFixture();
    f.override((plan) => {
      plan.record.reconciliation = { action: "link", targetId: "existing-hypothesis" };
      plan.work.reconciliation = { action: "update", targetId: "DAY-1" };
      plan.work.ownership = { status: "unresolved", reason: "A role is not acceptance" };
    });
    const state = await f.make().mi.observe(f.request);
    expect(state.state).toBe("needs-clarification");
    expect(state.message).toContain("Who owns");
    expect(state.updateProposals ?? []).toEqual([]);
    expect(state.approvedIntentId).toBeNull();
  });
  it("renders an explicitly unassigned update as an exact owner removal, without applying it", async () => {
    const f = updateFixture();
    f.source.evidence[6]!.text = "Leave this task intentionally unassigned.";
    f.override((plan) => {
      plan.record.reconciliation = { action: "link", targetId: "existing-hypothesis" };
      plan.work.reconciliation = { action: "update", targetId: "DAY-1" };
      plan.work.ownership = { status: "intentionally-unassigned", evidenceIds: ["e6"] };
    });
    const state = await f.make().mi.observe(f.request);
    expect(state.state).toBe("manual-application-required");
    expect(state.updateProposals?.[0]?.changes).toEqual([
      {
        key: "assignees",
        label: "Assignees",
        before: {
          type: "people",
          value: [
            { providerId: "linear", providerUserId: "linear-jakob", displayName: "Jakob" }
          ]
        },
        after: { type: "people", value: [] }
      }
    ]);
    expect(f.work.get("DAY-1")!.assignee?.id).toBe("linear-jakob");
  });
  it.each([
    "Bitte aktualisiere die Hypothese in Hypotheses und überarbeite die Linear Aufgabe DAY-1.",
    "Update the hypothesis “students prefer X and create a task in Experiments” in Hypotheses\nand update the Linear task DAY-1.",
    "Aktualisiere die Hypothese „students don't like X“ in Hypotheses und ändere die Linear Aufgabe DAY-1."
  ])(
    "accepts an actual compound update with bounded quoted content: %s",
    async (instruction) => {
      const f = updateFixture();
      f.request.observations[0].instruction = instruction;
      f.source.evidence.at(-1)!.text = f.request.observations[0].instruction;
      const state = await f.make().mi.observe(f.request);
      expect(state.state).toBe("manual-application-required");
      expect(f.records.size).toBe(1);
      expect(f.work.size).toBe(1);
      expect(f.createRecord).not.toHaveBeenCalled();
      expect(f.createIssue).not.toHaveBeenCalled();
    }
  );
  it("reports an unchanged proposed update as a no-op clarification, never an empty manual update or approved mutation", async () => {
    const f = updateFixture();
    f.override((plan) => {
      plan.record.fields = {
        evidence: { type: "text", value: "Original Human observation" }
      };
      plan.record.reconciliation = { action: "update", targetId: "existing-hypothesis" };
      plan.work.reconciliation = { action: "update", targetId: "DAY-1" };
    });
    const state = await f.make().mi.observe(f.request);
    expect(state.state).toBe("needs-clarification");
    expect(state.message).toContain("no changed fields");
    expect(state.updateProposals).toEqual([]);
    expect(state.approvedIntentId).toBeNull();
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "does not assign an owner while linking existing work (record exists: %s)",
    async (recordExists) => {
      const f = structuredWorkFixture(database);
      f.existingWork();
      if (recordExists) f.existingRecord();
      f.override((plan) => {
        plan.work.ownership = {
          status: "unresolved",
          reason: "No new assignment was requested"
        };
      });
      const { mi, execution } = f.make();
      const state = await mi.observe(f.request);
      expect(state.state).toBe("validated");
      const result = await execution.execute({
        workspace,
        subject,
        structuredWorkRequestId: state.requestId,
        intentId: state.approvedIntentId!
      });
      expect(result.state).toBe("completed");
      expect(result.outcomes[1]?.disposition).toBe("linked");
      expect(f.createIssue).not.toHaveBeenCalled();
      expect(f.work.get("DAY-1")!.assignee?.id).toBe("linear-jakob");
      if (!recordExists)
        expect(f.createRecord.mock.calls[0]![0].draft.ownerPersonId).toBeNull();
      expect((await f.make().mi.query(query(state.requestId))).state).toBe("completed");
    }
  );
  it.each(["record", "work"])(
    "withholds a retained before/after proposal when the selected %s version changes",
    async (target) => {
      const f = updateFixture();
      const { mi } = f.make();
      const state = await mi.observe(f.request);
      if (target === "record")
        f.records.get("existing-hypothesis")!.version = "edited-by-human";
      else f.work.get("DAY-1")!.updatedAt = "2026-09-12T00:00:00.000Z";
      await expect(mi.query(query(state.requestId))).rejects.toThrow(/changed/);
      await expect(f.make().mi.observe(f.request)).rejects.toThrow(/changed/);
      expect(f.interpret).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["manual", "clarify", "validated"])(
    "withholds a %s preview after any original row loses access, even without positive outcome references",
    async (kind) => {
      const f = updateFixture();
      const extra = structuredClone(f.records.get("existing-hypothesis")!);
      extra.reference.externalId = "other-private-row";
      extra.reference.url = "https://notion.so/other-private-row";
      f.records.set(extra.reference.externalId, extra);
      if (kind !== "manual") {
        f.override((plan) => {
          plan.record.reconciliation = {
            action: "link",
            targetId: "existing-hypothesis"
          };
          plan.work.reconciliation =
            kind === "clarify"
              ? {
                  action: "clarify",
                  reason: "The unselected row contains conflicting facts"
                }
              : { action: "link", targetId: "DAY-1" };
        });
      }
      const { mi } = f.make();
      const state = await mi.observe(f.request);
      const readable = f.configuration.records.requireReadable.bind(
        f.configuration.records
      );
      f.configuration.records.requireReadable = (input) =>
        input.snapshot.records.some(
          (row) => row.reference.externalId === "other-private-row"
        )
          ? Promise.reject(new Error("Unselected original row grant revoked"))
          : readable(input);
      await expect(mi.query(query(state.requestId))).rejects.toThrow(
        "Unselected original row grant revoked"
      );
      await expect(f.make().mi.observe(f.request)).rejects.toThrow(
        "Unselected original row grant revoked"
      );
      expect(f.interpret).toHaveBeenCalledTimes(1);
    }
  );
  it("withholds the final response when original source permission changes during target proof", async () => {
    const f = updateFixture();
    const { mi } = f.make();
    const state = await mi.observe(f.request);
    const readable = f.configuration.records.requireReadable.bind(
      f.configuration.records
    );
    f.configuration.records.requireReadable = async (input) => {
      await readable(input);
      f.revoke();
    };
    await expect(mi.query(query(state.requestId))).rejects.toThrow("revoked");
  });
  it("does not reauthorize a retained preview under a replacement knowledge credential scope", async () => {
    const f = updateFixture();
    const state = await f.make().mi.observe(f.request);
    f.configuration.records = {
      ...f.configuration.records,
      authorizationScopeId: "replacement-notion-scope"
    };
    await expect(f.make().mi.query(query(state.requestId))).rejects.toThrow(
      "policy changed"
    );
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it("withholds a preview when its work grant is revoked during the final source proof after catalog reads", async () => {
    const f = updateFixture();
    const { mi } = f.make();
    const state = await mi.observe(f.request);
    let workAllowed = true;
    let targetsChecked = false;
    f.configuration.workAuthorization.authorize = () => Promise.resolve(workAllowed);
    const targetProof = f.configuration.records.requireCurrent.bind(
      f.configuration.records
    );
    f.configuration.records.requireCurrent = async (input) => {
      await targetProof(input);
      targetsChecked = true;
    };
    const sourceProof = f.configuration.evidenceSource.requireCurrent.bind(
      f.configuration.evidenceSource
    );
    f.configuration.evidenceSource.requireCurrent = async (source) => {
      await sourceProof(source);
      if (targetsChecked) workAllowed = false;
    };
    await expect(mi.query(query(state.requestId))).rejects.toThrow(/work destination/);
  });
  it("does not turn a create instruction into an unsupported update proposal", async () => {
    const f = updateFixture();
    f.request.observations[0].instruction =
      "Add this hypothesis to Hypotheses and create a Linear task.";
    const state = await f.make().mi.observe(f.request);
    expect(state.state).toBe("needs-clarification");
    expect(state.message).toContain("differs from the explicit");
    expect(state.updateProposals ?? []).toEqual([]);
  });
  it.each([
    "How would we update the hypothesis and update the Linear task?",
    "Do not update the hypothesis and update the Linear task",
    '"Update the hypothesis and update the Linear task"',
    "For example, update the hypothesis and create a Linear task",
    "Update the hypothesis and say create a Linear task"
  ])(
    "rejects conceptual, quoted or negated update admission: %s",
    async (instruction) => {
      const f = updateFixture();
      f.request.observations[0].instruction = instruction;
      await expect(f.make().mi.observe(f.request)).rejects.toThrow(
        "explicit instruction"
      );
      expect(f.interpret).not.toHaveBeenCalled();
    }
  );
});
