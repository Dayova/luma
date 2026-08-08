import { describe, expect, it } from "vitest";
import type {
  ActionItemReconciliationResolution,
  ExternalReference,
  MeetingImportedFromSource,
  WorkspaceConfig
} from "../../src/domain/model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type {
  OperationalOutcome,
  OperationalOutcomeReceipt,
  OperationalOutcomeTarget,
  OperationalOutcomeWriter
} from "../../src/knowledge/operational-outcome-writer.js";
import { OperationalOutcomeWriteNotAppliedError } from "../../src/knowledge/operational-outcome-writer.js";
import { renderOperationalOutcomeMarkdown } from "../../src/knowledge/operational-outcome-markdown.js";
import {
  createLedgerBackedOperationalOutcomeSourceExecutionFence,
  type OperationalOutcomeSourceExecutionFence
} from "../../src/knowledge/ledger-backed-operational-outcome-source-execution-fence.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence as createProductionMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import type { ImportedSourceObservationVerifier } from "../../src/meeting-intelligence/imported-source-observation-verifier.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  CreateWorkItemInput,
  ConditionalUpdateWorkItemInput,
  UpdateWorkItemInput,
  WorkCatalog,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";

const workspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};

const acceptingImportedSourceVerifier: ImportedSourceObservationVerifier = {
  verify: () => Promise.resolve({ status: "verified" })
};

function createMeetingIntelligence(
  input: Parameters<typeof createProductionMeetingIntelligence>[0]
) {
  return createProductionMeetingIntelligence({
    ...input,
    importedSourceObservationVerifier: acceptingImportedSourceVerifier
  });
}

function meetingIntelligenceWithSecondSnapshotFailure(
  delegate: MeetingIntelligence
): MeetingIntelligence {
  let snapshotQueries = 0;

  return {
    observe: (input) => delegate.observe(input),
    query: (input) => {
      if (input.query.type === "snapshot") {
        snapshotQueries += 1;

        if (snapshotQueries === 2) {
          return Promise.reject(
            new Error("simulated canonical source reread interruption")
          );
        }
      }

      return delegate.query(input);
    },
    conclude: (input) => delegate.conclude(input)
  };
}

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("source reconciliation must not invoke model analysis")
    );
  }
}

class ProgrammableWorkCatalog implements WorkCatalog {
  readonly providerId: string;
  readonly supportsConditionalUpdates: boolean;
  readonly searchCalls: WorkQuery[] = [];
  readonly getCalls: string[] = [];
  private readonly searchResponses = new Map<string, WorkItem[] | Error>();
  private readonly workItems = new Map<string, WorkItem | Error>();

  constructor(providerId = "linear", supportsConditionalUpdates = true) {
    this.providerId = providerId;
    this.supportsConditionalUpdates = supportsConditionalUpdates;
  }

  respondToSearch(text: string, response: WorkItem[] | Error): void {
    this.searchResponses.set(text, response);
  }

  respondToGet(id: string, response: WorkItem | Error): void {
    this.workItems.set(id, response);
  }

  searchWorkItems(query: WorkQuery): Promise<WorkItem[]> {
    this.searchCalls.push(query);
    const response = this.searchResponses.get(query.text) ?? [];

    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    this.getCalls.push(id);
    const response = this.workItems.get(id);

    if (!response) {
      return Promise.reject(new Error(`unexpected getWorkItem(${id})`));
    }

    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }
}

class RecordingWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly updateCalls: Array<{ id: string; input: UpdateWorkItemInput }> = [];

  constructor(private readonly current: WorkItem) {}

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    return id === this.current.id
      ? Promise.resolve(this.current)
      : Promise.reject(new Error(`unexpected getWorkItem(${id})`));
  }

  createWorkItem(_input: CreateWorkItemInput): Promise<ExternalReference> {
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<ExternalReference> {
    this.updateCalls.push({ id, input });
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: this.current.externalId,
      url: this.current.url,
      version: this.current.updatedAt
    });
  }

  updateWorkItemIfCurrent(
    id: string,
    input: ConditionalUpdateWorkItemInput
  ): Promise<ExternalReference | null> {
    if (input.expectedUpdatedAt !== this.current.updatedAt) {
      return Promise.resolve(null);
    }

    this.updateCalls.push({ id, input });
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: this.current.externalId,
      url: this.current.url,
      version: this.current.updatedAt
    });
  }

  addComment(_id: string, _body: string): Promise<void> {
    void _id;
    void _body;
    return Promise.resolve();
  }
}

class RecordingCreateWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly createCalls: CreateWorkItemInput[] = [];
  private readonly createdByMarker = new Map<string, ExternalReference>();

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(_id: string): Promise<WorkItem> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    const reference: ExternalReference = {
      providerId: this.providerId,
      objectType: "work-item",
      externalId: "LUM-99",
      url: "https://linear.app/dayova/issue/LUM-99",
      version: "2026-08-08T10:02:00.000Z"
    };
    this.createdByMarker.set(input.idempotencyKey, reference);
    return Promise.resolve(reference);
  }

  findCreatedWorkItemByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    return Promise.resolve(this.createdByMarker.get(idempotencyKey) ?? null);
  }

  updateWorkItem(_id: string, _input: UpdateWorkItemInput): Promise<ExternalReference> {
    void _id;
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  addComment(_id: string, _body: string): Promise<void> {
    void _id;
    void _body;
    return Promise.resolve();
  }
}

class RecordingOperationalOutcomeWriter implements OperationalOutcomeWriter {
  readonly providerId = "notion";
  readonly writes: Array<{
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }> = [];
  private readonly receipts = new Map<string, OperationalOutcomeReceipt>();

  constructor(private remainingSafeFailures = 0) {}

  upsert(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt> {
    if (this.remainingSafeFailures > 0) {
      this.remainingSafeFailures -= 1;
      return Promise.reject(
        new OperationalOutcomeWriteNotAppliedError(
          "Notion rejected the outcome before applying it"
        )
      );
    }

    this.writes.push(input);
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey
    });
    const receipt: OperationalOutcomeReceipt = {
      externalReference: input.target.page,
      status: "inserted",
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest
    };
    this.receipts.set(input.idempotencyKey, receipt);
    return Promise.resolve(receipt);
  }

  findWrittenOutcome(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> {
    void input.target;
    void input.outcome;
    return Promise.resolve(this.receipts.get(input.idempotencyKey) ?? null);
  }
}

class BlockingOperationalOutcomeWriter implements OperationalOutcomeWriter {
  readonly providerId = "notion";
  readonly writes: Array<{
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }> = [];
  private releaseWriteSignal: (() => void) | null = null;
  private signalWriteStarted: (() => void) | null = null;
  private readonly writeReleased = new Promise<void>((resolve) => {
    this.releaseWriteSignal = resolve;
  });
  private readonly writeStarted = new Promise<void>((resolve) => {
    this.signalWriteStarted = resolve;
  });

  async upsert(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt> {
    this.writes.push(input);
    this.signalWriteStarted?.();
    this.signalWriteStarted = null;
    await this.writeReleased;
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey
    });

    return {
      externalReference: input.target.page,
      status: "inserted",
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest
    };
  }

  findWrittenOutcome(_input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> {
    void _input;
    return Promise.resolve(null);
  }

  waitForWrite(): Promise<void> {
    return this.writeStarted;
  }

  releaseWrite(): void {
    this.releaseWriteSignal?.();
    this.releaseWriteSignal = null;
  }
}

class ManualFailureOperationalOutcomeWriter implements OperationalOutcomeWriter {
  readonly providerId = "notion";

