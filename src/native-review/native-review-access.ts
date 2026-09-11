import type { ContextAudience } from "../organizational-context/interface.js";
import type {
  ExactMeetingNotePage,
  TrustedNativeActor
} from "./source-bound-native-review.js";

/** Locators select provider records; they never assert a Human identity or approval. */
export type NativeReviewLocator = { sessionId: string; eventId: string };
export type NativeReviewInstruction = {
  agentId: string;
  sessionId: string;
  eventId: string;
  sequence: number;
  createdAt: string;
  originalText: string;
  actor: TrustedNativeActor & { personId: string };
  page: ExactMeetingNotePage;
  audience: ContextAudience;
  /** Original unique provider bindings, so remapping cannot rewrite old Human intent. */
  recipients: Array<{ personId: string; providerUserId: string }>;
};

export type NativeReviewDiscoveryResult = {
  requests: Array<NativeReviewLocator & { createdAt: string; actorLabel: string }>;
  coverage: {
    /** Completeness is only for this fixed recent window, never all agent history. */
    complete: boolean;
    windowStart: string;
    windowEnd: string;
    limitations: Array<"session-limit" | "event-limit" | "result-limit">;
  };
};

/** Provider-owned discovery. No caller-supplied identity, agent, page, or query scope. */
export interface NativeReviewDiscovery {
  discover(): Promise<{
    result: NativeReviewDiscoveryResult;
    requireCurrent(): Promise<void>;
  }>;
  stop(): Promise<void>;
}

export interface NativeReviewAccess {
  read(locator: NativeReviewLocator): Promise<NativeReviewInstruction>;
  requireCurrent(instruction: NativeReviewInstruction): Promise<void>;
}

export class NativeReviewUnavailable extends Error {
  constructor(
    readonly code:
      | "access-unavailable"
      | "source-unavailable"
      | "source-changed"
      | "request-conflict"
      | "stopped"
      | "review-unavailable"
  ) {
    super(
      {
        "access-unavailable":
          "The original Human request and all four founders' current access could not be verified.",
        "source-unavailable":
          "The exact Meeting Note is temporarily unavailable or incomplete. Retry this review when it can be verified.",
        "source-changed":
          "The original Meeting Note changed or is no longer available. Send a new review request for its current revision.",
        "request-conflict":
          "This native event is already bound to different original evidence.",
        stopped: "Native review is stopping. Retry after Luma is available.",
        "review-unavailable":
          "The shared review service is unavailable. No external change was made."
      }[code]
    );
    this.name = "NativeReviewUnavailable";
  }
}
