import { vi } from "vitest";
import type { StructuredRecords } from "../../src/knowledge/structured-records.js";
import type {
  StructuredRecord,
  StructuredRecordSchema,
  StructuredWorkSource,
  ObserveStructuredWork,
  StructuredWorkInterpretation
} from "../../src/domain/structured-work.js";
import { operationDigest } from "../../src/structured-work/persistence.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import {
  createLinearWorkProvider,
  type LinearApiIssue
} from "../../src/work/linear-work-provider.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type { LumaDatabase } from "../../src/persistence/db.js";
import type { StructuredWorkConfiguration } from "../../src/structured-work/structured-work.js";

export const workspace = { workspaceId: "dayova", timezone: "Europe/Berlin" };
export const audience = {
  workspaceId: workspace.workspaceId,
  personIds: ["jakob", "fabius", "julius", "philipp"]
};
export const subject = {
  type: "conversation-thread" as const,
  providerId: "discord",
  conversationObjectId: "thread",
  anchorMessageId: "command"
};
export const people = audience.personIds.map((personId) => ({
  personId,
  displayName: personId,
  discordUserId: personId,
  discordUsername: null,
  githubLogin: null,
  githubUserId: null,
  atlassianAccountId: null,
  notionUserId: `notion-${personId}`,
  linearUserId: `linear-${personId}`,
  languagePreference: "auto" as const
}));
export const directory = createStaticIdentityDirectory({ people });
export const title = "Flexible learning times improve student engagement";
export const recordSchema: StructuredRecordSchema = {
  targetKey: "hypotheses",
  label: "Product Hypotheses & Validation",
  revision: "schema-v1",
  titleField: "hypothesis",
  fields: [
    { key: "hypothesis", label: "Hypothesis", type: "text", required: true, choices: [] },
    {
      key: "evidence",
      label: "Evidence so far",
      type: "text",
      required: false,
      choices: []
    },
    {
      key: "status",
      label: "Status",
      type: "choice",
      required: true,
      choices: ["To validate", "Supported"]
    }
  ],
  defaults: { status: { type: "choice", value: "To validate" } }
};
export function sourceFixture(): StructuredWorkSource {
  const utterances = [
    [
      "fabius",
      "Predefined learning times make the product cumbersome. My study times change and sometimes a test is announced for tomorrow."
    ],
    ["fabius", "Present me with more feedback and observations about this topic."],
    ["jakob", "Was that a work assignment?"],
    ["fabius", "Yes."],
    ["jakob", "So should I validate the hypothesis now?"],
    ["fabius", "Yes."],
    [
      "jakob",
      "When Luma is ready, ping it and tell it to put the hypothesis in our Hypotheses table and create a Linear task."
    ],
    [
      "jakob",
      "Add this hypothesis to our Hypotheses table and create a Linear task to validate it."
    ]
  ];
  return {
    subject,
    revision: "source-1",
    contentHash: "original-source",
    authorizationHash: "original-access",
    capturedAt: "2026-09-11T12:00:00.000Z",
    audience: structuredClone(audience),
    evidence: utterances.map(([author, text], index) => ({
      id: `e${index}`,
      reference: {
        evidenceId: `e${index}`,
        source: "external-activity",
        sourceObjectId: index === 7 ? "command" : `message-${index}`,
        sourceVersion: "1",
        externalReference: {
          providerId: "discord",
          objectType: "comment",
          externalId: `m${index}`,
          url: `https://discord.com/channels/guild/thread/m${index}`
        }
      },
      text: text!,
      authorPersonId: author!,
      origin: "human"
    }))
  };
}
export function structuredWorkFixture(database: LumaDatabase) {
  const source = sourceFixture();
  let current = true,
    loseRecordAck = false,
    loseWorkAck = false,
    probeFound = true;
  const records = new Map<string, StructuredRecord>();
  const work = new Map<string, LinearApiIssue>();
  const recordReceipts = new Map<string, StructuredRecord>();
  const snapshot = () => ({
    schema: structuredClone(recordSchema),
    records: [...records.values()].map((record) => structuredClone(record)),
    complete: true,
    revision: operationDigest([...records.values()])
  });
  const createRecord = vi.fn<StructuredRecords["create"]>(async (request) => {
    await request.requireCurrent();
    if (operationDigest(request.expected) !== operationDigest(snapshot()))
      throw new Error("changed");
    const value: StructuredRecord = {
      reference: {
        providerId: "notion",
        objectType: "document",
        externalId: `record-${records.size + 1}`,
        url: `https://notion.so/record-${records.size + 1}`
      },
      version: "v1",
      fields: structuredClone(request.draft.fields),
      active: true
    };
    records.set(value.reference.externalId, value);
    recordReceipts.set(request.operationId, value);
    if (loseRecordAck) throw new Error("Lost Notion acknowledgement");
    return structuredClone(value);
  });
  const structuredRecords: StructuredRecords = {
    providerId: "notion",
    authorizationScopeId: "notion-test-scope",
    requireReadable: (request) => {
      if (request.authorizationScopeId !== structuredRecords.authorizationScopeId ||
        request.snapshot.schema.revision !== recordSchema.revision ||
        request.snapshot.records.some((original) => {
          const value = records.get(original.reference.externalId);
          return !value || !value.active || operationDigest(value.reference) !== operationDigest(original.reference);
        })) return Promise.reject(new Error("record access changed"));
      return Promise.resolve();
    },
    inspect: () => Promise.resolve(snapshot()),
    requireCurrent: (request) =>
      operationDigest(request.snapshot) === operationDigest(snapshot())
        ? Promise.resolve()
        : Promise.reject(new Error("record snapshot changed")),
    read: (request) => {
      const value = records.get(request.reference.externalId);
      return value
        ? Promise.resolve(structuredClone(value))
        : Promise.reject(new Error("missing"));
    },
    create: createRecord,
    findCreated: (request) =>
      Promise.resolve(
        probeFound
          ? structuredClone(recordReceipts.get(request.operationId) ?? null)
          : null
      )
  };
  const existingIssue = (): LinearApiIssue => ({
    id: "issue-uuid",
    teamId: "team",
    identifier: "DAY-1",
    title: `Validate: ${title}`,
    description: "Interview students about predefined and flexible learning times.",
    stateType: "unstarted",
    stateName: "Todo",
    assignee: { id: "linear-jakob", displayName: "Jakob", email: "fake@example.test" },
    dueDate: null,
    labels: [],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/DAY-1",
    updatedAt: "2026-09-11T12:00:00.000Z"
  });
  const createIssue = vi.fn(
    async (
      request: Parameters<
        NonNullable<Parameters<typeof createLinearWorkProvider>[0]["api"]>["createIssue"]
      >[0]
    ) => {
      await request.requireCurrent?.();
      const value = {
        ...existingIssue(),
        title: request.title,
        description: request.description,
        assignee: request.assigneeId
          ? { id: request.assigneeId, displayName: "Owner", email: "fake@example.test" }
          : null
      };
      work.set(value.identifier, value);
      if (loseWorkAck) throw new Error("Lost Linear acknowledgement");
      return value;
    }
  );
  const workProvider = createLinearWorkProvider({
    teamId: "team",
    api: {
      listIssues: () => Promise.resolve({ items: [...work.values()], complete: true }),
      searchIssues: () => Promise.resolve([...work.values()]),
      findIssueByIdempotencyKey: (request) =>
        Promise.resolve(
          probeFound
            ? ([...work.values()].find((item) =>
                item.description.includes(
                  `<!-- luma-idempotency-key: ${request.idempotencyKey} -->`
                )
              ) ?? null)
            : null
        ),
      getIssue: (id) => {
        const item = [...work.values()].find(
          (item) => item.id === id || item.identifier === id
        );
        return item ? Promise.resolve(item) : Promise.reject(new Error("missing work"));
      },
      createIssue,
      updateIssue: () => Promise.reject(new Error("No unsafe update")),
      addComment: () => Promise.reject(new Error("No extra comments"))
    }
  });
  let override: ((plan: StructuredWorkInterpretation) => void) | undefined;
  const interpret = vi.fn((): Promise<StructuredWorkInterpretation> => {
    const plan: StructuredWorkInterpretation = {
      targetKey: "hypotheses",
      record: {
        fields: {
          hypothesis: { type: "text", value: title },
          evidence: {
            type: "text",
            value:
              "Fabius reports changing study times; validate this with other students."
          }
        },
        evidenceIds: ["e0"],
        reconciliation: records.size
          ? { action: "link", targetId: [...records.keys()][0]! }
          : { action: "create" }
      },
      work: {
        title: `Validate: ${title}`,
        description: "Interview students about predefined and flexible learning times.",
        evidenceIds: ["e0", "e4", "e5"],
        ownership: { status: "confirmed", personId: "jakob", evidenceIds: ["e4", "e5"] },
        reconciliation: work.size
          ? { action: "link", targetId: "DAY-1" }
          : { action: "create" }
      }
    };
    override?.(plan);
    return Promise.resolve(plan);
  });
  const configuration: StructuredWorkConfiguration = {
    evidenceSource: {
      capture: () => Promise.resolve(structuredClone(source)),
      requireCurrent: () =>
        current ? Promise.resolve() : Promise.reject(new Error("revoked"))
    },
    interpreter: { interpret },
    records: structuredRecords,
    work: workProvider,
    workAuthorization: {
      scopeId: "linear-test-scope",
      resource: "team",
      authorize: () => Promise.resolve(true)
    },
    identityDirectory: directory,
    accessPolicy: createWorkspaceAccessPolicy({
      workspaceId: workspace.workspaceId,
      authorizedPersonIds: audience.personIds,
      identityDirectory: directory
    }),
    audience: () => Promise.resolve(structuredClone(audience)),
    targets: [{ key: "hypotheses", authorizedPersonIds: audience.personIds }]
  };
  const request: ObserveStructuredWork = {
    workspace,
    subject,
    observations: [
      {
        type: "structured-work-requested",
        observationId: "discord:command:structured-work",
        actor: { providerId: "discord", providerUserId: "jakob" },
        instruction: source.evidence.at(-1)!.text,
        targetKey: "hypotheses"
      }
    ]
  };
  const make = () => {
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () => Promise.reject(new Error("No Meeting model"))
      },
      structuredWork: configuration
    });
    const execution = createFollowUpExecution({ database, meetingIntelligence: mi });
    return { mi, execution };
  };
  return {
    source,
    records,
    work,
    configuration,
    request,
    make,
    interpret,
    createRecord,
    createIssue,
    override: (change: typeof override) => {
      override = change;
    },
    existingRecord: () => {
      records.set("existing-hypothesis", {
        reference: {
          providerId: "notion",
          objectType: "document",
          externalId: "existing-hypothesis",
          url: "https://notion.so/existing-hypothesis"
        },
        version: "existing-v1",
        fields: { hypothesis: { type: "text", value: title } },
        active: true
      });
    },
    existingWork: () => {
      const item = existingIssue();
      work.set(item.identifier, item);
    },
    revoke: () => {
      current = false;
    },
    loseRecord: () => {
      loseRecordAck = true;
    },
    loseWork: () => {
      loseWorkAck = true;
    },
    hideProbe: () => {
      probeFound = false;
    }
  };
}
