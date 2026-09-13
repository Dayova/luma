import type { ExternalReference, PersonId, WorkspaceId } from "../domain/model.js";

/** A Luma-owned identity for one real-world meeting, never a provider ID. */
export type LogicalMeetingId = string;

/** A Luma-owned identity for one provider capture root, never a provider ID. */
export type MeetingCaptureId = string;

export type CaptureCapability =
  | "available"
  | "partial"
  /** The provider explicitly did not expose this material. */
  | "unavailable"
  /** Luma could not establish whether the provider exposed this material. */
  | "unknown";

/**
 * Provider capabilities are immutable facts of a capture revision. A future
 * provider-plan upgrade creates a richer later revision; it never rewrites an
 * earlier Basic/limited revision into material Luma did not receive.
 */
export type MeetingCaptureCapabilities = {
  enhancedNotes: CaptureCapability;
  rawTranscript: CaptureCapability;
  speakerIdentity: CaptureCapability;
  attendees: CaptureCapability;
  revisionMetadata: CaptureCapability;
};

/**
 * Provider identity is scoped because one connected account must not silently
 * stand in for another person's private captures. A canonical organization
 * source may instead use a trusted composition-owned scope; it must not claim
 * to be a person's authenticated account unless its archive attests that fact.
 */
export type MeetingCaptureAddress = {
  providerId: string;
  providerConnectionId: string;
  externalCaptureId: string;
  sourceKind: string;
};

export type MeetingCaptureAvailability =
  "complete" | "partial" | "not-ready" | "failed" | "removed";

/**
 * Eligibility is decided by the provider adapter before binding. An ambiguous
 * or `requires-human-import` revision may later be admitted only by the
 * exact actor-attested Human import path; private/policy exclusions cannot.
 * A later private/policy decision may fence the same immutable source revision
 * without rewriting its source descriptors or an earlier import audit record.
 */
export type MeetingCaptureEligibility =
  | { state: "eligible" }
  | { state: "excluded"; reason: "private" | "ambiguous" | "policy" }
  | { state: "requires-human-import" };

/**
 * Descriptor only: raw source text stays with the provider-specific durable
 * source ledger. This keeps a capture binding from becoming a second archive.
 */
export type MeetingCaptureMaterial = {
  kind:
    | "verbatim-transcript"
    | "derived-notes"
    | "provider-summary"
    | "provider-action-items"
    | "attendees"
    | "calendar-metadata"
    | "other";
  provenance: "original-speech" | "provider-derived" | "provider-metadata";
  sourceObjectId: string;
  sourceVersion: string;
  externalReference: ExternalReference;
};

/**
 * Cross-provider correlation facts. Display names and raw provider user IDs
 * are intentionally absent: only resolved Person IDs can support automatic
 * attendee matching across providers.
 */
export type MeetingIdentityFacts = {
  calendarEventKeys: readonly string[];
  conferenceKeys: readonly string[];
  interval: { startedAt: string; endedAt: string } | null;
  attendeePersonIds: readonly PersonId[];
  /** A stable normalized fingerprint, never a replacement for source text. */
  titleFingerprint: string | null;
  /** Narrow, provider-attested context identifiers; no free-form source text. */
  contextKeys: readonly string[];
};

/**
 * An immutable provider capture revision already persisted by its provider
 * adapter/ledger. Its raw content is resolved later through that adapter.
 */
export type MeetingCaptureRevision = {
  address: MeetingCaptureAddress;
  sourceRevision: number;
  contentHash: string;
  providerVersion: string | null;
  capturedAt: string;
  eligibility: MeetingCaptureEligibility;
  availability: MeetingCaptureAvailability;
  capabilities: MeetingCaptureCapabilities;
  identityFacts: MeetingIdentityFacts;
  materials: readonly MeetingCaptureMaterial[];
  externalReference: ExternalReference;
};

/**
 * The external-source seam. Provider adapters own discovery, pagination,
 * credentials, eligibility, and durable raw capture storage; the shared core
 * receives only archived provider-neutral revisions.
 */
export interface MeetingCaptureSource {
  discover(input: {
    workspaceId: WorkspaceId;
    providerConnectionId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    captures: readonly MeetingCaptureAddress[];
    nextCursor: string | null;
  }>;
  fetchCapture(input: {
    workspaceId: WorkspaceId;
    capture: MeetingCaptureAddress;
  }): Promise<MeetingCaptureRevision>;
}

export type CaptureRevisionVerification =
  | { status: "verified" }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string; retryable: boolean };

/**
 * Verifies an exact archived revision before the binding layer accepts it. A
 * Notion adapter reuses LUM-2's ledger; Granola will add its own verifier.
 */
export interface CaptureRevisionVerifier {
  verify(input: {
    workspaceId: WorkspaceId;
    revision: MeetingCaptureRevision;
  }): Promise<CaptureRevisionVerification>;
}

