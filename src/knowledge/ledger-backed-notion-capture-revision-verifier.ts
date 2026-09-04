import type { PersonId, WorkspaceId } from "../domain/model.js";
import type {
  CaptureRevisionVerification,
  CaptureRevisionVerifier,
  MeetingCaptureRevision
} from "../logical-meetings/interface.js";
import {
  observedNotionMeetingCapture,
  type ObservedNotionMeetingCaptureInput
} from "./notion-meeting-capture.js";
import type {
  ObservedSourceLedger,
  ObservedSourceRevision
} from "./observed-source-ledger.js";

export type LedgerBackedNotionAttendeeIdentityProjection = (input: {
  workspaceId: WorkspaceId;
  source: ObservedSourceRevision<"meeting-note">;
}) => readonly PersonId[];

export type CreateLedgerBackedNotionCaptureRevisionVerifierInput = {
  ledger: ObservedSourceLedger;
  /** The only Notion provider namespace this verifier may admit. */
  providerId?: string;
  /**
   * A trusted composition-owned scope for this canonical Notion source. This
   * verifier proves projection consistency inside that scope; LUM-2 does not
   * independently attest which authenticated account performed the original
   * read, so callers must not represent it as a per-user connection.
   */
  canonicalSourceScopeId: string;
  /**
   * Optional synchronous projection from an immutable source revision to
   * canonical Person IDs. It must be deterministic and durable; an ordinary
   * mutable directory lookup is not a valid verifier dependency.
   */
  attendeePersonIdsForLedgerSource?: LedgerBackedNotionAttendeeIdentityProjection;
};

/**
 * Admits only an exact provider-neutral projection of a Notion Meeting Note
 * revision already archived by LUM-2. It has no Notion SDK, page enumeration,
 * generic search, or write capability.
 */
export function createLedgerBackedNotionCaptureRevisionVerifier(
  input: CreateLedgerBackedNotionCaptureRevisionVerifierInput
): CaptureRevisionVerifier {
  const providerId = (input.providerId ?? "notion").trim();
  const canonicalSourceScopeId = input.canonicalSourceScopeId.trim();

  if (providerId.length === 0) {
    throw new Error("Notion capture revision verification requires a provider identity");
  }

  if (canonicalSourceScopeId.length === 0) {
    throw new Error(
      "Notion capture revision verification requires a canonical source scope identity"
    );
  }

  return {
    async verify({ workspaceId, revision }) {
      const envelopeError = captureEnvelopeError(
        workspaceId,
        revision,
        providerId,
        canonicalSourceScopeId
      );

      if (envelopeError) {
        return rejected(envelopeError);
      }

      try {
        const archived = await input.ledger.get({
          workspaceId,
          source: {
            providerId,
            sourceKind: "meeting-note",
            sourceObjectId: revision.address.externalCaptureId
          },
          revision: revision.sourceRevision
        });

        if (!archived) {
          return rejected(
            "The Notion Meeting Note source revision is absent from the observed-source ledger."
          );
        }

        if (
          archived.source.providerId !== providerId ||
          archived.source.sourceKind !== "meeting-note" ||
          archived.source.sourceObjectId !== revision.address.externalCaptureId ||
          archived.revision !== revision.sourceRevision ||
          archived.contentHash !== revision.contentHash
        ) {
          return rejected(
            "The Notion Meeting Note capture address, revision, or content hash does not match the immutable ledger revision."
          );
        }

        const source: ObservedSourceRevision<"meeting-note"> = {
          ...archived,
          change: "unchanged"
        };
        const attendeePersonIds = input.attendeePersonIdsForLedgerSource?.({
          workspaceId,
          source
        });
        const expected = observedNotionMeetingCapture({
          source,
          canonicalSourceScopeId,
          ...(attendeePersonIds ? { attendeePersonIds } : {})
        } satisfies ObservedNotionMeetingCaptureInput);

        return sameCanonicalCaptureRevision(expected, revision)
          ? { status: "verified" }
          : rejected(
              "The Notion Meeting Note capture revision does not match the exact immutable-ledger projection."
            );
      } catch (error) {
        return {
          status: "unavailable",
          message: `The Notion Meeting Note ledger revision could not be verified: ${errorMessage(error)}`,
          retryable: true
        };
      }
    }
  };
}

function captureEnvelopeError(
  workspaceId: WorkspaceId,
  revision: MeetingCaptureRevision,
  providerId: string,
  canonicalSourceScopeId: string
): string | null {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    return "A capture revision must be verified within one workspace.";
  }

  if (revision.address.providerId !== providerId) {
    return "The capture revision is not owned by this Notion provider identity.";
  }

  if (revision.address.providerConnectionId !== canonicalSourceScopeId) {
    return "The capture revision is not owned by this configured canonical Notion source scope.";
  }

  if (revision.address.sourceKind !== "meeting-note") {
    return "The Notion capture verifier accepts only Meeting Note source revisions.";
  }

  if (
    revision.address.externalCaptureId.trim().length === 0 ||
    !Number.isSafeInteger(revision.sourceRevision) ||
    revision.sourceRevision <= 0 ||
    revision.contentHash.trim().length === 0
  ) {
    return "The capture revision does not identify one exact source object, revision, and content hash.";
  }

  return null;
}

function rejected(message: string): CaptureRevisionVerification {
  return { status: "rejected", message };
}

function sameCanonicalCaptureRevision(
  expected: MeetingCaptureRevision,
  actual: MeetingCaptureRevision
): boolean {
  return canonicalJson(expected) === canonicalJson(actual);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Capture revision contains an unsupported number");
    }
    return JSON.stringify(value);
  }

  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error("Capture revision contains an unsupported value");
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) =>
      canonicalJson(entry === undefined ? null : entry)
    ).join(",")}]`;
  }

  if (typeof value !== "object") {
    throw new Error("Capture revision contains an unsupported value");
  }

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
