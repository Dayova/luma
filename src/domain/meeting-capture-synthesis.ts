import type {
  Confidence,
  ExternalReference,
  FollowUpIntentStatus,
  ObservationBase,
  PersonId,
  Provenance
} from "./model.js";
import type { MeetingCaptureCapabilities } from "../logical-meetings/interface.js";

/** Only exact bound identities cross the intake Interface; source text comes from owned readers. */
export type MeetingCaptureSetObserved = ObservationBase & {
  type: "meeting-capture-set-observed";
  captures: Array<{ captureId: string; sourceRevision: number; contentHash: string }>;
};

export type CaptureSynthesisClaimKind =
  "summary" | "decision" | "commitment" | "action-item" | "question" | "risk";
export type CaptureSynthesisClaim = {
  id: string;
  stableKey: string;
  kind: CaptureSynthesisClaimKind;
  text: string;
  authority: "inferred" | "human-confirmed" | "human-corrected" | "human-rejected";
  confidence: Confidence;
  citations: Array<{
    evidenceId: string;
    captureId: string;
    materialId: string;
    sourceRevision: number;
    externalReference: ExternalReference;
  }>;
  /** Verbatim material only; provider-derived notes cannot support these. */
  quotations: Array<{ evidenceId: string; text: string }>;
  conflictingClaimIds: string[];
};

export type CaptureSynthesisJudgmentRecorded = ObservationBase & {
  type: "capture-synthesis-judgment-recorded";
  participantId: PersonId;
  expectedSynthesisRevision: number;
  claimId: string;
  judgment: { kind: "confirm" | "reject" } | { kind: "correct"; text: string };
};

/** Derived understanding only; this is neither a raw transcript nor an execution receipt. */
export type LumaSynthesis = {
  workspaceId: string;
  logicalMeetingId: string;
  revision: number;
  sourceSetDigest: string;
  producedAt: string;
  claims: CaptureSynthesisClaim[];
  sources: Array<{
    captureId: string;
    sourceRevision: number;
    contentHash: string;
    capabilities: MeetingCaptureCapabilities;
    externalReference: ExternalReference;
  }>;
  canonicalAnchorRef: ExternalReference | null;
  coverage: "complete" | "partial";
};

export type CaptureSynthesisQueryResult = {
  type: "capture-synthesis";
  availability: "available" | "unavailable" | "not-configured" | "not-produced";
  synthesis: LumaSynthesis | null;
  followUpIntentions?: PublishMeetingSynthesisIntent[];
};

/** Exact derived revision approval; a target or body supplied by the caller is never accepted. */
export type PublishMeetingSynthesisIntent = {
  type: "publish-meeting-synthesis";
  id: string;
  title: string;
  synthesisRevision: number;
  sourceSetDigest: string;
  status: FollowUpIntentStatus;
  relatedMeetingItemIds: string[];
  provenance: Provenance;
};