export type CaptureMatchEvidence =
  | { kind: "shared-calendar-event" }
  | { kind: "shared-conference" }
  | { kind: "time-and-attendees"; sharedAttendeeCount: number }
  | { kind: "title-time-context" };

export type LogicalMeetingMatchCandidate = {
  logicalMeetingId: LogicalMeetingId;
  evidence: readonly CaptureMatchEvidence[];
};

/** Required explicit matching states; candidates are never silent membership. */
export type CaptureBindingState =
  "bound-high-confidence" | "candidate-match" | "ambiguous" | "separate" | "human-bound";

export type LogicalMeetingCaptureRef = {
  id: MeetingCaptureId;
  address: MeetingCaptureAddress;
  latestRevision: MeetingCaptureRevision;
  /**
   * `human-imported` retains the exact importable eligibility decision while
   * making the explicit organizational admission auditable. It never alters
   * the provider material behind the revision.
   */
  admission:
    | { state: "eligible" }
    | {
        state: "human-imported";
        judgmentId: string;
        actorPersonId: PersonId;
        observedAt: string;
        reason: string | null;
      };
  binding: {
    state: CaptureBindingState;
    origin: "automatic" | "human";
    updatedAt: string;
  };
};

export type LogicalMeeting = {
  id: LogicalMeetingId;
  /**
   * Current automatically eligible or Human-admitted provider captures only.
   * Withdrawn/private captures stay in append-only history but must not reach
   * synthesis consumers.
   */
  captureRefs: readonly LogicalMeetingCaptureRef[];
  /** LUM-35 selects/creates the write anchor; LUM-33 never writes one. */
  canonicalAnchorRef: ExternalReference | null;
  createdAt: string;
  updatedAt: string;
};

export type CaptureBindingDecision = {
  logicalMeeting: LogicalMeeting;
  captureId: MeetingCaptureId;
  state: CaptureBindingState;
  origin: "automatic" | "human";
  effect: "created" | "unchanged" | "revised";
  matchEvidence: readonly CaptureMatchEvidence[];
  /** Digest of normalized identity facts evaluated by the recorded policy. */
  matchFactsDigest: string | null;
  candidates: readonly LogicalMeetingMatchCandidate[];
};

export type LogicalMeetingBindingResult =
  | { status: "accepted"; decision: CaptureBindingDecision }
  | {
      /** A verified policy/private withdrawal was retained without binding. */
      status: "excluded";
      captureId: MeetingCaptureId | null;
      message: string;
    }
  | {
      status: "rejected" | "unavailable";
      code:
        | "invalid-capture-revision"
        | "capture-revision-unverified"
        | "unknown-capture"
        | "unknown-logical-meeting"
        | "cross-workspace-binding"
        | "conflicting-human-judgment"
        | "ineligible-capture"
        | "superseded-capture-revision";
      message: string;
      retryable: boolean;
    };

export type HumanCaptureBindingJudgment = {
  judgmentId: string;
  workspaceId: WorkspaceId;
  actorPersonId: PersonId;
  captureId: MeetingCaptureId;
  observedAt: string;
  reason: string | null;
  /** Optional read-to-write precondition, checked under the workspace lock. */
  expectedCapture?: { sourceRevision: number; contentHash: string; bindingId: string };
  judgment:
    | { type: "bind"; logicalMeetingId: LogicalMeetingId }
    | {
        /** The candidate/previous LogicalMeeting the Human explicitly rejects. */
        type: "make-separate";
        rejectedLogicalMeetingId: LogicalMeetingId;
      };
};

/**
 * A named Human decision to admit one previously withheld provider revision
 * into organizational Luma. It never overrides a private/policy exclusion,
 * never fabricates provider material, and must be re-verified against the
 * exact immutable revision at the moment of import.
 */
export type HumanCaptureImportJudgment = {
  judgmentId: string;
  workspaceId: WorkspaceId;
  actorPersonId: PersonId;
  observedAt: string;
  reason: string | null;
  revision: MeetingCaptureRevision;
};

/**
 * A deep durable module for capture correlation. `resolveCapture` is the only
 * normal provider call; matching, persistence, candidates, and correction
 * precedence remain private to the Implementation.
 */
export interface LogicalMeetings {
  resolveCapture(input: {
    workspaceId: WorkspaceId;
    revision: MeetingCaptureRevision;
  }): Promise<LogicalMeetingBindingResult>;
  recordBindingJudgment(
    input: HumanCaptureBindingJudgment
  ): Promise<LogicalMeetingBindingResult>;
  importCapture(input: HumanCaptureImportJudgment): Promise<LogicalMeetingBindingResult>;
  get(
    input:
      | { workspaceId: WorkspaceId; logicalMeetingId: LogicalMeetingId }
      | { workspaceId: WorkspaceId; captureId: MeetingCaptureId }
  ): Promise<LogicalMeeting | null>;
}
