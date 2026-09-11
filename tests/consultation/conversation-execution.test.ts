import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { ConsultationNotPublishedError } from "../../src/consultation/interface.js";
import { consultationDigest } from "../../src/context-intelligence/conversation-consultations.js";
import {
  harness,
  requestFixture,
  receiptFixture,
  subject,
  workspace
} from "./harness.js";
let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  if (!database.closed) await database.close();
});
const address = {
  workspaceId: workspace.workspaceId,
  subject,
  consultationId: "request-1"
};
const execute = { workspace, subject, intentId: "publish-consultation:request-1" };
describe("Canonical Conversation consultation execution", () => {
  it("captures an ordinary founder instruction and publishes without creating a Meeting or model call", async () => {
    const h = harness(database);
    const requested = await h.context.request(requestFixture());
    expect(requested.consultation.consultation).toMatchObject({
      durationHours: 24,
      source: { capturePurpose: "consultation" },
      authorization: { basis: "explicit-instruction", authorizedBy: "person_jakob" },
      owner: { personId: "person_jakob" }
    });
    expect(h.publish).not.toHaveBeenCalled();
    const result = await h.execution.execute(execute);
    expect(result.observation).toMatchObject({
      subject,
      outcome: { status: "succeeded", receipt: { mention: "verified-role" } }
    });
    expect(h.publish.mock.calls[0]?.[0].consultation).toEqual(
      requested.consultation.consultation
    );
    expect((await database.query("SELECT * FROM meetings")).rows).toEqual([]);
    expect(h.model.generateStructured).not.toHaveBeenCalled();
    expect(
      (await database.query("SELECT * FROM conversation_consultation_events")).rows
    ).toHaveLength(1);
  });
  it("replays exact requests and receipts, rejects ID payload changes, and folds a duplicate command into its original consultation", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    const first = await h.execution.execute(execute);
    await h.context.request(requestFixture());
    expect(await h.execution.execute(execute)).toEqual(first);
    const next = await h.context.request({
      ...requestFixture(),
      consultationId: "repeat"
    });
    expect(next.intentId).toBe(execute.intentId);
    expect(h.publish).toHaveBeenCalledTimes(1);
    await expect(
      h.context.request({
        ...requestFixture(),
        instruction: { ...requestFixture().instruction, question: "Other?" }
      })
    ).rejects.toMatchObject({ code: "consultation-request-conflict" });
  });
  it("requires explicit replacement when an otherwise equivalent command changes its exact purpose, duration or owner", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    for (const change of [
      { purpose: "A different purpose" },
      { durationHours: 48 },
      { ownerPersonId: "person_fabius" }
    ]) {
      await expect(
        h.context.request({
          ...requestFixture(),
          consultationId: `changed-${Object.keys(change)[0]}`,
          instruction: { ...requestFixture().instruction, ...change }
        })
      ).rejects.toMatchObject({ code: "consultation-instruction-changed" });
    }
    const replacement = await h.context.request({
      ...requestFixture(),
      consultationId: "changed-authorized",
      instruction: {
        ...requestFixture().instruction,
        durationHours: 48,
        replacesConsultationId: "request-1"
      }
    });
    expect(replacement.consultation.consultation.durationHours).toBe(48);
    expect(h.publish).not.toHaveBeenCalled();
  });
  it("permits a fresh explicit replacement of obsolete source wording without exposing the obsolete plan", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    await h.execution.execute(execute);
    h.evidence.snapshot.messages[0]!.text = "Updated proposal after further discussion";
    await expect(h.context.get(address)).rejects.toMatchObject({
      code: "consultation-source-changed"
    });
    const next = await h.context.request({
      ...requestFixture(),
      consultationId: "fresh-replacement",
      instruction: {
        ...requestFixture().instruction,
        question: "Revised proposal?",
        replacesConsultationId: "request-1"
      }
    });
    expect(next.consultation.consultation.source.question).toBe(
      "Updated proposal after further discussion"
    );
    expect(
      (await h.execution.execute({ ...execute, intentId: next.intentId })).observation
        .outcome.status
    ).toBe("succeeded");
  });
  it("keeps an uncertain send durable across actual store restart; only exact positive recovery succeeds", async () => {
    await database.close();
    const dir = await mkdtemp(join(tmpdir(), "luma-consultation-"));
    try {
      database = await createPgliteDatabase(join(dir, "store"));
      const first = harness(database);
      await first.context.request(requestFixture());
      first.publish.mockRejectedValue(
        new Error("response lost after Discord may have accepted")
      );
      expect((await first.execution.execute(execute)).observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });
      await database.close();
      database = await createPgliteDatabase(join(dir, "store"));
      const restarted = harness(database);
      expect(
        (await restarted.execution.execute(execute)).observation.outcome
      ).toMatchObject({ requiresManualRecovery: true });
      expect(
        (await restarted.execution.recover(execute)).observation.outcome
      ).toMatchObject({ requiresManualRecovery: true });
      restarted.findPublished.mockImplementation(({ consultation }) =>
        Promise.resolve(receiptFixture(consultation))
      );
      expect(
        (await restarted.execution.recover(execute)).observation.outcome.status
      ).toBe("succeeded");
      expect(restarted.publish).not.toHaveBeenCalled();
      expect(
        (await restarted.context.get(address)).publication?.reference.externalId
      ).toBe("400000000000000001");
      await database.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("never resends a proven prewrite refusal", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    h.publish.mockRejectedValue(
      new ConsultationNotPublishedError(
        "role-changed",
        "Original role no longer matches; no poll sent."
      )
    );
    const refused = await h.execution.execute(execute);
    expect(refused.observation.outcome).toMatchObject({ requiresManualRecovery: false });
    expect(await h.execution.recover(execute)).toEqual(refused);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.findPublished).not.toHaveBeenCalled();
  });
  it("treats a mismatched positive response as unknown and fences new commands behind that uncertain publication", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    h.publish.mockImplementation(({ consultation }) => {
      const receipt = receiptFixture(consultation);
      receipt.poll.question = "Different proposal";
      return Promise.resolve(receipt);
    });
    expect((await h.execution.execute(execute)).observation.outcome).toMatchObject({
      requiresManualRecovery: true
    });
    expect((await h.context.get(address)).publication).toBeNull();
    const second = await h.context.request({
      ...requestFixture(),
      consultationId: "new-command",
      instruction: { ...requestFixture().instruction, question: "Another proposal?" }
    });
    expect(
      (await h.execution.execute({ ...execute, intentId: second.intentId })).observation
        .outcome
    ).toMatchObject({
      errorCode: "consultation-prior-outcome-unknown",
      requiresManualRecovery: false
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });
  it("keeps a durable pre-send claim after an interrupted process and never sends it again", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    await database.query(
      "UPDATE conversation_consultation_operations SET state='executing'"
    );
    expect((await h.execution.execute(execute)).observation.outcome).toMatchObject({
      requiresManualRecovery: true
    });
    expect(
      (
        await database.query<{ state: string }>(
          "SELECT state FROM conversation_consultation_operations"
        )
      ).rows[0]?.state
    ).toBe("unknown");
    expect(h.publish).not.toHaveBeenCalled();
  });
  it("uses only the stored publication for status and closure; repeated closure instructions never send twice", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    await h.execution.execute(execute);
    const first = await h.context.requestClose({
      ...address,
      actor: requestFixture().actor,
      requestId: "close-1"
    });
    const closeRequest = { ...execute, intentId: first.intentId };
    await h.execution.execute(closeRequest);
    const again = await h.context.requestClose({
      ...address,
      actor: { providerId: "discord", providerUserId: "726409024894926869" },
      requestId: "close-2"
    });
    expect(again).toEqual(first);
    await h.execution.execute({ ...execute, intentId: again.intentId });
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.close.mock.calls[0]?.[0].reference).toEqual(
      (await h.context.get(address)).publication?.reference
    );
    await h.execution.readConsultation(execute);
    expect(h.read.mock.calls[0]?.[0].reference).toEqual(
      (await h.context.get(address)).publication?.reference
    );
  });
  it("recovers an uncertain closure only from positive finalized evidence and never closes human polls", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    await h.execution.execute(execute);
    const intent = await h.context.requestClose({
      ...address,
      actor: requestFixture().actor,
      requestId: "close"
    });
    const closeRequest = { ...execute, intentId: intent.intentId };
    h.close.mockRejectedValue(new Error("lost response"));
    await h.execution.execute(closeRequest);
    expect((await h.execution.recover(closeRequest)).observation.outcome).toMatchObject({
      requiresManualRecovery: true
    });
    h.read.mockImplementation(({ consultation }) => {
      const r = receiptFixture(consultation);
      r.poll.results = {
        status: "finalized",
        counts: [
          { optionId: "1", votes: 0 },
          { optionId: "2", votes: 3 }
        ]
      };
      return Promise.resolve(r);
    });
    expect((await h.execution.recover(closeRequest)).observation.outcome.status).toBe(
      "succeeded"
    );
    expect(h.close).toHaveBeenCalledTimes(1);
    const other = await h.context.request({
      ...requestFixture(),
      consultationId: "human-reuse",
      instruction: { ...requestFixture().instruction, question: "Different question?" }
    });
    h.publish.mockImplementation(({ consultation }) =>
      Promise.resolve({
        ...receiptFixture(consultation),
        origin: "human",
        disposition: "reused",
        mention: "not-requested"
      })
    );
    await h.execution.execute({ ...execute, intentId: other.intentId });
    await expect(
      h.context.requestClose({
        ...address,
        consultationId: "human-reuse",
        actor: requestFixture().actor,
        requestId: "human-close"
      })
    ).rejects.toMatchObject({ code: "consultation-close-refused" });
  });
  it("permits only poll tally and expiry evolution while retaining the original immutable source and plan", async () => {
    const h = harness(database);
    const poll = receiptFixture({
      ...(await h.context.request(requestFixture())).consultation.consultation
    }).poll;
    // A separate original capture containing an existing poll.
    h.evidence.snapshot.messages[0]!.state = "available";
    const message = h.evidence.snapshot.messages[0]!;
    if (message.state !== "available") throw new Error("fixture");
    message.poll = poll;
    const requested = await h.context.request({
      ...requestFixture(),
      consultationId: "with-poll",
      instruction: { ...requestFixture().instruction, question: "New consultation?" }
    });
    const original = consultationDigest(requested.consultation.consultation);
    message.poll.results = {
      status: "finalized",
      counts: [
        { optionId: "1", votes: 1 },
        { optionId: "2", votes: 3 }
      ]
    };
    message.poll.closesAt = null;
    await h.execution.execute({ ...execute, intentId: requested.intentId });
    expect(
      consultationDigest(
        (await h.context.get({ ...address, consultationId: "with-poll" })).consultation
      )
    ).toBe(original);
    message.text = "Edited proposal";
    await expect(
      h.execution.readConsultation({ ...execute, intentId: requested.intentId })
    ).rejects.toMatchObject({ code: "consultation-source-changed" });
    expect(h.read).not.toHaveBeenCalled();
  });
  it("rejects guest authorization, incomplete evidence, changed sources and corrupted stored receipts before provider work", async () => {
    const h = harness(database);
    await expect(
      h.context.request({
        ...requestFixture(),
        actor: { providerId: "discord", providerUserId: "guest" }
      })
    ).rejects.toMatchObject({ code: "consultation-access-refused" });
    expect(h.capture).not.toHaveBeenCalled();
    h.evidence.snapshot.completeness = {
      state: "partial",
      reasons: [{ code: "history-truncated", message: "Boundary incomplete" }]
    };
    await expect(h.context.request(requestFixture())).rejects.toMatchObject({
      code: "consultation-source-incomplete"
    });
    h.evidence.snapshot.completeness = { state: "complete" };
    await h.context.request(requestFixture());
    await h.execution.execute(execute);
    await database.query(
      "UPDATE conversation_consultation_operations SET record_json='{}'"
    );
    await expect(h.execution.execute(execute)).rejects.toMatchObject({
      code: "consultation-corrupt"
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });
  it("retains replacement history and Human reasoning that departs from the advisory tally without a Decision Record", async () => {
    const h = harness(database);
    await h.context.request(requestFixture());
    await h.execution.execute(execute);
    const replacement = await h.context.request({
      ...requestFixture(),
      consultationId: "replacement",
      instruction: {
        ...requestFixture().instruction,
        question: "Revised approach?",
        replacesConsultationId: "request-1"
      }
    });
    expect(replacement.consultation.consultation.replacesConsultationId).toBe(
      "request-1"
    );
    await h.context.recordJudgment({
      ...address,
      actor: requestFixture().actor,
      judgmentId: "judgment",
      choice: "Internal pilot",
      rationale: "Although more voted for launch, the migration is not ready."
    });
    const events = await database.query<{ payload_json: string }>(
      "SELECT payload_json FROM conversation_consultation_events WHERE kind='human-judgment'"
    );
    expect(JSON.parse(events.rows[0]!.payload_json)).toMatchObject({
      authority: "accountable-owner",
      choice: "Internal pilot"
    });
    expect(
      (await database.query("SELECT * FROM conversation_consultations")).rows
    ).toHaveLength(2);
    expect((await database.query("SELECT * FROM meetings")).rows).toHaveLength(0);
  });
});
