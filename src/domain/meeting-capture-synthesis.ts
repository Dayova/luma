import type {
  Confidence,
  ExternalReference,
  FollowUpIntentStatus,
  PersonId,
  Provenance
} from "./model.js";
import type { MeetingCaptureCapabilities } from "../logical-meetings/interface.js";

export type {
  MeetingCaptureSetObserved,
  CaptureSynthesisJudgmentRecorded
} from "./model.js";

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
  /** Explicit exact-revision Human evidence for actionable details, separate from provider text. */
  actionReview?: {
    modality: "commitment" | "request";
    dueDate: string | null;
    ownerPersonId: PersonId | null;
    participantId: PersonId;
    judgedAt: string;
  };
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
