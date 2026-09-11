import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { structuredWorkFixture, workspace, subject } from "./fixture.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
});
describe("MI-owned compound structured knowledge and actual Linear work", () => {
  it("retains a grounded candidate preview when reconciliation needs an explicit clarification", async () => {
    const f = structuredWorkFixture(database);
    f.override((plan) => {
      plan.work.reconciliation = {
        action: "clarify",
        reason:
          "The existing task is completed; confirm whether further validation is intended."
      };
    });
    const state = await f.make().mi.observe(f.request);
    expect(state.state).toBe("needs-clarification");
    expect(state.preview?.record.fields).toHaveProperty("hypothesis");
    expect(state.preview?.work.reconciliation).toMatchObject({ action: "clarify" });
    expect(state.approvedIntentId).toBeNull();
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "uses an actual conditional-update capability and recovers its exact result without a repeat (lost ack: %s)",
    async (lost) => {
      const f = structuredWorkFixture(database);
      f.existingWork();
      f.override((plan) => {
        plan.work.reconciliation = { action: "update", targetId: "DAY-1" };
      });
      const update = vi.fn<
        NonNullable<typeof f.configuration.work.updateWorkItemIfCurrent>
      >((_id, input) => {
        const item = [...f.work.values()][0]!;
        if (item.updatedAt !== input.expectedUpdatedAt) return Promise.resolve(null);
        item.title = input.title!;
        item.description = input.description!;
        item.updatedAt = "2026-09-11T13:00:00.000Z";
        const ref = {
          providerId: "linear",
          objectType: "work-item" as const,
          externalId: item.identifier,
          url: item.url,
          version: item.updatedAt
        };
        return lost
          ? Promise.reject(new Error("Lost conditional update ack"))
          : Promise.resolve(ref);
      });
      f.configuration.work.updateWorkItemIfCurrent = update;
      const { mi, execution } = f.make();
      const plan = await mi.observe(f.request);
      expect(plan.state).toBe("validated");
      const command = {
        workspace,
        subject,
        structuredWorkRequestId: plan.requestId,
        intentId: plan.approvedIntentId!
      };
      expect((await execution.execute(command)).state).toBe(
        lost ? "partially-executed" : "completed"
      );
      if (lost) expect((await execution.recover(command)).state).toBe("completed");
      expect(update).toHaveBeenCalledTimes(1);
      expect(f.createIssue).not.toHaveBeenCalled();
    }
  );
  it("requires current work sharing for model disclosure, execution and final response", async () => {
    const f = structuredWorkFixture(database);
    f.configuration.workAuthorization.authorize = () => Promise.resolve(false);
    await expect(f.make().mi.observe(f.request)).rejects.toThrow("work target");
    expect(f.interpret).not.toHaveBeenCalled();
    f.configuration.workAuthorization.authorize = () => Promise.resolve(true);
    const { mi, execution } = f.make();
    const result = await mi.observe(f.request);
    f.configuration.workAuthorization.authorize = () => Promise.resolve(false);
    await expect(
      execution.execute({
        workspace,
        subject,
        structuredWorkRequestId: result.requestId,
        intentId: result.approvedIntentId!
      })
    ).rejects.toThrow("work destination");
    await expect(
      mi.query({
        workspaceId: workspace.workspaceId,
        subject,
        query: { type: "structured-work-request", requestId: result.requestId }
      })
    ).rejects.toThrow("work destination");
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it("preserves the configured pre-validation state instead of inventing a result", async () => {
    const f = structuredWorkFixture(database);
    f.override((plan) => {
      plan.record.fields["status"] = { type: "choice", value: "Supported" };
    });
    const result = await f.make().mi.observe(f.request);
    expect(result.state).toBe("needs-clarification");
    expect(result.message).toContain("initial state");
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it.each([
    "How would we add a hypothesis and create a task?",
    "Do not add this hypothesis and create a task",
    '"Add this hypothesis and create a task"'
  ])("keeps non-Execute instruction read-only: %s", async (instruction) => {
    const f = structuredWorkFixture(database);
    f.request.observations[0].instruction = instruction;
    await expect(f.make().mi.observe(f.request)).rejects.toThrow("explicit instruction");
    expect(f.interpret).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
    expect(f.createRecord).not.toHaveBeenCalled();
  });
  it("includes completed work in reconciliation and refuses an inferred replacement duplicate", async () => {
    const f = structuredWorkFixture(database);
    f.existingWork();
    [...f.work.values()][0]!.stateType = "completed";
    f.override((plan) => {
      plan.work.reconciliation = { action: "create" };
    });
    const result = await f.make().mi.observe(f.request);
    expect(result.state).toBe("needs-clarification");
    expect(result.message).toContain("historical work");
    expect(f.createIssue).not.toHaveBeenCalled();
    expect(f.createRecord).not.toHaveBeenCalled();
  });
  it("reads an explicitly selected work identity outside discovery instead of creating an unseen duplicate", async () => {
    const f = structuredWorkFixture(database);
    f.existingWork();
    f.configuration.work.discoverWorkItems = () =>
      Promise.resolve({ items: [], complete: true });
    f.request.observations[0].workItemId = "DAY-1";
    const { mi, execution } = f.make();
    const result = await mi.observe(f.request);
    expect(result.state).toBe("validated");
    expect(
      (
        await execution.execute({
          workspace,
          subject,
          structuredWorkRequestId: result.requestId,
          intentId: result.approvedIntentId!
        })
      ).outcomes[1]?.disposition
    ).toBe("linked");
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it("does not dispatch if durable stage admission is refused", async () => {
    const f = structuredWorkFixture(database);
    const { mi, execution } = f.make();
    const result = await mi.observe(f.request);
    await database.exec(
      'ALTER TABLE structured_work_requests ADD CONSTRAINT reject_inflight CHECK (payload_json NOT LIKE \'%"state":"executing"%\')'
    );
    await execution.execute({
      workspace,
      subject,
      structuredWorkRequestId: result.requestId,
      intentId: result.approvedIntentId!
    });
    expect(f.createRecord).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it("retains a known Notion reference when local success settlement fails and never repeats it", async () => {
    const f = structuredWorkFixture(database);
    const { mi, execution } = f.make();
    const result = await mi.observe(f.request);
    const command = {
      workspace,
      subject,
      structuredWorkRequestId: result.requestId,
      intentId: result.approvedIntentId!
    };
    await database.exec(
      'ALTER TABLE structured_work_requests ADD CONSTRAINT reject_success CHECK (payload_json NOT LIKE \'%"state":"succeeded"%\')'
    );
    const uncertain = await execution.execute(command);
    expect(uncertain.outcomes[0]?.disposition).toBe("unknown");
    expect(uncertain.outcomes[0]?.reference?.url).toContain("notion.so");
    expect(f.createRecord).toHaveBeenCalledTimes(1);
    expect(f.createIssue).not.toHaveBeenCalled();
    await execution.execute(command);
    expect(f.createRecord).toHaveBeenCalledTimes(1);
    await database.exec(
      "ALTER TABLE structured_work_requests DROP CONSTRAINT reject_success"
    );
    expect((await execution.recover(command)).outcomes[0]?.disposition).toBe("created");
    expect((await execution.execute(command)).state).toBe("completed");
    expect(f.createRecord).toHaveBeenCalledTimes(1);
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    "reconciles existing record %s and work %s independently, retaining shared source and bindings",
    async (recordExists, workExists) => {
      const f = structuredWorkFixture(database);
      if (recordExists) f.existingRecord();
      if (workExists) f.existingWork();
      const { mi, execution } = f.make();
      const planned = await mi.observe(f.request);
      expect(planned.state).toBe("validated");
      expect(planned.source.evidence[4]?.text).toBe(
        "So should I validate the hypothesis now?"
      );
      const command = {
        workspace,
        subject,
        structuredWorkRequestId: planned.requestId,
        intentId: planned.approvedIntentId!
      };
      const result = await execution.execute(command);
      expect(result.state).toBe("completed");
      expect(result.outcomes.map((outcome) => outcome.disposition)).toEqual([
        recordExists ? "linked" : "created",
        workExists ? "linked" : "created"
      ]);
      expect(f.records.size).toBe(1);
      expect(f.work.size).toBe(1);
      expect(f.createRecord).toHaveBeenCalledTimes(recordExists ? 0 : 1);
      expect(f.createIssue).toHaveBeenCalledTimes(workExists ? 0 : 1);
      const recreated = f.make();
      expect((await recreated.mi.observe(f.request)).duplicate).toBe(true);
      expect((await recreated.execution.execute(command)).state).toBe("completed");
      expect(f.interpret).toHaveBeenCalledTimes(1);
      const conclusion = await recreated.mi.conclude({
        workspaceId: workspace.workspaceId,
        subject,
        structuredWorkRequestId: planned.requestId
      });
      expect(conclusion.request.outcomes).toHaveLength(2);
      if (!workExists) {
        expect([...f.work.values()][0]?.description).toContain(
          result.outcomes[0]!.reference!.url
        );
        expect([...f.work.values()][0]?.description).toContain(
          "So should I validate the hypothesis now?"
        );
        expect([...f.work.values()][0]?.assignee?.id).toBe("linear-jakob");
      }
      expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(0);
    }
  );
  it.each(["record-first", "work-first"] as const)(
    "keeps %s success durable when the second acknowledgement is lost, and recovers without either duplicate",
    async (order) => {
      const f = structuredWorkFixture(database);
      f.configuration.order = order;
      if (order === "record-first") f.loseWork();
      else f.loseRecord();
      const { mi, execution } = f.make();
      const planned = await mi.observe(f.request);
      const command = {
        workspace,
        subject,
        structuredWorkRequestId: planned.requestId,
        intentId: planned.approvedIntentId!
      };
      expect((await execution.execute(command)).state).toBe("partially-executed");
      const restart = f.make();
      expect((await restart.execution.execute(command)).state).toBe("partially-executed");
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.createRecord).toHaveBeenCalledTimes(1);
      expect((await restart.execution.recover(command)).state).toBe("completed");
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.createRecord).toHaveBeenCalledTimes(1);
      expect(f.interpret).toHaveBeenCalledTimes(1);
    }
  );
  it("never treats an absent recovery result as permission to repeat an uncertain Linear write", async () => {
    const f = structuredWorkFixture(database);
    f.loseWork();
    const { mi, execution } = f.make();
    const plan = await mi.observe(f.request);
    const command = {
      workspace,
      subject,
      structuredWorkRequestId: plan.requestId,
      intentId: plan.approvedIntentId!
    };
    await execution.execute(command);
    f.hideProbe();
    expect((await execution.recover(command)).outcomes[1]?.disposition).toBe("unknown");
    await execution.execute(command);
    expect(f.createIssue).toHaveBeenCalledTimes(1);
    expect(f.createRecord).toHaveBeenCalledTimes(1);
  });
  it.each(["wording", "owner", "mention", "poll", "target", "schema", "update"])(
    "clarifies %s before either provider can mutate",
    async (kind) => {
      const f = structuredWorkFixture(database);
      f.override((plan) => {
        if (kind === "wording")
          plan.record.reconciliation = { action: "clarify", reason: "Which hypothesis?" };
        if (kind === "owner")
          plan.work.ownership = { status: "unresolved", reason: "No owner" };
        if (kind === "mention")
          plan.work.ownership = {
            status: "confirmed",
            personId: "fabius",
            evidenceIds: ["e0"]
          };
        if (kind === "poll") {
          f.source.evidence[4]!.origin = "poll";
        }
        if (kind === "target") plan.targetKey = "other";
        if (kind === "schema")
          plan.record.fields["invented"] = { type: "text", value: "invented field" };
        if (kind === "update") {
          f.existingRecord();
          plan.record.reconciliation = {
            action: "update",
            targetId: "existing-hypothesis"
          };
        }
      });
      if (kind === "poll") f.source.evidence[4]!.origin = "poll";
      const state = await f.make().mi.observe(f.request);
      expect(state.state).toBe("needs-clarification");
      expect(state.approvedIntentId).toBeNull();
      expect(f.createIssue).not.toHaveBeenCalled();
      expect(f.createRecord).not.toHaveBeenCalled();
    }
  );
  it("allows work to be unassigned only on explicit original Human instruction", async () => {
    const f = structuredWorkFixture(database);
    f.source.evidence[6]!.text = "Leave this task intentionally unassigned.";
    f.override((plan) => {
      plan.work.ownership = { status: "intentionally-unassigned", evidenceIds: ["e6"] };
    });
    const { mi, execution } = f.make();
    const plan = await mi.observe(f.request);
    expect(plan.state).toBe("validated");
    await execution.execute({
      workspace,
      subject,
      structuredWorkRequestId: plan.requestId,
      intentId: plan.approvedIntentId!
    });
    expect([...f.work.values()][0]?.assignee).toBeNull();
  });
  it("withholds stale source at query/execution and preserves visible budget failure without paid replay", async () => {
    const f = structuredWorkFixture(database);
    f.interpret.mockRejectedValueOnce(
      new AiServiceError("budget-exhausted", "do not expose provider body")
    );
    const { mi } = f.make();
    const result = await mi.observe(f.request);
    expect(result.message).toContain("budget-exhausted");
    expect(result.message).not.toContain("provider body");
    expect((await mi.observe(f.request)).duplicate).toBe(true);
    expect(f.interpret).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(
      mi.query({
        workspaceId: workspace.workspaceId,
        subject,
        query: { type: "structured-work-request", requestId: result.requestId }
      })
    ).rejects.toThrow();
  });
  it("rejects a changed immutable command and never approves source revoked during interpretation", async () => {
    const f = structuredWorkFixture(database);
    const original = f.interpret.getMockImplementation()!;
    f.interpret.mockImplementation(async () => {
      const result = await original();
      f.revoke();
      return result;
    });
    const { mi } = f.make();
    await expect(mi.observe(f.request)).rejects.toThrow();
    expect(f.createRecord).not.toHaveBeenCalled();
    const changed = structuredClone(f.request);
    changed.observations[0].instruction = "Different command";
    await expect(mi.observe(changed)).rejects.toThrow("different instruction");
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
});