  upsert(_input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt> {
    void _input;
    return Promise.reject(
      new OperationalOutcomeWriteNotAppliedError(
        "The source page contains an untrusted Operational Outcome marker.",
        false
      )
    );
  }

  findWrittenOutcome(_input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> {
    void _input;
    return Promise.resolve(null);
  }
}

class DelayedPositiveRecoveryOperationalOutcomeWriter implements OperationalOutcomeWriter {
  readonly providerId = "notion";
  readonly writes: string[] = [];
  readonly probes: string[] = [];
  private readonly receipts = new Map<string, OperationalOutcomeReceipt>();

  upsert(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt> {
    this.writes.push(input.idempotencyKey);
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey
    });
    this.receipts.set(input.idempotencyKey, {
      externalReference: input.target.page,
      status: "inserted",
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest
    });
    return Promise.reject(new Error("simulated lost Notion write response"));
  }

  findWrittenOutcome(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> {
    void input.target;
    void input.outcome;
    this.probes.push(input.idempotencyKey);

    // The first immediate probe cannot prove the write. A later explicit
    // recovery observes the exact prepared marker and can release the lease.
    return Promise.resolve(
      this.probes.filter((idempotencyKey) => idempotencyKey === input.idempotencyKey)
        .length > 1
        ? (this.receipts.get(input.idempotencyKey) ?? null)
        : null
    );
  }
}

class BlockingManualRecoveryOperationalOutcomeWriter implements OperationalOutcomeWriter {
  readonly providerId = "notion";
  readonly writes: string[] = [];
  private readonly receipts = new Map<string, OperationalOutcomeReceipt>();
  private releaseManualProbeSignal: (() => void) | null = null;
  private signalManualProbe: (() => void) | null = null;
  private readonly manualProbeReleased = new Promise<void>((resolve) => {
    this.releaseManualProbeSignal = resolve;
  });
  private readonly manualProbeStarted = new Promise<void>((resolve) => {
    this.signalManualProbe = resolve;
  });
  private probes = 0;

  upsert(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt> {
    this.writes.push(input.idempotencyKey);
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey
    });
    this.receipts.set(input.idempotencyKey, {
      externalReference: input.target.page,
      status: "inserted",
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest
    });
    return Promise.reject(new Error("simulated lost Notion write response"));
  }

  async findWrittenOutcome(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null> {
    void input.target;
    void input.outcome;
    this.probes += 1;

    if (this.probes === 1) {
      return null;
    }

    this.signalManualProbe?.();
    this.signalManualProbe = null;
    await this.manualProbeReleased;
    return this.receipts.get(input.idempotencyKey) ?? null;
  }

  waitForManualProbe(): Promise<void> {
    return this.manualProbeStarted;
  }

  releaseManualProbe(): void {
    this.releaseManualProbeSignal?.();
    this.releaseManualProbeSignal = null;
  }
}

class DeferredSearchWorkCatalog implements WorkCatalog {
  readonly providerId = "linear";
  readonly searchCalls: WorkQuery[] = [];
  readonly getCalls: string[] = [];
  private releaseSearches: (() => void) | null = null;
  private signalFirstSearch: (() => void) | null = null;
  private readonly searchesReleased = new Promise<void>((resolve) => {
    this.releaseSearches = resolve;
  });
  private readonly firstSearchStarted = new Promise<void>((resolve) => {
    this.signalFirstSearch = resolve;
  });

  async searchWorkItems(query: WorkQuery): Promise<WorkItem[]> {
    this.searchCalls.push(query);
    this.signalFirstSearch?.();
    this.signalFirstSearch = null;
    await this.searchesReleased;
    return [workItem()];
  }

  getWorkItem(id: string): Promise<WorkItem> {
    this.getCalls.push(id);
    return Promise.resolve(workItem({ id }));
  }

  waitForFirstSearch(): Promise<void> {
    return this.firstSearchStarted;
  }

  release(): void {
    this.releaseSearches?.();
    this.releaseSearches = null;
  }
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "linear-issue-lum-3",
    providerId: "linear",
    externalId: "LUM-3",
    title: "Finish Luma source import",
    description: "Finish the evidence-grounded Luma source import.",
    status: "active",
    assignees: [
      {
        id: "linear-user-jakob",
        displayName: "Jakob",
        username: "jakob"
      }
    ],
    dueDate: "2026-08-07",
    labels: ["backend"],
    projectId: "project-luma",
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-3",
    updatedAt: "2026-08-07T08:00:00.000Z",
    ...overrides
  };
}

function sourceObservation(
  input: {
    revision?: number;
    contentHash?: string;
    sourceObjectId?: string;
    meetingId?: string;
    workItemProviderId?: string;
    blockId?: string;
    description?: string;
    completeness?: MeetingImportedFromSource["source"]["completeness"];
    modality?: MeetingImportedFromSource["candidates"][number]["modality"];
    owner?: MeetingImportedFromSource["candidates"][number]["owner"];
    deadline?: MeetingImportedFromSource["candidates"][number]["deadline"];
    mentionedWorkItemReferences?: MeetingImportedFromSource["candidates"][number]["mentionedWorkItemReferences"];
    projectHints?: string[];
    componentHints?: string[];
    completion?: "open" | "completed";
    emptyActionItems?: boolean;
  } = {}
): MeetingImportedFromSource {
  const revision = input.revision ?? 1;
  const blockId = input.blockId ?? "source-action";
  const sourceObjectId = input.sourceObjectId ?? "notion-meeting-note";
  const description =
    input.description ?? "Jakob will finish LUM-3 source import by Friday.";
  const source = {
    providerId: "notion",
    sourceKind: "meeting-note",
    sourceObjectId,
    parentObjectId: "notion-page-product-sync",
    sourceRevision: revision,
    contentHash: input.contentHash ?? `sha256:source-r${revision}`,
    providerVersion: `2026-08-0${revision}T09:00:00.000Z`,
    title: "Product sync",
    externalReference: {
      providerId: "notion",
      objectType: "document",
      externalId: "notion-page-product-sync",
      url: "https://notion.so/product-sync",
      version: `2026-08-0${revision}T09:00:00.000Z`
    },
    workItemProviderId: input.workItemProviderId ?? "linear",
    completeness: input.completeness ?? "complete",
    completenessReasons: [],
    actionItemsAvailability: "available",
    deadlineReferenceAt: `2026-08-0${revision}T09:00:00.000Z`,
    capturedAt: `2026-08-0${revision}T09:05:00.000Z`
  } satisfies MeetingImportedFromSource["source"];
  const sourceVersion = `r${revision}:${source.contentHash}`;
  const sourceSections = [
    {
      section: "summary",
      sourceBlockId: "summary-block",
      excerpt: "Product sync summary"
    },
    {
      section: "action-items-and-notes",
      sourceBlockId: "action-items-block",
      excerpt: description
    },
    {
      section: "transcript",
      sourceBlockId: "transcript-block",
      excerpt: "Jakob discussed the Luma source import."
    }
  ] satisfies MeetingImportedFromSource["sourceSections"];
  const candidateEvidence = {
    evidenceId: `evidence:meeting-note:notion:${sourceObjectId}:r${revision}:block:${blockId}`,
    source: "knowledge",
    sourceObjectId: blockId,
    sourceVersion,
    excerpt: description,
    externalReference: source.externalReference
  } satisfies MeetingImportedFromSource["evidence"][number];
  const completion = input.completion ?? "open";
  const candidate = {
    id: `candidate:notion:${sourceObjectId}:r${revision}:block:${blockId}`,
    lineageKey: `candidate:notion:${sourceObjectId}:block:${blockId}`,
    originalText: description,
    description,
    language: "en",
    modality: input.modality ?? { kind: "commitment", sourceForm: "will" },
    completion,
    owner: input.owner ?? { state: "unmapped", sourceText: "Jakob" },
    deadline: input.deadline ?? {
      originalPhrase: "by Friday",
      normalizedDate: "2026-08-07",
      confidence: "normalized",
      timezone: "Europe/Berlin"
    },
    mentionedWorkItemReferences: input.mentionedWorkItemReferences ?? [
      {
        providerId: "linear",
        objectType: "work-item",
        externalId: "LUM-3"
      }
    ],
    projectHints: input.projectHints ?? [],
    componentHints: input.componentHints ?? [],
    source: {
      source,
      sourceBlockId: blockId,
      sourceSection: "action-items-and-notes",
      sourceExcerpt: description
    },
    evidence: [candidateEvidence]
  } satisfies MeetingImportedFromSource["candidates"][number];
  const sectionEvidence = sourceSections.map((section) => ({
    evidenceId: `evidence:meeting-note:notion:${sourceObjectId}:r${revision}:section:${section.section}`,
    source: section.section === "transcript" ? "transcript" : "knowledge",
    sourceObjectId: section.sourceBlockId,
    sourceVersion,
    excerpt: section.excerpt,
    externalReference: source.externalReference
  })) satisfies MeetingImportedFromSource["evidence"];

  const candidates = input.emptyActionItems ? [] : [candidate];

  return {
    type: "meeting-imported-from-source",
    observationId: `meeting-note-import:notion:${sourceObjectId}:r${revision}`,
    workspaceId: workspace.workspaceId,
    meetingId: input.meetingId ?? `meeting:source:notion:${sourceObjectId}`,
    occurredAt: source.capturedAt,
    observedAt: source.capturedAt,
    source,
    sourceSections,
    actionItemBlocks: [
      ...(input.emptyActionItems
        ? []
        : [
            {
              sourceBlockId: blockId,
              excerpt: description,
              completion
            }
          ])
    ],
    evidence: [
      ...sectionEvidence,
      ...(input.emptyActionItems ? [] : [candidateEvidence])
    ],
    candidates
  };
}

async function createHarness(
  catalog?: WorkCatalog | readonly WorkCatalog[],
  input: { now?: () => Date } = {}
) {
  const database = await createPgliteDatabase();
  const catalogs = catalog ? (Array.isArray(catalog) ? catalog : [catalog]) : [];
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new NoAnalysisReasoningModel(),
    ...(catalogs.length > 0 ? { workCatalogs: catalogs } : {}),
    now: input.now ?? (() => new Date("2026-08-07T09:30:00.000Z"))
  });

  return { database, meetingIntelligence };
}

async function observeAndReview(
  meetingIntelligence: Awaited<ReturnType<typeof createHarness>>["meetingIntelligence"],
  observation: MeetingImportedFromSource
) {
  const update = await meetingIntelligence.observe({
    workspace,
    observations: [observation]
  });
  const result = await meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    meetingId: observation.meetingId,
    query: { type: "action-item-reconciliation-review" }
  });

  if (result.type !== "action-item-reconciliation-review") {
    throw new Error("expected an Action Item reconciliation review");
  }

  return { update, reviews: result.reviews };
}

async function resolveAndApproveOperationalOutcome(input: {
  meetingIntelligence: Awaited<ReturnType<typeof createHarness>>["meetingIntelligence"];
  meetingId: string;
  reviewId: string;
  observationSuffix: string;
  resolution?: ActionItemReconciliationResolution;
}) {
  const resolution = await input.meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "human-judgment-recorded",
        observationId: `human-judgment:${input.observationSuffix}`,
        workspaceId: workspace.workspaceId,
        meetingId: input.meetingId,
        occurredAt: "2026-08-08T10:00:00.000Z",
        observedAt: "2026-08-08T10:00:00.000Z",
        participantId: "person:jakob",
        judgment: {
          kind: "resolve-action-item-reconciliation",
          reviewId: input.reviewId,
          resolution: input.resolution ?? { type: "accept-proposal" }
        }
      }
    ]
  });

  if (resolution.errors.length > 0) {
    throw new Error(
      `expected Human resolution: ${resolution.errors[0]?.code ?? "unknown error"}`
    );
  }

  const snapshot = await input.meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    meetingId: input.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected Meeting snapshot");
  }

  const intent = snapshot.state.followUpIntentions.find(
    (candidate) =>
      candidate.type === "settle-operational-outcome" &&
      candidate.reconciliation.reviewId === input.reviewId
  );

  if (!intent) {
    throw new Error("expected an Operational Outcome settlement Intent");
  }

  const approval = await input.meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "follow-up-intent-approved",
        observationId: `approval:${input.observationSuffix}`,
        workspaceId: workspace.workspaceId,
        meetingId: input.meetingId,
        occurredAt: "2026-08-08T10:01:00.000Z",
        observedAt: "2026-08-08T10:01:00.000Z",
        intentId: intent.id,
        approvedBy: "person:jakob"
      }
    ]
  });

  if (approval.errors.length > 0) {
    throw new Error(`expected approval: ${approval.errors[0]?.code ?? "unknown error"}`);
  }

  return intent;
}

async function followUpIntentStatus(input: {
  meetingIntelligence: MeetingIntelligence;
  meetingId: string;
  intentId: string;
}) {
  const snapshot = await input.meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    meetingId: input.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected a Meeting snapshot");
  }

  return snapshot.state.followUpIntentions.find(
    (candidate) => candidate.id === input.intentId
  )?.status;
}

function rejectOneExecutionReceipt(delegate: MeetingIntelligence): MeetingIntelligence {
  let rejectsRemaining = 1;

  return {
    observe: (input) => {
      const includesExecutionReceipt = input.observations.some(
        (observation) => observation.type === "follow-up-execution-recorded"
      );

      if (rejectsRemaining > 0 && includesExecutionReceipt) {
        rejectsRemaining -= 1;
        return Promise.reject(new Error("simulated receipt persistence interruption"));
      }

      return delegate.observe(input);
    },
    query: (input) => delegate.query(input),
    conclude: (input) => delegate.conclude(input)
  };
}

