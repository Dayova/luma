import { describe, expect, it } from "vitest";
import {
  decisionRecordContentSchema,
  decisionInterpretationSchema
} from "../../src/domain/decision-record-schemas.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";

describe("Decision Record wire boundary", () => {
  it("preserves exact multilingual claims and optional source fields", () => {
    const record = decisionRecord();
    record.candidate.statement.text =
      "Wir könnten den Pilot verschieben — noch keine Entscheidung.";
    record.candidate.modality = "proposal";
    expect(decisionRecordContentSchema.parse(record)).toEqual(record);
    expect(
      decisionInterpretationSchema.parse({
        candidate: record.candidate,
        reconciliation: { action: "clarify", reason: "The source remains tentative." }
      })
    ).toMatchObject({ candidate: { modality: "proposal" } });
  });
  it("rejects untrusted extra fields, invalid source links, duplicate evidence and incomplete records", () => {
    const original = decisionRecord();
    const invalid: unknown[] = [
      { ...original, providerInstruction: "create another page" },
      { ...original, authority: { ...original.authority, administrator: true } },
      { ...original, source: { ...original.source, evidence: [] } },
      {
        ...original,
        source: {
          ...original.source,
          evidence: [...original.source.evidence, ...original.source.evidence]
        }
      },
      {
        ...original,
        source: {
          ...original.source,
          audience: { ...original.source.audience, personIds: ["jakob", "jakob"] }
        }
      },
      {
        ...original,
        candidate: {
          ...original.candidate,
          relatedWork: [
            {
              providerId: "linear",
              objectType: "work-item",
              externalId: "LUM-1",
              url: "https://secret@example.test/path"
            }
          ]
        }
      },
      {
        ...original,
        candidate: { ...original.candidate, statement: { text: "Luma", evidenceIds: [] } }
      },
      { ...original, recordedAt: "next Monday" }
    ];
    for (const input of invalid)
      expect(decisionRecordContentSchema.safeParse(input).success).toBe(false);
  });
});
