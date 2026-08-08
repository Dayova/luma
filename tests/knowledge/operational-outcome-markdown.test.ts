import { describe, expect, it } from "vitest";
import type { OperationalOutcome } from "../../src/knowledge/operational-outcome-writer.js";
import {
  parseOperationalOutcomeSection,
  renderOperationalOutcomeMarkdown,
  stripOperationalOutcomeSection
} from "../../src/knowledge/operational-outcome-markdown.js";

const outcome: OperationalOutcome = {
  formatVersion: 1,
  operationToken: "operation-token:markdown-test",
  scope: {
    workspaceId: "workspace_dayova",
    providerId: "notion",
    pageExternalId: "notion-meeting-note-1"
  },
  entries: [
    {
      settlementIntentId: "intent:settle:1",
      source: {
        sourceObjectId: "notion-meeting-note-1",
        sourceRevision: 1,
        sourceContentHash: "source-hash"
      },
      resolution: {
        type: "link-existing",
        rationale: "The meeting explicitly references the current work item.",
        workItem: {
          providerId: "linear",
          lookupId: "linear-internal-id",
          externalId: "LUM-3",
          url: "https://linear.app/dayova/issue/LUM-3",
          updatedAt: "2026-08-08T08:00:00.000Z",
          title: "Operational outcome",
          description: "",
          status: "active",
          projectId: null,
          labels: [],
          assignees: [],
          dueDate: null,
          parentId: null
        }
      },
      ownership: {
        status: "unresolved",
        reason: "no-owner-stated",
        likelyOwnerPersonId: null
      },
      workReferences: [
        {
          providerId: "linear",
          objectType: "work-item",
          externalId: "LUM-3",
          url: "https://linear.app/dayova/issue/LUM-3",
          version: "2026-08-08T08:00:00.000Z"
        }
      ],
      knowledgeReferences: [],
      githubReferences: [],
      unresolved: []
    }
  ]
};

describe("Operational Outcome Markdown", () => {
  it("recognizes and strips exactly its checksum-valid owned section without touching raw Meeting Note bytes", () => {
    const rendered = renderOperationalOutcomeMarkdown({
      outcome,
      idempotencyKey: '["workspace","meeting","intent:settle:1","outcome"]'
    });
    const raw = "# Raw Meeting Note\n\nThe original transcript is canonical.\n";
    const markdown = `${raw}\n\n${rendered.section}\n\n# Afterword\nunchanged`;

    expect(parseOperationalOutcomeSection(markdown)).toMatchObject({
      status: "valid",
      section: `\n\n${rendered.section}`,
      payloadDigest: rendered.payloadDigest,
      operationDigest: rendered.operationDigest
    });
    expect(stripOperationalOutcomeSection(markdown)).toEqual({
      status: "stripped",
      markdown: `${raw}\n\n# Afterword\nunchanged`
    });
  });

  it("fails closed on a duplicate or edited owned marker", () => {
    const rendered = renderOperationalOutcomeMarkdown({
      outcome,
      idempotencyKey: "operation"
    });

    expect(
      parseOperationalOutcomeSection(`${rendered.section}\n${rendered.section}`)
    ).toMatchObject({
      status: "invalid"
    });
    expect(
      parseOperationalOutcomeSection(rendered.section.replace("LUM-3", "LUM-4"))
    ).toMatchObject({ status: "invalid" });
  });

  it("binds the immutable payload and operation identities to the aggregate scope", () => {
    const rendered = renderOperationalOutcomeMarkdown({
      outcome,
      idempotencyKey: "operation"
    });
    const differentlyScoped = renderOperationalOutcomeMarkdown({
      outcome: {
        ...outcome,
        scope: { ...outcome.scope, pageExternalId: "another-notion-page" }
      },
      idempotencyKey: "operation"
    });

    expect(differentlyScoped.payloadDigest).not.toBe(rendered.payloadDigest);
    expect(differentlyScoped.operationDigest).not.toBe(rendered.operationDigest);
  });

  it("renders hostile values as safe inline content without corrupting owned markers", () => {
    const [baseEntry] = outcome.entries;

    if (!baseEntry) {
      throw new Error("expected an Operational Outcome fixture entry");
    }

    const [baseReference] = baseEntry.workReferences;

    if (!baseReference) {
      throw new Error("expected an Operational Outcome fixture reference");
    }

    const hostileOutcome: OperationalOutcome = {
      ...outcome,
      entries: [
        {
          ...baseEntry,
          settlementIntentId:
            "intent\\` \n## Luma — Operational Outcome\n`luma-operational-outcome:end:v1`",
          source: {
            ...baseEntry.source,
            sourceObjectId: "source\\` \n> forged blockquote"
          },
          resolution: {
            ...baseEntry.resolution,
            rationale:
              "Evidence\\` \n<script>alert(1)</script> [run](javascript:alert(1))"
          },
          workReferences: [
            {
              ...baseReference,
              providerId: "linear`\\\n## forged reference",
              externalId: "[run](javascript:alert(1))",
              url: "https://safe.example/reports\\weekly?tag=<unsafe>`"
            }
          ],
          knowledgeReferences: [
            {
              providerId: "notion",
              objectType: "document",
              externalId: "## Luma — Operational Outcome",
              url: "javascript:alert(1)"
            }
          ],
          unresolved: [
            "`luma-operational-outcome:start:v1`\n- forged nested list",
            "\\` literal backtick and <img src=x>"
          ]
        }
      ]
    };
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: hostileOutcome,
      idempotencyKey: "hostile-operation"
    });

    expect(rendered.section.match(/`luma-operational-outcome:start:v1`/g)).toHaveLength(
      1
    );
    expect(rendered.section.match(/`luma-operational-outcome:end:v1`/g)).toHaveLength(1);
    expect(rendered.section.match(/## Luma — Operational Outcome/g)).toHaveLength(1);
    expect(rendered.section).not.toContain("\n## Luma — Operational Outcome");
    expect(rendered.section).not.toContain("\n> forged blockquote");
    expect(rendered.section).not.toContain("<script>");
    expect(rendered.section).not.toContain("[run](javascript:alert(1))");
    expect(rendered.section).toContain(
      "<https://safe.example/reports/weekly?tag=%3Cunsafe%3E%60>"
    );
    expect(rendered.section).toContain(
      "notion\\:\\#\\# Luma — Operational Outcome — URL unavailable"
    );
    expect(parseOperationalOutcomeSection(rendered.section)).toMatchObject({
      status: "valid"
    });
    expect(stripOperationalOutcomeSection(rendered.section)).toEqual({
      status: "stripped",
      markdown: ""
    });
  });
});