describe("Action Item reconciliation", () => {
  it("keeps a required update manual when the configured catalog has no conditional update capability", async () => {
    const catalog = new ProgrammableWorkCatalog("linear", false);
    const observation = sourceObservation();
    const item = workItem({ dueDate: null });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected source Action Item description");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const review = await observeAndReview(meetingIntelligence, observation);
      const proposal = review.reviews[0]?.proposal;

      if (!proposal) {
        throw new Error("expected a reconciliation proposal");
      }

      expect(proposal.outcome.type).toBe("needs-clarification");
      if (proposal.outcome.type !== "needs-clarification") {
        throw new Error("expected a clarification for an unsafe tracker update");
      }
      expect(proposal.outcome.rationale).toContain("cannot conditionally update");

      const judgment = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "manual-update-capability:attempt",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T11:00:00.000Z",
            observedAt: "2026-08-08T11:00:01.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: proposal.id,
              resolution: {
                type: "select-existing",
                providerId: item.providerId,
                externalId: item.externalId,
                action: "update-existing"
              }
            }
          }
        ]
      });

      expect(judgment.acceptedObservationIds).toEqual([]);
      expect(judgment.errors[0]).toMatchObject({ code: "invalid-observation" });
    } finally {
      await database.close();
    }
  });

  it("links an exact provider-qualified work reference and preserves source and work evidence", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const item = workItem();
    const observation = sourceObservation();
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const { update, reviews } = await observeAndReview(
        meetingIntelligence,
        observation
      );
      const review = reviews[0];

      expect(update.acceptedObservationIds).toEqual([observation.observationId]);
      expect(update.revision).toBe(2);
      expect(review).toMatchObject({
        proposal: {
          candidateId: observation.candidates[0]?.id,
          candidate: {
            modality: { kind: "commitment", sourceForm: "will" },
            owner: { state: "unmapped", sourceText: "Jakob" },
            deadline: { originalPhrase: "by Friday", normalizedDate: "2026-08-07" },
            source: { sourceBlockId: "source-action" }
          },
          reviewStatus: "proposed",
          outcome: {
            type: "link-existing",
            workItem: { providerId: "linear", externalId: "LUM-3" }
          }
        },
        effectiveOutcome: {
          type: "link-existing",
          workItem: { providerId: "linear", externalId: "LUM-3" }
        }
      });
      expect(review?.proposal.matchSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "exact-id" }),
          expect.objectContaining({ kind: "semantic" }),
          expect.objectContaining({ kind: "ownership" }),
          expect.objectContaining({ kind: "activity" })
        ])
      );
      expect(review?.proposal.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "knowledge",
            sourceObjectId: "source-action"
          }),
          expect.objectContaining({ source: "work", sourceObjectId: "LUM-3" })
        ])
      );
      expect(catalog.searchCalls.map((call) => call.text)).toEqual([
        "LUM-3",
        description
      ]);
      expect(catalog.getCalls).toEqual([item.id]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot" ? snapshot.state.followUpIntentions : null
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("settles an approved link-existing reconciliation into its canonical Meeting Note without mutating Linear", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const item = workItem();
    const observation = sourceObservation();
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();
    const fenceReleases: Array<{
      workspaceId: string;
      meetingId: string;
      intentId: string;
    }> = [];

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const review = reviewed.reviews[0]?.proposal;

      if (!review) {
        throw new Error("expected an exact-link reconciliation proposal");
      }

      const resolution = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:settle-link-existing",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:00:00.000Z",
            observedAt: "2026-08-08T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: review.id,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      expect(resolution.errors).toEqual([]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      const intent =
        snapshot.type === "snapshot"
          ? snapshot.state.followUpIntentions.find(
              (candidate) => candidate.type === "settle-operational-outcome"
            )
          : undefined;

      if (!intent) {
        throw new Error("expected an operational settlement Intent");
      }

      expect(intent.reconciliation).toEqual({
        reviewId: review.id,
        candidateId: review.candidateId,
        candidateLineageKey: review.candidateLineageKey
      });
      expect(intent).not.toHaveProperty("externalReference");
      expect(intent).not.toHaveProperty("bodyMarkdown");

      const approval = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:settle-link-existing",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:01:00.000Z",
            observedAt: "2026-08-08T10:01:00.000Z",
            intentId: intent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      expect(approval.errors).toEqual([]);

      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceExecutionFence: {
          acquire: () => Promise.resolve({ status: "acquired" }),
          verifyHeldCurrent: () => Promise.resolve({ status: "current" }),
          releaseAfterReceipt: ({ workspaceId, meetingId, intentId }) => {
            fenceReleases.push({ workspaceId, meetingId, intentId });
            return Promise.resolve();
          }
        },
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome.status).toBe("succeeded");
      if (first.observation.outcome.status !== "succeeded") {
        throw new Error("expected a successful link settlement");
      }
      expect(first.observation.outcome.externalReferences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ objectType: "work-item", externalId: "LUM-3" }),
          expect.objectContaining({
            objectType: "document",
            externalId: "notion-page-product-sync"
          })
        ])
      );
      expect(writer.writes).toHaveLength(1);
      expect(fenceReleases).toEqual([
        {
          workspaceId: workspace.workspaceId,
          meetingId: observation.meetingId,
          intentId: intent.id
        }
      ]);
      expect(writer.writes[0]?.target).toMatchObject({
        providerId: "notion",
        page: { externalId: "notion-page-product-sync" },
        sourceObjectId: "notion-meeting-note",
        sourceRevision: 1
      });
      expect(writer.writes[0]?.outcome.entries[0]).toMatchObject({
        resolution: { type: "link-existing" },
        workReferences: [{ externalId: "LUM-3", objectType: "work-item" }],
        knowledgeReferences: [],
        githubReferences: [],
        unresolved: []
      });

      const second = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(second).toEqual(first);
      expect(writer.writes).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("releases a held source fence when receipt-recorded recovery finishes its terminal receipt", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const item = workItem();
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();
    const sourceObjectId = "notion-receipt-recorded-fence-release";
    const ledger = createObservedSourceLedger({ database });
    let failRelease = true;
    let releaseAttempts = 0;

    try {
      const recorded = await ledger.record({
        workspaceId: workspace.workspaceId,
        source: {
          providerId: "notion",
          sourceKind: "meeting-note",
          sourceObjectId,
          parentObjectId: "notion-page-product-sync",
          url: "https://notion.so/product-sync"
        },
        providerVersion: "2026-08-08T10:00:00.000Z",
        snapshot: {
          schemaVersion: 1,
          title: "Product sync",
          lifecycle: "ready",
          calendar: null,
          recording: null,
          sections: {
            summary: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: []
            },
            actionItemsAndNotes: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: []
            },
            transcript: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: []
            }
          },
          markdown: {
            content: "Approved source revision for receipt recovery.",
            truncated: false,
            unknownBlockIds: []
          },
          completeness: { state: "complete" }
        } satisfies RawMeetingNoteSnapshot,
        observedAt: "2026-08-08T10:00:00.000Z"
      });
      const observation = sourceObservation({
        sourceObjectId,
        revision: recorded.revision,
        contentHash: recorded.contentHash
      });
      const description = observation.candidates[0]?.description;

      if (!description) {
        throw new Error("expected a source candidate");
      }

      catalog.respondToSearch("LUM-3", [item]);
      catalog.respondToSearch(description, [item]);
      catalog.respondToGet(item.id, item);
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "receipt-recorded-fence-release"
      });
      const ledgerFence = createLedgerBackedOperationalOutcomeSourceExecutionFence({
        ledger
      });
      const fence: OperationalOutcomeSourceExecutionFence = {
        acquire: (input) => ledgerFence.acquire(input),
        verifyHeldCurrent: (input) => ledgerFence.verifyHeldCurrent(input),
        async releaseAfterReceipt(input) {
          releaseAttempts += 1;
          await ledgerFence.releaseAfterReceipt(input);

          if (failRelease) {
            throw new Error("source fence cleanup acknowledgement lost");
          }
        }
      };
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceExecutionFence: fence,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });

      await expect(
        execution.execute({
          workspace,
          meetingId: observation.meetingId,
          intentId: intent.id
        })
      ).rejects.toThrow("source fence cleanup acknowledgement lost");
      expect(writer.writes).toHaveLength(1);
      await expect(
        database.query<{
          source_revision: number;
          source_content_hash: string;
          meeting_id: string;
          intent_id: string;
        }>(
          `SELECT source_revision, source_content_hash, meeting_id, intent_id
             FROM observed_source_execution_fences
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4`,
          [workspace.workspaceId, "notion", "meeting-note", sourceObjectId]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            source_revision: recorded.revision,
            source_content_hash: recorded.contentHash,
            meeting_id: observation.meetingId,
            intent_id: intent.id
          }
        ]
      });

      failRelease = false;
      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      expect(releaseAttempts).toBe(2);
      await expect(
        database.query<{ status: string }>(
          `SELECT status
             FROM follow_up_executions
            WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3`,
          [workspace.workspaceId, observation.meetingId, intent.id]
        )
      ).resolves.toMatchObject({ rows: [{ status: "completed" }] });
      await expect(
        database.query(
          `SELECT 1
             FROM observed_source_execution_fences
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4`,
          [workspace.workspaceId, "notion", "meeting-note", sourceObjectId]
        )
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await database.close();
    }
  });

  it("refuses a ledger-superseded source before settling work or writing its outcome", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-ledger-superseded-before-settlement"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "ledger-superseded-before-settlement"
      });
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceCurrentnessVerifier: {
          verifyCurrent: () =>
            Promise.resolve({
              status: "superseded",
              message: "The observed-source ledger records a newer Meeting Note head."
            })
        },
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-source-ledger-superseded",
        retryable: false
      });
      expect(writer.writes).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("acquires the current ledger head as a fence before settling a source-bound outcome", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-source-fence-before-settlement"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();
    const fencedTargets: Array<{
      revision: number;
      contentHash: string;
      sourceObjectId: string;
    }> = [];

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "source-fence-before-settlement"
      });
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceExecutionFence: {
          acquire: ({ target }) => {
            fencedTargets.push({
              revision: target.sourceRevision,
              contentHash: target.sourceContentHash,
              sourceObjectId: target.sourceObjectId
            });
            return Promise.resolve({ status: "superseded", current: null });
          },
          verifyHeldCurrent: () => Promise.resolve({ status: "current" }),
          releaseAfterReceipt: () => Promise.resolve()
        },
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-source-ledger-superseded",
        retryable: false
      });
      expect(fencedTargets).toEqual([
        {
          revision: observation.source.sourceRevision,
          contentHash: observation.source.contentHash,
          sourceObjectId: observation.source.sourceObjectId
        }
      ]);
      expect(writer.writes).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("keeps a source-fenced settlement resumable without mutating work or its page", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-source-fence-busy-before-settlement"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "source-fence-busy-before-settlement"
      });
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceExecutionFence: {
          acquire: () =>
            Promise.resolve({
              status: "busy" as const,
              owner: {
                meetingId: "meeting:other",
                intentId: "follow-up:other:settle",
                executionLeaseId: "lease:other"
              }
            }),
          verifyHeldCurrent: () => Promise.resolve({ status: "current" }),
          releaseAfterReceipt: () => Promise.resolve()
        },
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "partially-succeeded",
        errorCode: "operational-outcome-source-execution-fenced"
      });
      expect(writer.writes).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("does not write an outcome after a blocked source scan invalidates its held fence", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-source-fence-invalidated-after-work"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();
    let heldCurrentChecks = 0;

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "source-fence-invalidated-after-work"
      });
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        operationalOutcomeSourceExecutionFence: {
          acquire: () => Promise.resolve({ status: "acquired" }),
          verifyHeldCurrent: () => {
            heldCurrentChecks += 1;
            return Promise.resolve(
              heldCurrentChecks === 1
                ? { status: "current" as const }
                : {
                    status: "superseded" as const,
                    message: "A blocked source scan observed a newer Meeting Notes root."
                  }
            );
          },
          releaseAfterReceipt: () => Promise.resolve()
        },
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-source-ledger-superseded-after-work",
        retryable: false
      });
      expect(heldCurrentChecks).toBe(2);
      expect(writer.writes).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("recovers a partial create settlement by writing only the pending Operational Outcome", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-create-outcome-recovery",
      description: "Jakob will prepare the durable Luma outcome brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, []);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const workProvider = new RecordingCreateWorkProvider();
    const writer = new RecordingOperationalOutcomeWriter(1);

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const review = reviewed.reviews[0]?.proposal;

      if (!review || review.outcome.type !== "create-new") {
        throw new Error("expected a create-new reconciliation proposal");
      }

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:recover-create-outcome",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:00:00.000Z",
            observedAt: "2026-08-08T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: review.id,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });
      const resolved = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      const intent =
        resolved.type === "snapshot"
          ? resolved.state.followUpIntentions.find(
              (candidate) => candidate.type === "settle-operational-outcome"
            )
          : undefined;

      if (!intent) {
        throw new Error("expected a create settlement Intent");
      }

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:recover-create-outcome",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:01:00.000Z",
            observedAt: "2026-08-08T10:01:00.000Z",
            intentId: intent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      const firstExecutor = createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await firstExecutor.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "partially-succeeded",
        errorCode: "operational-outcome-not-written",
        externalReferences: [
          expect.objectContaining({ objectType: "work-item", externalId: "LUM-99" })
        ]
      });
      expect(workProvider.createCalls).toHaveLength(1);
      expect(writer.writes).toHaveLength(0);

      const partialSnapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      expect(
        partialSnapshot.type === "snapshot"
          ? partialSnapshot.state.followUpIntentions.find(
              (candidate) => candidate.id === intent.id
            )?.status
          : null
      ).toBe("partially-succeeded");
      const createdMapping =
        partialSnapshot.type === "snapshot"
          ? partialSnapshot.state.actionItemReconciliationCreatedWorkMappings[0]
          : undefined;

      expect(createdMapping?.reviewId).toBe(review.id);
      expect(createdMapping?.externalReference.externalId).toBe("LUM-99");

      const secondExecutor = createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:03:00.000Z")
      });
      const recovered = await secondExecutor.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(workProvider.createCalls).toHaveLength(1);
      expect(writer.writes).toHaveLength(1);
      expect(writer.writes[0]?.outcome.entries[0]?.workReferences).toEqual([
        expect.objectContaining({ externalId: "LUM-99", objectType: "work-item" })
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects a concurrent recovery from another executor facade before it can write the same outcome", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-concurrent-outcome-recovery"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const safeFailureWriter = new RecordingOperationalOutcomeWriter(1);
    const blockingWriter = new BlockingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "concurrent-outcome-recovery"
      });
      const partial = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: safeFailureWriter,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(partial.observation.outcome.status).toBe("partially-succeeded");

      const firstRecoverer = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: blockingWriter,
        now: () => new Date("2026-08-08T10:03:00.000Z")
      });
      const secondRecoverer = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: blockingWriter,
        now: () => new Date("2026-08-08T10:03:00.000Z")
      });
      const firstRecovery = firstRecoverer.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      await blockingWriter.waitForWrite();

      await expect(
        secondRecoverer.recover({
          workspace,
          meetingId: observation.meetingId,
          intentId: intent.id
        })
      ).rejects.toThrow("already has an execution in progress");
      expect(blockingWriter.writes).toHaveLength(1);

      blockingWriter.releaseWrite();
      const recovered = await firstRecovery;

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(blockingWriter.writes).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("keeps a post-work source reread interruption resumable without writing an outcome", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-post-work-source-reread"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "post-work-source-reread"
      });
      const interrupted = createFollowUpExecution({
        database,
        meetingIntelligence:
          meetingIntelligenceWithSecondSnapshotFailure(meetingIntelligence),
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });

      const first = await interrupted.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "partially-succeeded",
        errorCode: "operational-outcome-source-check-failed"
      });
      expect(writer.writes).toEqual([]);

      const recovered = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:03:00.000Z")
      }).recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("merges a recovered settlement with a later outcome on the same source page", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const meetingId = "meeting:source:notion:aggregate-outcomes";
    const first = sourceObservation({
      sourceObjectId: "notion-root-outcome-a",
      meetingId,
      description: "Jakob will finish LUM-3 source import by Friday.",
      mentionedWorkItemReferences: [
        { providerId: "linear", objectType: "work-item", externalId: "LUM-3" }
      ]
    });
    const second = sourceObservation({
      sourceObjectId: "notion-root-outcome-b",
      meetingId,
      blockId: "source-action-b",
      description: "Jakob will prepare LUM-4 outcome documentation by Friday.",
      mentionedWorkItemReferences: [
        { providerId: "linear", objectType: "work-item", externalId: "LUM-4" }
      ]
    });
    const firstDescription = first.candidates[0]?.description;
    const secondDescription = second.candidates[0]?.description;

    if (!firstDescription || !secondDescription) {
      throw new Error("expected source Action Item descriptions");
    }

    const firstItem = workItem();
    const secondItem = workItem({
      id: "linear-issue-lum-4",
      externalId: "LUM-4",
      title: "Prepare Luma outcome documentation",
      description: "Prepare the durable Luma outcome documentation.",
      url: "https://linear.app/dayova/issue/LUM-4"
    });
    catalog.respondToSearch("LUM-3", [firstItem]);
    catalog.respondToSearch(firstDescription, [firstItem]);
    catalog.respondToGet(firstItem.id, firstItem);
    catalog.respondToSearch("LUM-4", [secondItem]);
    catalog.respondToSearch(secondDescription, [secondItem]);
    catalog.respondToGet(secondItem.id, secondItem);

    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter(1);

    try {
      const firstReview = await observeAndReview(meetingIntelligence, first);
      const firstReviewId = firstReview.reviews[0]?.proposal.id;

      if (!firstReviewId) {
        throw new Error("expected the first reconciliation review");
      }

      const firstIntent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId,
        reviewId: firstReviewId,
        observationSuffix: "aggregate-outcome-a"
      });
      const executor = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const firstExecution = await executor.execute({
        workspace,
        meetingId,
        intentId: firstIntent.id
      });

      expect(firstExecution.observation.outcome.status).toBe("partially-succeeded");
      expect(writer.writes).toHaveLength(0);

      const secondReview = await observeAndReview(meetingIntelligence, second);
      const secondCandidateId = second.candidates[0]?.id;
      const secondReviewId = secondReview.reviews.find(
        (review) => review.proposal.candidateId === secondCandidateId
      )?.proposal.id;

      if (!secondReviewId) {
        throw new Error("expected the second reconciliation review");
      }

      const secondIntent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId,
        reviewId: secondReviewId,
        observationSuffix: "aggregate-outcome-b"
      });
      const secondExecution = await executor.execute({
        workspace,
        meetingId,
        intentId: secondIntent.id
      });

      expect(secondExecution.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      expect(writer.writes[0]?.outcome.entries).toHaveLength(1);
      expect(writer.writes[0]?.outcome.entries[0]?.settlementIntentId).toBe(
        secondIntent.id
      );

      const recovered = await executor.recover({
        workspace,
        meetingId,
        intentId: firstIntent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(2);
      expect(
        writer.writes[1]?.outcome.entries.map((entry) => entry.settlementIntentId)
      ).toEqual([firstIntent.id, secondIntent.id].sort());
      expect(writer.writes[1]?.outcome.entries).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("recovers a durable create after receipt persistence stops before the outcome write", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-durable-create-recovery",
      description: "Jakob will prepare the crash-safe Luma outcome brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    catalog.respondToSearch(description, []);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const workProvider = new RecordingCreateWorkProvider();
    // The first write is positively known not to have reached Notion. The
    // following receipt interruption therefore leaves only a durable work
    // stage, which recovery must continue without creating work again.
    const writer = new RecordingOperationalOutcomeWriter(1);

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a create reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "durable-create-recovery"
      });
      const interruptedExecutor = createFollowUpExecution({
        database,
        meetingIntelligence: rejectOneExecutionReceipt(meetingIntelligence),
        workProvider,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });

      await expect(
        interruptedExecutor.execute({
          workspace,
          meetingId: observation.meetingId,
          intentId: intent.id
        })
      ).rejects.toThrow("simulated receipt persistence interruption");

      expect(workProvider.createCalls).toHaveLength(1);
      expect(writer.writes).toHaveLength(0);

      const recovered = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:03:00.000Z")
      }).recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("partially-succeeded");
      expect(workProvider.createCalls).toHaveLength(1);
      expect(writer.writes).toHaveLength(0);

      const completed = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:04:00.000Z")
      }).recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(completed.observation.outcome.status).toBe("succeeded");
      expect(workProvider.createCalls).toHaveLength(1);
      expect(writer.writes).toHaveLength(1);
      expect(writer.writes[0]?.outcome.entries[0]?.workReferences).toEqual([
        expect.objectContaining({ externalId: "LUM-99", objectType: "work-item" })
      ]);
    } finally {
      await database.close();
    }
  });

  it("fails a proven-not-applied nonretryable outcome write without retaining its page lease", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-manual-outcome-recovery"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "manual-outcome-recovery"
      });
      const execution = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: new ManualFailureOperationalOutcomeWriter(),
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(execution.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-not-writable",
        retryable: false
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      const currentIntent =
        snapshot.type === "snapshot"
          ? snapshot.state.followUpIntentions.find(
              (candidate) => candidate.id === intent.id
            )
          : undefined;

      expect(currentIntent?.status).toBe("failed");
    } finally {
      await database.close();
    }
  });

  it("releases an orphaned prewrite stage only when its durable no-write proof is present", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-orphaned-prewrite-no-write"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new DelayedPositiveRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "orphaned-prewrite-no-write"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });

      // Model a real cleanup failure after the runner durably recorded that
      // no provider call had started. The original manual receipt establishes
      // that this old stage lease is orphaned; the exact provider-confirmed
      // code is the only fact that permits automatic release.
      const oldStageLeaseId = "orphaned-prewrite-no-write-stage";
      await database.query(
        `UPDATE operational_outcome_settlement_stages
            SET status = 'executing', execution_lease_id = $4,
                prepared_outcome_json = NULL, prepared_operation_token = NULL,
                payload_digest = NULL, content_digest = NULL, operation_digest = NULL,
                last_error_code = $5,
                last_error_message = $6
          WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
            AND stage = 'outcome'`,
        [
          workspace.workspaceId,
          observation.meetingId,
          intent.id,
          oldStageLeaseId,
          "operational-outcome-prewrite-provider-not-started",
          "outcome rendering stopped before writer.upsert"
        ]
      );
      await database.query(
        `UPDATE operational_outcome_page_leases
            SET execution_lease_id = $4
          WHERE source_provider_id = $1 AND source_document_id = $2
            AND workspace_id = $3`,
        [
          "notion",
          observation.source.externalReference.externalId,
          workspace.workspaceId,
          oldStageLeaseId
        ]
      );
      writer.writes.length = 0;
      writer.probes.length = 0;

      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("partially-succeeded");
      if (recovered.observation.outcome.status !== "partially-succeeded") {
        throw new Error("expected the proven prewrite interruption to be resumable");
      }
      expect(recovered.observation.outcome.errorCode).toBe(
        "operational-outcome-prewrite-failed"
      );
      expect(writer.writes).toEqual([]);
      expect(writer.probes).toEqual([]);
      const releasedLease = await database.query(
        `SELECT 1
           FROM operational_outcome_page_leases
          WHERE source_provider_id = 'notion'
            AND source_document_id = $1`,
        [observation.source.externalReference.externalId]
      );
      expect(releasedLease.rows).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("abandons a prepared manual prewrite stage without probing or rewriting its page", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-prepared-prewrite-abandon"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new DelayedPositiveRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "prepared-prewrite-abandon"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });

      // Simulate a lost acknowledgement after aggregate preparation followed
      // by a local cleanup failure. `writer.upsert` was not reached in this
      // modeled state, so this exact durable code—not the visible prepared
      // payload—authorizes clearing it and releasing the old lease.
      await database.query(
        `UPDATE operational_outcome_settlement_stages
            SET status = 'requires-manual-recovery', execution_lease_id = NULL,
                last_error_code = $4, last_error_message = $5
          WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
            AND stage = 'outcome'`,
        [
          workspace.workspaceId,
          observation.meetingId,
          intent.id,
          "operational-outcome-prewrite-cleanup-unknown",
          "aggregate preparation stopped before writer.upsert and cleanup acknowledgement failed"
        ]
      );
      writer.writes.length = 0;
      writer.probes.length = 0;

      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-prewrite-abandoned",
        retryable: false
      });
      expect(writer.writes).toEqual([]);
      expect(writer.probes).toEqual([]);
      const releasedLease = await database.query(
        `SELECT 1
           FROM operational_outcome_page_leases
          WHERE source_provider_id = 'notion'
            AND source_document_id = $1`,
        [observation.source.externalReference.externalId]
      );
      expect(releasedLease.rows).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("uses explicit recovery only to positively confirm and release an unknown prepared page write after source supersession", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const sourceObjectId = "notion-positive-manual-outcome-recovery";
    const observation = sourceObservation({
      sourceObjectId
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new DelayedPositiveRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "positive-manual-outcome-recovery"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "provider-outcome-unknown",
        requiresManualRecovery: true
      });
      expect(writer.writes).toHaveLength(1);
      expect(writer.probes).toHaveLength(1);

      const beforeRecovery = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      expect(
        beforeRecovery.type === "snapshot"
          ? beforeRecovery.state.followUpIntentions.find(
              (candidate) => candidate.id === intent.id
            )?.status
          : null
      ).toBe("requires-manual-recovery");

      const superseding = await meetingIntelligence.observe({
        workspace,
        observations: [
          sourceObservation({
            sourceObjectId,
            meetingId: observation.meetingId,
            revision: 2,
            contentHash: "sha256:positive-manual-outcome-recovery-r2",
            emptyActionItems: true
          })
        ]
      });

      expect(superseding.errors).toEqual([]);

      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "source-superseded-during-recovery",
        retryable: false
      });
      expect(writer.writes).toHaveLength(1);
      expect(writer.probes).toHaveLength(2);
      const releasedLease = await database.query(
        `SELECT 1
           FROM operational_outcome_page_leases
          WHERE source_provider_id = 'notion'
            AND source_document_id = $1`,
        [observation.source.externalReference.externalId]
      );
      expect(releasedLease.rows).toEqual([]);
      const afterRecovery = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      expect(
        afterRecovery.type === "snapshot"
          ? afterRecovery.state.followUpIntentions.find(
              (candidate) => candidate.id === intent.id
            )?.status
          : null
      ).toBe("failed");
    } finally {
      await database.close();
    }
  });

  it("does not supersede a source while a manual settlement recovery is probing its output", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const sourceObjectId = "notion-manual-recovery-supersession-fence";
    const observation = sourceObservation({ sourceObjectId });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new BlockingManualRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "manual-recovery-supersession-fence"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });

      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });
      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });

      const recovering = execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });
      await writer.waitForManualProbe();

      const superseding = await meetingIntelligence.observe({
        workspace,
        observations: [
          sourceObservation({
            sourceObjectId,
            meetingId: observation.meetingId,
            revision: 2,
            contentHash: "sha256:manual-recovery-supersession-fence-r2",
            emptyActionItems: true
          })
        ]
      });

      expect(superseding.acceptedObservationIds).toEqual([]);
      expect(superseding.errors[0]).toMatchObject({
        code: "concurrent-update",
        retryable: true
      });

      writer.releaseManualProbe();
      const recovered = await recovering;

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("uses only an exact marker probe to recover an orphaned prepared output stage", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-orphaned-prepared-output"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new DelayedPositiveRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "orphaned-prepared-output"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });

      // Simulate a crash after the provider call where durable terminalization
      // did not receive its acknowledgement. The previous outer receipt is
      // already manual, so this lease is demonstrably orphaned—not live.
      await database.query(
        `UPDATE operational_outcome_settlement_stages
            SET status = 'executing', execution_lease_id = $4
          WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
            AND stage = 'outcome'`,
        [
          workspace.workspaceId,
          observation.meetingId,
          intent.id,
          "orphaned-output-stage-lease"
        ]
      );

      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      expect(writer.probes).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("records a receipt for a durably completed manual output without replaying its marker probe", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-manual-output-receipt-recovery"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new DelayedPositiveRecoveryOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = reviewed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation review");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId,
        observationSuffix: "manual-output-receipt-recovery"
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const first = await execution.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        requiresManualRecovery: true
      });

      // Simulate a process stop after the manual exact proof committed its
      // stage/lease transaction but before Meeting Intelligence accepted the
      // corresponding receipt.
      await database.query(
        `UPDATE operational_outcome_settlement_stages
            SET status = 'succeeded', execution_lease_id = NULL,
                reference_json = $4
          WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
            AND stage = 'outcome'`,
        [
          workspace.workspaceId,
          observation.meetingId,
          intent.id,
          JSON.stringify([observation.source.externalReference])
        ]
      );
      await database.query(
        `UPDATE follow_up_executions
            SET status = 'executing', result_json = NULL,
                execution_lease_id = 'manual-output-receipt-interrupted'
          WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
            AND operation = 'execute'`,
        [workspace.workspaceId, observation.meetingId, intent.id]
      );

      const recovered = await execution.recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      expect(writer.probes).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("proposes new work only after a completed zero-result canonical search", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, []);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const { reviews } = await observeAndReview(meetingIntelligence, observation);

      expect(reviews[0]).toMatchObject({
        proposal: {
          outcome: {
            type: "create-new"
          },
          searches: [
            {
              providerId: "linear",
              query: description,
              status: "completed",
              workItems: [],
              failure: null
            }
          ]
        },
        effectiveOutcome: { type: "create-new" }
      });
      expect(catalog.searchCalls).toHaveLength(1);
      expect(catalog.getCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("keeps incomplete source content and unavailable catalogs reviewable rather than proposing work", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const partial = sourceObservation({ completeness: "partial" });
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const partialReview = await observeAndReview(meetingIntelligence, partial);

      expect(partialReview.reviews[0]?.effectiveOutcome).toEqual({
        type: "needs-clarification",
        rationale:
          "The imported source is incomplete or its Action Items are unavailable."
      });
      expect(catalog.searchCalls).toEqual([]);

      const withoutCatalog = await createHarness();

      try {
        const missingCatalog = await observeAndReview(
          withoutCatalog.meetingIntelligence,
          sourceObservation({
            description: "Jakob will prepare the Luma reconciliation brief by Friday.",
            mentionedWorkItemReferences: []
          })
        );

        expect(missingCatalog.reviews[0]).toMatchObject({
          effectiveOutcome: { type: "needs-clarification" },
          proposal: {
            searches: [
              expect.objectContaining({
                status: "not-configured",
                failure: "catalog-not-configured"
              })
            ]
          }
        });
      } finally {
        await withoutCatalog.database.close();
      }
    } finally {
      await database.close();
    }
  });

  it("turns Human Judgment on a create proposal into one opaque operational settlement Intent, not a provider write", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma Human Judgment brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, []);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const proposed = await observeAndReview(meetingIntelligence, observation);
      const reviewId = proposed.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a create-work proposal");
      }

      const resolution = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:accept-create-proposal",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-07T10:00:00.000Z",
            observedAt: "2026-08-07T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      expect(resolution.events).toEqual([
        {
          type: "follow-up-awaiting-approval",
          intentIds: [
            `follow-up-intent:reconciliation:${encodeURIComponent(reviewId)}:settle`
          ]
        }
      ]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot" ? snapshot.state.followUpIntentions : []
      ).toEqual([
        expect.objectContaining({
          type: "settle-operational-outcome",
          status: "suggested",
          reconciliation: {
            reviewId,
            candidateId: observation.candidates[0]?.id,
            candidateLineageKey: observation.candidates[0]?.lineageKey
          }
        })
      ]);
      expect(catalog.searchCalls).toHaveLength(1);
      expect(catalog.getCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("treats catalog reads, retrieval failures, and matching ties as clarifications", async () => {
    const failedCatalog = new ProgrammableWorkCatalog();
    const failedObservation = sourceObservation({
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const failedDescription = failedObservation.candidates[0]?.description;

    if (!failedDescription) {
      throw new Error("expected a source candidate");
    }

    failedCatalog.respondToSearch(failedDescription, new Error("offline"));
    const failedHarness = await createHarness(failedCatalog);

    try {
      const failed = await observeAndReview(
        failedHarness.meetingIntelligence,
        failedObservation
      );

      expect(failed.reviews[0]).toMatchObject({
        effectiveOutcome: { type: "needs-clarification" },
        proposal: { searches: [expect.objectContaining({ status: "failed" })] }
      });
    } finally {
      await failedHarness.database.close();
    }

    const retrievalCatalog = new ProgrammableWorkCatalog();
    const retrievalObservation = sourceObservation({
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const retrievalDescription = retrievalObservation.candidates[0]?.description;

    if (!retrievalDescription) {
      throw new Error("expected a source candidate");
    }

    const unreadable = workItem({
      id: "linear-issue-unreadable",
      externalId: "LUM-32",
      title: "Prepare Luma reconciliation brief"
    });
    retrievalCatalog.respondToSearch(retrievalDescription, [unreadable]);
    retrievalCatalog.respondToGet(unreadable.id, new Error("not readable"));
    const retrievalHarness = await createHarness(retrievalCatalog);

    try {
      const retrieval = await observeAndReview(
        retrievalHarness.meetingIntelligence,
        retrievalObservation
      );

      expect(retrieval.reviews[0]).toMatchObject({
        effectiveOutcome: { type: "needs-clarification" },
        proposal: { searches: [expect.objectContaining({ status: "failed" })] }
      });
      expect(retrievalCatalog.getCalls).toEqual([unreadable.id]);
    } finally {
      await retrievalHarness.database.close();
    }

    const tiedCatalog = new ProgrammableWorkCatalog();
    const tiedObservation = sourceObservation({
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const tiedDescription = tiedObservation.candidates[0]?.description;

    if (!tiedDescription) {
      throw new Error("expected a source candidate");
    }

    const first = workItem({
      id: "linear-issue-a",
      externalId: "LUM-30",
      title: "Prepare Luma reconciliation brief",
      description: "Prepare the Luma reconciliation brief.",
      dueDate: "2026-08-07"
    });
    const second = workItem({
      id: "linear-issue-b",
      externalId: "LUM-31",
      title: first.title,
      description: first.description,
      dueDate: "2026-08-07"
    });
    tiedCatalog.respondToSearch(tiedDescription, [second, first]);
    tiedCatalog.respondToGet(first.id, first);
    tiedCatalog.respondToGet(second.id, second);
    const tiedHarness = await createHarness(tiedCatalog);

    try {
      const tied = await observeAndReview(
        tiedHarness.meetingIntelligence,
        tiedObservation
      );

      expect(tied.reviews[0]?.effectiveOutcome).toMatchObject({
        type: "needs-clarification"
      });
      expect(tiedCatalog.getCalls).toEqual([first.id, second.id]);
    } finally {
      await tiedHarness.database.close();
    }
  });

  it("records project, component, owner, activity, and prior-lineage mapping signals", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const first = sourceObservation({
      description:
        "Jakob will finish the backend Luma source import for project-luma by Friday.",
      mentionedWorkItemReferences: [],
      projectHints: ["project-luma"],
      componentHints: ["backend"]
    });
    const firstDescription = first.candidates[0]?.description;

    if (!firstDescription) {
      throw new Error("expected a source candidate");
    }

    const item = workItem({
      title: "Finish Luma source import",
      description: "Finish the Luma source import.",
      dueDate: "2026-08-07"
    });
    catalog.respondToSearch(firstDescription, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const initial = await observeAndReview(meetingIntelligence, first);

      expect(initial.reviews[0]?.effectiveOutcome).toMatchObject({
        type: "link-existing"
      });
      expect(
        initial.reviews[0]?.proposal.matchSignals.map((signal) => signal.kind)
      ).toEqual(
        expect.arrayContaining([
          "semantic",
          "project",
          "component",
          "ownership",
          "activity"
        ])
      );

      const firstReviewId = initial.reviews[0]?.proposal.id;

      if (!firstReviewId) {
        throw new Error("expected an initial reconciliation proposal");
      }

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:accept-first-source-import",
            workspaceId: workspace.workspaceId,
            meetingId: first.meetingId,
            occurredAt: "2026-08-07T09:31:00.000Z",
            observedAt: "2026-08-07T09:31:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: firstReviewId,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      const second = sourceObservation({
        revision: 2,
        contentHash: "sha256:source-r2",
        description:
          "Jakob will finish the backend Luma source import for project-luma by next Friday.",
        mentionedWorkItemReferences: [],
        projectHints: ["project-luma"],
        componentHints: ["backend"],
        deadline: {
          originalPhrase: "by next Friday",
          normalizedDate: "2026-08-14",
          confidence: "normalized",
          timezone: "Europe/Berlin"
        }
      });
      const secondDescription = second.candidates[0]?.description;

      if (!secondDescription) {
        throw new Error("expected a revised source candidate");
      }

      catalog.respondToSearch(secondDescription, [item]);
      const revised = await observeAndReview(meetingIntelligence, second);

      expect(revised.reviews).toHaveLength(1);
      expect(revised.reviews[0]).toMatchObject({
        effectiveOutcome: {
          type: "update-existing",
          workItem: { externalId: "LUM-3" }
        }
      });
      expect(revised.reviews[0]?.proposal.matchSignals).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "prior-mapping" })])
      );

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: first.meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot" ? snapshot.state.actionItemReconciliationReviews : []
      ).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("does not repeat catalog work or create another proposal when a source import is retried", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation();
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    const item = workItem();
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      await observeAndReview(meetingIntelligence, observation);
      const searchCallsAfterFirstImport = [...catalog.searchCalls];
      const retry = await observeAndReview(meetingIntelligence, observation);

      expect(retry.update.acceptedObservationIds).toEqual([]);
      expect(retry.update.duplicateObservationIds).toEqual([observation.observationId]);
      expect(retry.reviews).toHaveLength(1);
      expect(catalog.searchCalls).toEqual(searchCallsAfterFirstImport);
    } finally {
      await database.close();
    }
  });

  it("marks competing source candidates for one work item as needing Human Judgment", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation();
    const firstCandidate = observation.candidates[0];
    const firstEvidence = firstCandidate?.evidence[0];

    if (!firstCandidate || !firstEvidence) {
      throw new Error("expected a source candidate and Evidence");
    }

    const secondBlockId = "source-action-duplicate";
    const secondEvidence = {
      ...firstEvidence,
      evidenceId:
        "evidence:meeting-note:notion:notion-meeting-note:r1:block:source-action-duplicate",
      sourceObjectId: secondBlockId
    };
    const secondCandidate = {
      ...firstCandidate,
      id: "candidate:notion:notion-meeting-note:r1:block:source-action-duplicate",
      lineageKey: "candidate:notion:notion-meeting-note:block:source-action-duplicate",
      source: {
        ...firstCandidate.source,
        sourceBlockId: secondBlockId
      },
      evidence: [secondEvidence]
    } satisfies MeetingImportedFromSource["candidates"][number];
    const competing = {
      ...observation,
      actionItemBlocks: [
        ...observation.actionItemBlocks,
        {
          sourceBlockId: secondBlockId,
          excerpt: secondCandidate.source.sourceExcerpt,
          completion: "open"
        }
      ],
      evidence: [...observation.evidence, secondEvidence],
      candidates: [firstCandidate, secondCandidate]
    } satisfies MeetingImportedFromSource;
    const item = workItem();
    const description = firstCandidate.description;

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const { reviews } = await observeAndReview(meetingIntelligence, competing);

      expect(reviews).toHaveLength(2);
      expect(reviews.map((review) => review.effectiveOutcome.type)).toEqual([
        "needs-clarification",
        "needs-clarification"
      ]);
      expect(reviews.map((review) => review.effectiveOutcome.rationale)).toEqual([
        "Another current source candidate proposes the same work target or new-work draft.",
        "Another current source candidate proposes the same work target or new-work draft."
      ]);
    } finally {
      await database.close();
    }
  });

  it("reclassifies current proposals when a later source import targets the same work item", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const meetingId = "meeting:source:notion:combined-product-sync";
    const first = sourceObservation({ sourceObjectId: "notion-note-a", meetingId });
    const second = sourceObservation({ sourceObjectId: "notion-note-b", meetingId });
    const item = workItem();
    const description = first.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const initial = await observeAndReview(meetingIntelligence, first);

      expect(initial.reviews[0]?.effectiveOutcome.type).toBe("link-existing");

      const later = await observeAndReview(meetingIntelligence, second);

      expect(later.reviews).toHaveLength(2);
      expect(later.reviews.map((review) => review.effectiveOutcome.type)).toEqual([
        "needs-clarification",
        "needs-clarification"
      ]);
      expect(later.reviews.map((review) => review.effectiveOutcome.rationale)).toEqual([
        "Another current source candidate proposes the same work target or new-work draft.",
        "Another current source candidate proposes the same work target or new-work draft."
      ]);
    } finally {
      await database.close();
    }
  });

  it("retries a failed canonical catalog read only after its durable retry time", async () => {
    const catalog = new ProgrammableWorkCatalog();
    let currentTime = new Date("2026-08-07T09:30:00.000Z");
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, new Error("temporarily unavailable"));
    const { database, meetingIntelligence } = await createHarness(catalog, {
      now: () => currentTime
    });

    try {
      const initial = await observeAndReview(meetingIntelligence, observation);

      expect(initial.reviews[0]).toMatchObject({
        proposal: {
          attempt: 1,
          trigger: "initial-source-import",
          retryable: true,
          automaticRetryNotBefore: "2026-08-07T09:31:00.000Z",
          searches: [expect.objectContaining({ status: "failed" })]
        },
        effectiveOutcome: { type: "needs-clarification" }
      });

      const item = workItem({
        title: "Prepare Luma reconciliation brief",
        description: "Prepare the Luma reconciliation brief."
      });
      catalog.respondToSearch(description, [item]);
      catalog.respondToGet(item.id, item);

      const beforeRetryIsDue = await observeAndReview(meetingIntelligence, observation);

      expect(beforeRetryIsDue.reviews[0]?.proposal).toMatchObject({
        attempt: 1,
        automaticRetryNotBefore: "2026-08-07T09:31:00.000Z"
      });
      expect(catalog.searchCalls).toHaveLength(1);

      currentTime = new Date("2026-08-07T09:31:00.000Z");
      const recovered = await observeAndReview(meetingIntelligence, observation);

      expect(recovered.update.duplicateObservationIds).toEqual([
        observation.observationId
      ]);
      expect(recovered.reviews[0]).toMatchObject({
        proposal: {
          attempt: 2,
          trigger: "catalog-retry",
          retryable: false,
          automaticRetryNotBefore: null
        },
        effectiveOutcome: { type: "link-existing" }
      });

      const history = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "action-item-reconciliation-history" }
      });

      if (history.type !== "action-item-reconciliation-history") {
        throw new Error("expected reconciliation history");
      }

      expect(history.reviews).toHaveLength(2);
      expect(history.reviews.map((review) => review.outcome.type)).toEqual([
        "needs-clarification",
        "link-existing"
      ]);
      expect(history.reviews[0]?.searches[0]?.status).toBe("failed");

      const searchCallsAfterRecovery = [...catalog.searchCalls];
      await observeAndReview(meetingIntelligence, observation);
      expect(catalog.searchCalls).toEqual(searchCallsAfterRecovery);
    } finally {
      await database.close();
    }
  });

  it("increases catalog retry delays exponentially and caps them at one hour", async () => {
    const catalog = new ProgrammableWorkCatalog();
    let currentTime = new Date("2026-08-07T09:30:00.000Z");
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma retry backoff brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, new Error("temporarily unavailable"));
    const { database, meetingIntelligence } = await createHarness(catalog, {
      now: () => currentTime
    });

    try {
      const initial = await observeAndReview(meetingIntelligence, observation);
      let proposal = initial.reviews[0]?.proposal;

      if (!proposal) {
        throw new Error("expected an initial reconciliation proposal");
      }

      const expectedDelayMinutes = [1, 2, 4, 8, 16, 32, 60, 60];

      for (const [
        index,
        expectedDelayMinutesForAttempt
      ] of expectedDelayMinutes.entries()) {
        const retryNotBefore = proposal.automaticRetryNotBefore;

        if (!retryNotBefore) {
          throw new Error("expected a durable retry time for a failed catalog read");
        }

        expect(proposal.attempt).toBe(index + 1);
        expect(Date.parse(retryNotBefore) - currentTime.getTime()).toBe(
          expectedDelayMinutesForAttempt * 60_000
        );

        if (index === expectedDelayMinutes.length - 1) {
          break;
        }

        const retryAt = new Date(retryNotBefore);
        currentTime = new Date(retryAt.getTime() - 1);
        const premature = await observeAndReview(meetingIntelligence, observation);

        expect(premature.reviews[0]?.proposal.attempt).toBe(index + 1);
        expect(catalog.searchCalls).toHaveLength(index + 1);

        currentTime = retryAt;
        const retry = await observeAndReview(meetingIntelligence, observation);
        proposal = retry.reviews[0]?.proposal;

        if (!proposal) {
          throw new Error("expected a retry reconciliation proposal");
        }
      }

      expect(catalog.searchCalls).toHaveLength(expectedDelayMinutes.length);
    } finally {
      await database.close();
    }
  });

  it("lets a Human refresh bypass a pending automatic catalog retry", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const currentTime = new Date("2026-08-07T09:30:00.000Z");
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma manual refresh brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch(description, new Error("temporarily unavailable"));
    const { database, meetingIntelligence } = await createHarness(catalog, {
      now: () => currentTime
    });

    try {
      const initial = await observeAndReview(meetingIntelligence, observation);
      const reviewId = initial.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a failed catalog reconciliation proposal");
      }

      const item = workItem({
        title: "Prepare Luma manual refresh brief",
        description: "Prepare the Luma manual refresh brief."
      });
      catalog.respondToSearch(description, [item]);
      catalog.respondToGet(item.id, item);

      const refreshed = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:refresh-pending-catalog-read",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-07T09:30:30.000Z",
            observedAt: "2026-08-07T09:30:30.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "refresh-action-item-reconciliation",
              reviewId
            }
          }
        ]
      });

      expect(refreshed.acceptedObservationIds).toEqual([
        "human-judgment:refresh-pending-catalog-read"
      ]);
      expect(catalog.searchCalls).toHaveLength(2);

      const result = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "action-item-reconciliation-review" }
      });

      if (result.type !== "action-item-reconciliation-review") {
        throw new Error("expected an Action Item reconciliation review");
      }

      expect(result.reviews[0]).toMatchObject({
        proposal: {
          attempt: 2,
          trigger: "human-refresh",
          automaticRetryNotBefore: null
        },
        effectiveOutcome: { type: "link-existing" }
      });

      const retry = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:refresh-pending-catalog-read",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-07T09:30:30.000Z",
            observedAt: "2026-08-07T09:30:30.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "refresh-action-item-reconciliation",
              reviewId
            }
          }
        ]
      });

      expect(retry.acceptedObservationIds).toEqual([]);
      expect(retry.duplicateObservationIds).toEqual([
        "human-judgment:refresh-pending-catalog-read"
      ]);
      expect(catalog.searchCalls).toHaveLength(2);

      const history = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "action-item-reconciliation-history" }
      });

      expect(
        history.type === "action-item-reconciliation-history" ? history.reviews : []
      ).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("retries an unconfigured catalog immediately when that catalog is later configured", async () => {
    const currentTime = new Date("2026-08-07T09:30:00.000Z");
    const observation = sourceObservation({
      description: "Jakob will prepare the Luma catalog configuration brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const { database, meetingIntelligence } = await createHarness(undefined, {
      now: () => currentTime
    });

    try {
      const unconfigured = await observeAndReview(meetingIntelligence, observation);

      expect(unconfigured.reviews[0]?.proposal).toMatchObject({
        attempt: 1,
        retryable: true,
        automaticRetryNotBefore: null,
        searches: [expect.objectContaining({ status: "not-configured" })]
      });

      const catalog = new ProgrammableWorkCatalog();
      const description = observation.candidates[0]?.description;

      if (!description) {
        throw new Error("expected a source candidate");
      }

      const item = workItem({
        title: "Prepare Luma catalog configuration brief",
        description: "Prepare the Luma catalog configuration brief."
      });
      catalog.respondToSearch(description, [item]);
      catalog.respondToGet(item.id, item);
      const configuredMeetingIntelligence = createMeetingIntelligence({
        database,
        reasoningModel: new NoAnalysisReasoningModel(),
        workCatalogs: [catalog],
        now: () => currentTime
      });

      const configured = await observeAndReview(
        configuredMeetingIntelligence,
        observation
      );

      expect(configured.reviews[0]).toMatchObject({
        proposal: {
          attempt: 2,
          trigger: "catalog-retry",
          automaticRetryNotBefore: null
        },
        effectiveOutcome: { type: "link-existing" }
      });
      expect(catalog.searchCalls).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("coalesces concurrent duplicate imports before reading the Work Catalog", async () => {
    const catalog = new DeferredSearchWorkCatalog();
    const observation = sourceObservation();
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const first = meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });
      await catalog.waitForFirstSearch();
      const second = meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });
      catalog.release();

      const [firstUpdate, secondUpdate] = await Promise.all([first, second]);

      expect([
        firstUpdate.acceptedObservationIds,
        secondUpdate.acceptedObservationIds
      ]).toEqual(expect.arrayContaining([[observation.observationId]]));
      expect(catalog.searchCalls.map((call) => call.text)).toEqual([
        "LUM-3",
        description
      ]);
      expect(catalog.getCalls).toEqual(["linear-issue-lum-3"]);
    } finally {
      await database.close();
    }
  });

  it("keeps conflicting proposals immutable and restores the sole remaining current proposal", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const meetingId = "meeting:source:notion:conflict-recovery";
    const first = sourceObservation({ sourceObjectId: "notion-note-a", meetingId });
    const second = sourceObservation({ sourceObjectId: "notion-note-b", meetingId });
    const item = workItem();
    const description = first.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      await observeAndReview(meetingIntelligence, first);
      const conflicted = await observeAndReview(meetingIntelligence, second);

      expect(conflicted.reviews.map((review) => review.status)).toEqual([
        "blocked-by-conflict",
        "blocked-by-conflict"
      ]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot"
          ? snapshot.state.actionItemReconciliationReviews.map(
              (review) => review.outcome.type
            )
          : []
      ).toEqual(["link-existing", "link-existing"]);

      const searchCallsBeforeSourceSupersession = [...catalog.searchCalls];
      const emptyReplacement = sourceObservation({
        sourceObjectId: "notion-note-a",
        meetingId,
        revision: 2,
        contentHash: "sha256:notion-note-a-r2-empty",
        emptyActionItems: true
      });
      const recovered = await observeAndReview(meetingIntelligence, emptyReplacement);

      expect(recovered.reviews).toHaveLength(1);
      expect(recovered.reviews[0]).toMatchObject({
        status: "proposed",
        effectiveOutcome: { type: "link-existing" }
      });
      expect(catalog.searchCalls).toEqual(searchCallsBeforeSourceSupersession);
    } finally {
      await database.close();
    }
  });

  it("allows one Human update resolution for a conflict, blocks a sibling, and writes only the grounded due-date delta", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation();
    const firstCandidate = observation.candidates[0];
    const firstEvidence = firstCandidate?.evidence[0];

    if (!firstCandidate || !firstEvidence) {
      throw new Error("expected a source candidate and Evidence");
    }

    const secondBlockId = "source-action-human-resolution";
    const secondEvidence = {
      ...firstEvidence,
      evidenceId:
        "evidence:meeting-note:notion:notion-meeting-note:r1:block:source-action-human-resolution",
      sourceObjectId: secondBlockId
    };
    const secondCandidate = {
      ...firstCandidate,
      id: "candidate:notion:notion-meeting-note:r1:block:source-action-human-resolution",
      lineageKey:
        "candidate:notion:notion-meeting-note:block:source-action-human-resolution",
      source: { ...firstCandidate.source, sourceBlockId: secondBlockId },
      evidence: [secondEvidence]
    } satisfies MeetingImportedFromSource["candidates"][number];
    const competing = {
      ...observation,
      actionItemBlocks: [
        ...observation.actionItemBlocks,
        {
          sourceBlockId: secondBlockId,
          excerpt: secondCandidate.source.sourceExcerpt,
          completion: "open"
        }
      ],
      evidence: [...observation.evidence, secondEvidence],
      candidates: [firstCandidate, secondCandidate]
    } satisfies MeetingImportedFromSource;
    const item = workItem({ dueDate: null });

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(firstCandidate.description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const conflicted = await observeAndReview(meetingIntelligence, competing);
      const selectedReviewId = conflicted.reviews[0]?.proposal.id;

      if (!selectedReviewId) {
        throw new Error("expected a conflicted proposal");
      }

      const judgment = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:resolve-conflicted-proposal",
            workspaceId: workspace.workspaceId,
            meetingId: competing.meetingId,
            occurredAt: "2026-08-07T10:00:00.000Z",
            observedAt: "2026-08-07T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: selectedReviewId,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      expect(judgment.acceptedObservationIds).toEqual([
        "human-judgment:resolve-conflicted-proposal"
      ]);
      const query = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: competing.meetingId,
        query: { type: "action-item-reconciliation-review" }
      });

      if (query.type !== "action-item-reconciliation-review") {
        throw new Error("expected reconciliation review results");
      }

      const resolved = { reviews: query.reviews };

      const selected = resolved.reviews.find(
        (review) => review.proposal.id === selectedReviewId
      );
      const remaining = resolved.reviews.find(
        (review) => review.proposal.id !== selectedReviewId
      );

      expect(selected).toMatchObject({
        status: "human-resolved",
        effectiveOutcome: { type: "update-existing" }
      });
      expect(selected?.humanResolution?.participantId).toBe("person:jakob");
      expect(selected?.humanResolution?.evidence.source).toBe("human-judgment");
      expect(remaining).toMatchObject({ status: "blocked-by-conflict" });

      const remainingReviewId = remaining?.proposal.id;

      if (!remainingReviewId) {
        throw new Error("expected a conflicting sibling proposal");
      }

      const secondJudgment = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:resolve-conflicting-sibling",
            workspaceId: workspace.workspaceId,
            meetingId: competing.meetingId,
            occurredAt: "2026-08-07T10:01:00.000Z",
            observedAt: "2026-08-07T10:01:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: remainingReviewId,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      expect(secondJudgment.acceptedObservationIds).toEqual([]);
      expect(secondJudgment.errors[0]).toMatchObject({
        code: "invalid-observation"
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: competing.meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot"
          ? snapshot.state.actionItemReconciliationHumanResolutions
          : []
      ).toHaveLength(1);
      const updateIntent =
        snapshot.type === "snapshot"
          ? snapshot.state.followUpIntentions.find(
              (intent) => intent.type === "settle-operational-outcome"
            )
          : undefined;

      if (!updateIntent) {
        throw new Error("expected a Human-resolved operational settlement Intent");
      }

      expect(
        snapshot.type === "snapshot" ? snapshot.state.followUpIntentions : []
      ).toHaveLength(1);
      expect(updateIntent.status).toBe("suggested");
      expect(updateIntent.reconciliation.reviewId).toBe(selectedReviewId);
      expect(updateIntent).not.toHaveProperty("description");

      const approval = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:human-resolved-update",
            workspaceId: workspace.workspaceId,
            meetingId: competing.meetingId,
            occurredAt: "2026-08-07T10:02:00.000Z",
            observedAt: "2026-08-07T10:02:00.000Z",
            intentId: updateIntent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      expect(approval.acceptedObservationIds).toEqual(["approval:human-resolved-update"]);

      const forgedReceipt = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-execution-recorded",
            observationId: "forged:human-resolved-update",
            workspaceId: workspace.workspaceId,
            meetingId: competing.meetingId,
            occurredAt: "2026-08-07T10:02:30.000Z",
            observedAt: "2026-08-07T10:02:30.000Z",
            intentId: updateIntent.id,
            executionLeaseId: "forged-lease",
            outcome: {
              status: "succeeded",
              externalReferences: [],
              summary: "forged"
            }
          }
        ]
      });

      expect(forgedReceipt.acceptedObservationIds).toEqual([]);
      expect(forgedReceipt.errors[0]).toMatchObject({
        code: "invalid-observation"
      });

      const workProvider = new RecordingWorkProvider(item);
      const operationalOutcomeWriter = new RecordingOperationalOutcomeWriter();
      const execution = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        operationalOutcomeWriter,
        now: () => new Date("2026-08-07T10:03:00.000Z")
      }).execute({
        workspace,
        meetingId: competing.meetingId,
        intentId: updateIntent.id
      });

      expect(execution.observation.outcome.status).toBe("succeeded");
      expect(workProvider.updateCalls).toEqual([
        {
          id: item.id,
          input: {
            dueDate: "2026-08-07",
            expectedUpdatedAt: item.updatedAt,
            idempotencyKey: JSON.stringify([
              workspace.workspaceId,
              competing.meetingId,
              updateIntent.id,
              "operational-outcome-work"
            ])
          }
        }
      ]);
      const writtenOutcome = operationalOutcomeWriter.writes[0];

      expect(operationalOutcomeWriter.writes).toHaveLength(1);
      expect(writtenOutcome?.target.page.externalId).toBe("notion-page-product-sync");
      expect(writtenOutcome?.outcome.entries[0]?.resolution.type).toBe("update-existing");
      expect(writtenOutcome?.outcome.entries[0]?.workReferences).toEqual([
        expect.objectContaining({ externalId: "LUM-3", objectType: "work-item" })
      ]);

      const terminalRejection = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-rejected",
            observationId: "reject:executed-human-resolved-update",
            workspaceId: workspace.workspaceId,
            meetingId: competing.meetingId,
            occurredAt: "2026-08-07T10:04:00.000Z",
            observedAt: "2026-08-07T10:04:00.000Z",
            intentId: updateIntent.id,
            rejectedBy: "person:jakob"
          }
        ]
      });

      expect(terminalRejection.acceptedObservationIds).toEqual([]);
      expect(terminalRejection.errors[0]).toMatchObject({
        code: "invalid-observation"
      });
    } finally {
      await database.close();
    }
  });

  it("invalidates a Human-resolved work Intent when a later source revision removes its candidate", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const meetingId = "meeting:source:notion:stale-reconciliation-intent";
    const first = sourceObservation({
      sourceObjectId: "notion-stale-intent",
      meetingId
    });
    const item = workItem({ dueDate: null });
    const description = first.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const initial = await observeAndReview(meetingIntelligence, first);
      const reviewId = initial.reviews[0]?.proposal.id;

      if (!reviewId) {
        throw new Error("expected a reconciliation proposal");
      }

      const resolution = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:stale-intent",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-07T10:00:00.000Z",
            observedAt: "2026-08-07T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      expect(resolution.acceptedObservationIds).toEqual(["human-judgment:stale-intent"]);

      const beforeSupersession = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const intent =
        beforeSupersession.type === "snapshot"
          ? beforeSupersession.state.followUpIntentions.find(
              (candidate) => candidate.type === "settle-operational-outcome"
            )
          : undefined;

      if (!intent) {
        throw new Error("expected a suggested reconciliation settlement Intent");
      }

      await observeAndReview(
        meetingIntelligence,
        sourceObservation({
          sourceObjectId: "notion-stale-intent",
          meetingId,
          revision: 2,
          contentHash: "sha256:notion-stale-intent-r2-empty",
          emptyActionItems: true
        })
      );

      const approval = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:stale-intent",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-07T10:01:00.000Z",
            observedAt: "2026-08-07T10:01:00.000Z",
            intentId: intent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      expect(approval.acceptedObservationIds).toEqual([]);
      expect(approval.errors[0]).toMatchObject({ code: "invalid-observation" });

      const workProvider = new RecordingWorkProvider(item);
      await expect(
        createFollowUpExecution({
          database,
          meetingIntelligence,
          workProvider
        }).execute({ workspace, meetingId, intentId: intent.id })
      ).rejects.toThrow("must be canonically approved");
      expect(workProvider.updateCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("lets Human Judgment refresh a failed reconciliation Intent after writer configuration is restored", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({
      sourceObjectId: "notion-manual-recovery-refresh"
    });
    const item = workItem({ dueDate: null });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source candidate");
    }

    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const initial = await observeAndReview(meetingIntelligence, observation);
      const review = initial.reviews[0]?.proposal;

      if (!review) {
        throw new Error("expected an update reconciliation proposal");
      }

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:manual-recovery-refresh:resolve",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:00:00.000Z",
            observedAt: "2026-08-08T10:00:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: review.id,
              resolution: { type: "accept-proposal" }
            }
          }
        ]
      });

      const resolved = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      const intent =
        resolved.type === "snapshot"
          ? resolved.state.followUpIntentions.find(
              (candidate) => candidate.type === "settle-operational-outcome"
            )
          : undefined;

      if (!intent) {
        throw new Error("expected a reconciliation settlement Intent");
      }

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:manual-recovery-refresh",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:01:00.000Z",
            observedAt: "2026-08-08T10:01:00.000Z",
            intentId: intent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      const idempotencyKey = JSON.stringify([
        workspace.workspaceId,
        observation.meetingId,
        intent.id,
        "execute"
      ]);
      await database.query(
        `INSERT INTO follow_up_executions (
           workspace_id, meeting_id, intent_id, operation, idempotency_key,
           status, attempts, result_json, execution_lease_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
        [
          workspace.workspaceId,
          observation.meetingId,
          intent.id,
          idempotencyKey,
          "manual-recovery-refresh-lease",
          "2026-08-08T10:02:00.000Z"
        ]
      );

      const recovery = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider: new RecordingWorkProvider(item),
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).recover({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(recovery.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "operational-outcome-writer-not-configured",
        retryable: false
      });

      const refresh = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-judgment:manual-recovery-refresh:refresh",
            workspaceId: workspace.workspaceId,
            meetingId: observation.meetingId,
            occurredAt: "2026-08-08T10:03:00.000Z",
            observedAt: "2026-08-08T10:03:00.000Z",
            participantId: "person:jakob",
            judgment: {
              kind: "refresh-action-item-reconciliation",
              reviewId: review.id
            }
          }
        ]
      });

      expect(refresh.acceptedObservationIds).toEqual([
        "human-judgment:manual-recovery-refresh:refresh"
      ]);
      expect(catalog.searchCalls).toHaveLength(4);
      const history = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "action-item-reconciliation-history" }
      });

      expect(
        history.type === "action-item-reconciliation-history" ? history.reviews : []
      ).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("uses the source-bound catalog for unqualified Action Items and never falls through to another provider", async () => {
    const linearCatalog = new ProgrammableWorkCatalog("linear");
    const githubCatalog = new ProgrammableWorkCatalog("github");
    const observation = sourceObservation({
      description:
        "Jakob will prepare the provider-bound reconciliation brief by Friday.",
      mentionedWorkItemReferences: [],
      workItemProviderId: "github"
    });
    const { database, meetingIntelligence } = await createHarness([
      linearCatalog,
      githubCatalog
    ]);

    try {
      const { reviews } = await observeAndReview(meetingIntelligence, observation);

      expect(reviews[0]).toMatchObject({
        proposal: {
          catalogProviderId: "github",
          searches: [expect.objectContaining({ providerId: "github" })],
          outcome: { type: "create-new" }
        }
      });
      expect(linearCatalog.searchCalls).toEqual([]);
      expect(githubCatalog.searchCalls).toEqual([
        expect.objectContaining({ text: observation.candidates[0]?.description })
      ]);
    } finally {
      await database.close();
    }
  });

  it("treats punctuation-only duplicate new-work drafts as one Human Judgment conflict", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const meetingId = "meeting:source:notion:punctuation-create-conflict";
    const first = sourceObservation({
      sourceObjectId: "notion-punctuation-a",
      meetingId,
      description: "Jakob will prepare the Luma reconciliation brief by Friday.",
      mentionedWorkItemReferences: []
    });
    const second = sourceObservation({
      sourceObjectId: "notion-punctuation-b",
      meetingId,
      description: "Jakob will prepare the Luma reconciliation brief by Friday",
      mentionedWorkItemReferences: []
    });
    const firstDescription = first.candidates[0]?.description;
    const secondDescription = second.candidates[0]?.description;

    if (!firstDescription || !secondDescription) {
      throw new Error("expected source candidate descriptions");
    }

    catalog.respondToSearch(firstDescription, []);
    catalog.respondToSearch(secondDescription, []);
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      await observeAndReview(meetingIntelligence, first);
      const later = await observeAndReview(meetingIntelligence, second);

      expect(later.reviews).toHaveLength(2);
      expect(later.reviews.map((review) => review.status)).toEqual([
        "blocked-by-conflict",
        "blocked-by-conflict"
      ]);
      expect(later.reviews.map((review) => review.effectiveOutcome.type)).toEqual([
        "needs-clarification",
        "needs-clarification"
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects completed source work without consulting a catalog", async () => {
    const catalog = new ProgrammableWorkCatalog();
    const observation = sourceObservation({ completion: "completed" });
    const { database, meetingIntelligence } = await createHarness(catalog);

    try {
      const { reviews } = await observeAndReview(meetingIntelligence, observation);

      expect(reviews[0]).toMatchObject({
        effectiveOutcome: { type: "reject-not-work" },
        proposal: { searches: [] }
      });
      expect(catalog.searchCalls).toEqual([]);
      expect(catalog.getCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("settles a Human-accepted reject-not-work outcome without a WorkProvider", async () => {
    const observation = sourceObservation({
      sourceObjectId: "notion-reject-outcome-settlement",
      completion: "completed"
    });
    const { database, meetingIntelligence } = await createHarness();
    const writer = new RecordingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const review = reviewed.reviews[0]?.proposal;

      if (!review || review.outcome.type !== "reject-not-work") {
        throw new Error("expected a reject-not-work reconciliation proposal");
      }

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId: review.id,
        observationSuffix: "reject-outcome-settlement"
      });
      const execution = await createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(execution.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      const entry = writer.writes[0]?.outcome.entries[0];

      expect(entry?.settlementIntentId).toBe(intent.id);
      expect(entry?.resolution.type).toBe("reject-not-work");
      expect(entry?.workReferences).toEqual([]);
      expect(entry?.unresolved).toEqual([]);
      expect(entry?.source).toEqual({
        sourceObjectId: observation.source.sourceObjectId,
        sourceRevision: observation.source.sourceRevision,
        sourceContentHash: observation.source.contentHash
      });

      const write = writer.writes[0];

      if (!write) {
        throw new Error("expected an Operational Outcome write");
      }

      expect(write.target.page).toEqual(observation.source.externalReference);
      expect(
        renderOperationalOutcomeMarkdown({
          outcome: write.outcome,
          idempotencyKey: write.idempotencyKey
        }).section
      ).toContain(
        `- Source revision: ${observation.source.sourceRevision}\n- Settlement Intent: \`${intent.id}\``
      );

      expect(
        await followUpIntentStatus({
          meetingIntelligence,
          meetingId: observation.meetingId,
          intentId: intent.id
        })
      ).toBe("succeeded");
    } finally {
      await database.close();
    }
  });

  it("settles a Human-selected clarification outcome and preserves it as unresolved", async () => {
    const catalog = new ProgrammableWorkCatalog("linear", false);
    const observation = sourceObservation({
      sourceObjectId: "notion-clarification-outcome-settlement"
    });
    const description = observation.candidates[0]?.description;

    if (!description) {
      throw new Error("expected a source Action Item description");
    }

    const item = workItem({ dueDate: null });
    catalog.respondToSearch("LUM-3", [item]);
    catalog.respondToSearch(description, [item]);
    catalog.respondToGet(item.id, item);
    const { database, meetingIntelligence } = await createHarness(catalog);
    const writer = new RecordingOperationalOutcomeWriter();

    try {
      const reviewed = await observeAndReview(meetingIntelligence, observation);
      const review = reviewed.reviews[0]?.proposal;

      if (!review || review.outcome.type !== "needs-clarification") {
        throw new Error("expected a needs-clarification reconciliation proposal");
      }
      expect(review.outcome.rationale).toContain("cannot conditionally update");

      const intent = await resolveAndApproveOperationalOutcome({
        meetingIntelligence,
        meetingId: observation.meetingId,
        reviewId: review.id,
        observationSuffix: "clarification-outcome-settlement",
        resolution: {
          type: "select-needs-clarification",
          reason: "The Action Item needs a confirmed owner before it becomes work."
        }
      });
      const executor = createFollowUpExecution({
        database,
        meetingIntelligence,
        operationalOutcomeWriter: writer,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      });
      const execution = await executor.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(execution.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);
      const entry = writer.writes[0]?.outcome.entries[0];

      expect(entry?.settlementIntentId).toBe(intent.id);
      expect(entry?.resolution.type).toBe("needs-clarification");
      expect(entry?.workReferences).toEqual([]);
      expect(entry?.unresolved).toEqual([
        "The Action Item needs a confirmed owner before it becomes work."
      ]);
      expect(entry?.source).toEqual({
        sourceObjectId: observation.source.sourceObjectId,
        sourceRevision: observation.source.sourceRevision,
        sourceContentHash: observation.source.contentHash
      });

      const write = writer.writes[0];

      if (!write) {
        throw new Error("expected an Operational Outcome write");
      }

      expect(write.target.page).toEqual(observation.source.externalReference);
      expect(
        renderOperationalOutcomeMarkdown({
          outcome: write.outcome,
          idempotencyKey: write.idempotencyKey
        }).section
      ).toContain(
        "#### Unresolved\n- The Action Item needs a confirmed owner before it becomes work\\."
      );

      const replay = await executor.execute({
        workspace,
        meetingId: observation.meetingId,
        intentId: intent.id
      });

      expect(replay.observation.outcome.status).toBe("succeeded");
      expect(writer.writes).toHaveLength(1);

      expect(
        await followUpIntentStatus({
          meetingIntelligence,
          meetingId: observation.meetingId,
          intentId: intent.id
        })
      ).toBe("succeeded");
    } finally {
      await database.close();
    }
  });
});
