import { describe, expect, it } from "vitest";
import type { StructuredWorkState } from "../../src/domain/structured-work.js";
import { renderStructuredWorkResponse } from "../../src/discord/discord-structured-work-runtime.js";
import { sourceFixture } from "../structured-work/fixture.js";

function state(): StructuredWorkState {
  const source = sourceFixture();
  return {
    requestId: "original-request",
    subject: source.subject,
    source,
    state: "manual-application-required",
    message:
      "The current provider cannot safely apply a conditional update. No bundle writes were approved.",
    approvedIntentId: null,
    preview: null,
    outcomes: [],
    updateProposals: [
      {
        target: "record",
        reference: {
          providerId: "notion",
          externalId: "hypothesis-1",
          objectType: "document",
          url: "https://notion.so/hypothesis-1"
        },
        expectedVersion: "source-record-1",
        reason: "provider-conditional-update-unavailable",
        changes: [
          {
            key: "evidence",
            label: "Evidence so far",
            before: { type: "text", value: "Three interviews" },
            after: {
              type: "text",
              value: "Five interviews; @Dayova Team has not approved a launch."
            }
          },
          {
            key: "priority",
            label: "Priority",
            before: null,
            after: { type: "number", value: 2 }
          }
        ]
      },
      {
        target: "work",
        reference: {
          providerId: "linear",
          externalId: "LUM-39",
          objectType: "work-item",
          url: "https://linear.app/dayova/issue/LUM-39"
        },
        expectedVersion: "work-1",
        reason: "provider-conditional-update-unavailable",
        changes: [
          {
            key: "assignee",
            label: "Owner",
            before: { type: "people", value: [] },
            after: {
              type: "people",
              value: [
                { providerId: "linear", providerUserId: "jakob", displayName: "Jakob" }
              ]
            }
          }
        ]
      }
    ]
  };
}
function allPages(value: StructuredWorkState) {
  const first = renderStructuredWorkResponse(value);
  const pages = Number(first.match(/Page 1\/(\d+)/u)?.[1]);
  return Array.from({ length: pages }, (_, index) =>
    renderStructuredWorkResponse(value, index + 1)
  );
}
describe("Manual structured updates in Discord", () => {
  it("renders the exact target and before/after changes without claiming the bundle executed", () => {
    const pages = allPages(state());
    const content = pages.join("\n");
    expect(content).toContain("manual-application-required");
    expect(content).toContain("<https://notion.so/hypothesis-1>");
    expect(content).toContain(
      'Evidence so far: "Three interviews" → "Five interviews; @\u200bDayova Team has not approved a launch."'
    );
    expect(content).toContain("Priority: not set → 2");
    expect(content).toContain("<https://linear.app/dayova/issue/LUM-39>");
    expect(content).toContain("Owner: unassigned → Jakob (linear:jakob)");
    expect(content).toContain("Apply the proposed changes in the linked targets");
    expect(content).not.toContain("recover checks an uncertain write");
    expect(pages.every((page) => page.length < 2000)).toBe(true);
  });
  it("keeps the complete manual comparison available over bounded status pages", () => {
    const value = state();
    value.updateProposals![0]!.changes[0]!.after = {
      type: "text",
      value: "Detailed original qualification. ".repeat(100) + "FINAL CAVEAT"
    };
    const pages = allPages(value);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("")).toContain("FINAL CAVEAT");
    expect(pages.at(-1)).toContain("Apply the proposed changes");
    expect(pages.every((page) => page.length < 2000)).toBe(true);
  });
});
