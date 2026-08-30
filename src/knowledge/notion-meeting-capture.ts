import type { ExternalReference, PersonId } from "../domain/model.js";
import type {
  CaptureCapability,
  MeetingCaptureCapabilities,
  MeetingCaptureMaterial,
  MeetingCaptureRevision
} from "../logical-meetings/interface.js";
import { meetingCaptureTitleFingerprint } from "./meeting-capture-title-fingerprint.js";
import type {
  ObservedSourceRevision,
  RawMeetingNoteSection,
  RawMeetingNoteSnapshot
} from "./observed-source-ledger.js";

export type ObservedNotionMeetingCaptureInput = {
  /** An immutable revision already admitted by LUM-2's observed-source ledger. */
  source: ObservedSourceRevision<"meeting-note">;
  /**
   * A trusted, composition-owned scope for the canonical Notion source. LUM-2
   * does not archive an authenticated per-user connection identity, so this
   * must not be labelled as a person's connection without a future attested
   * source envelope. It remains part of the capture address, not a credential.
   */
  canonicalSourceScopeId: string;
  /**
   * Canonical Person identities resolved at capture time by a trusted,
   * durable identity adapter. Raw Notion user IDs must never be passed here.
   */
  attendeePersonIds?: readonly PersonId[];
};

/**
 * Projects an existing LUM-2 Notion ledger revision into a provider-neutral
 * meeting-capture descriptor. It retains no raw text and creates no source
 * revision: the observed-source ledger remains the sole raw-capture archive.
 */
export function observedNotionMeetingCapture(
  input: ObservedNotionMeetingCaptureInput
): MeetingCaptureRevision {
  const canonicalSourceScopeId = input.canonicalSourceScopeId.trim();

  if (canonicalSourceScopeId.length === 0) {
    throw new Error(
      "A Notion meeting capture requires a canonical source scope identity"
    );
  }

  const attendeePersonIds = normalizedPersonIds(input.attendeePersonIds);
  const availability = captureAvailability(input.source.snapshot);
  const capabilities = captureCapabilities(input.source.snapshot, attendeePersonIds);
  const externalReference = sourceExternalReference(input.source);

  return {
    address: {
      providerId: input.source.source.providerId,
      providerConnectionId: canonicalSourceScopeId,
      externalCaptureId: input.source.source.sourceObjectId,
      sourceKind: "meeting-note"
    },
    sourceRevision: input.source.revision,
    contentHash: input.source.contentHash,
    providerVersion: input.source.providerVersion,
    capturedAt: input.source.capturedAt,
    eligibility: { state: "eligible" },
    availability,
    capabilities,
    identityFacts: {
      // LUM-2's current snapshot intentionally does not claim a stable
      // calendar-event or conference identity. Do not turn a page/root ID
      // into a cross-provider matching key.
      calendarEventKeys: [],
      conferenceKeys: [],
      interval: meetingInterval(input.source.snapshot),
      attendeePersonIds,
      titleFingerprint: meetingCaptureTitleFingerprint(input.source.snapshot.title),
      contextKeys: []
    },
    materials: captureMaterials(
      input.source,
      availability,
      capabilities,
      attendeePersonIds,
      externalReference
    ),
    externalReference
  };
}

function captureAvailability(
  snapshot: RawMeetingNoteSnapshot
): MeetingCaptureRevision["availability"] {
  switch (snapshot.completeness.state) {
    case "complete":
      return "complete";
    case "partial":
      return "partial";
    case "not-ready":
      return "not-ready";
    case "failed":
      return "failed";
    case "removed":
      return "removed";
  }
}

function captureCapabilities(
  snapshot: RawMeetingNoteSnapshot,
  attendeePersonIds: readonly PersonId[]
): MeetingCaptureCapabilities {
  const summaryAvailable = snapshot.sections.summary.state === "available";
  const actionItemsAvailable =
    snapshot.sections.actionItemsAndNotes.state === "available";
  const transcriptAvailable = snapshot.sections.transcript.state === "available";
  const absentCapability = absentMaterialCapability(snapshot);
  const providerAttendeeIds = snapshot.calendar?.attendeeProviderUserIds ?? [];

  return {
    enhancedNotes:
      summaryAvailable && actionItemsAvailable
        ? "available"
        : summaryAvailable || actionItemsAvailable
          ? "partial"
          : absentCapability,
    rawTranscript: transcriptAvailable ? "available" : absentCapability,
    // A Notion Meeting Notes transcript does not by itself attest a speaker
    // identity. Keep German-first attribution in its dedicated safety path.
    speakerIdentity: "unavailable",
    attendees:
      attendeePersonIds.length > 0
        ? "available"
        : providerAttendeeIds.length > 0
          ? "partial"
          : absentCapability,
    // This is supplied by the immutable ledger envelope, including tombstones.
    revisionMetadata: "available"
  };
}

function absentMaterialCapability(snapshot: RawMeetingNoteSnapshot): CaptureCapability {
  switch (snapshot.completeness.state) {
    case "complete":
    case "removed":
      return "unavailable";
    case "partial":
    case "not-ready":
    case "failed":
      return "unknown";
  }
}

function meetingInterval(
  snapshot: RawMeetingNoteSnapshot
): { startedAt: string; endedAt: string } | null {
  const calendar = snapshot.calendar;

  if (calendar && isOrderedOffsetInterval(calendar.startAt, calendar.endAt)) {
    return { startedAt: calendar.startAt, endedAt: calendar.endAt };
  }

  const recording = snapshot.recording;

  if (
    recording &&
    recording.startAt !== null &&
    recording.endAt !== null &&
    isOrderedOffsetInterval(recording.startAt, recording.endAt)
  ) {
    return { startedAt: recording.startAt, endedAt: recording.endAt };
  }

  return null;
}

function isOrderedOffsetInterval(startedAt: string, endedAt: string): boolean {
  const offsetInstant = /(?:Z|[+-]\d{2}:\d{2})$/u;

  return (
    offsetInstant.test(startedAt) &&
    offsetInstant.test(endedAt) &&
    Number.isFinite(Date.parse(startedAt)) &&
    Number.isFinite(Date.parse(endedAt)) &&
    Date.parse(endedAt) > Date.parse(startedAt)
  );
}

function captureMaterials(
  source: ObservedSourceRevision<"meeting-note">,
  availability: MeetingCaptureRevision["availability"],
  capabilities: MeetingCaptureCapabilities,
  attendeePersonIds: readonly PersonId[],
  externalReference: ExternalReference
): MeetingCaptureMaterial[] {
  // Do not describe reusable material while Notion is still assembling it or
  // after a failure/removal. A readable partial snapshot is different: LUM-2
  // retained it as evidence with explicit completeness information.
  if (availability !== "complete" && availability !== "partial") {
    return [];
  }

  const sourceVersion = ledgerSourceVersion(source);
  const materialForSection = (
    section: RawMeetingNoteSection,
    kind: Extract<
      MeetingCaptureMaterial["kind"],
      "provider-summary" | "provider-action-items" | "verbatim-transcript"
    >,
    provenance: Extract<
      MeetingCaptureMaterial["provenance"],
      "provider-derived" | "original-speech"
    >
  ): MeetingCaptureMaterial[] =>
    section.state === "available"
      ? [
          {
            kind,
            provenance,
            sourceObjectId: section.sourceBlockId,
            sourceVersion,
            externalReference
          }
        ]
      : [];

  const calendar = source.snapshot.calendar;
  const hasProviderAttendees = (calendar?.attendeeProviderUserIds.length ?? 0) > 0;

  return [
    ...materialForSection(
      source.snapshot.sections.summary,
      "provider-summary",
      "provider-derived"
    ),
    ...materialForSection(
      source.snapshot.sections.actionItemsAndNotes,
      "provider-action-items",
      "provider-derived"
    ),
    ...materialForSection(
      source.snapshot.sections.transcript,
      "verbatim-transcript",
      "original-speech"
    ),
    ...(calendar
      ? [
          providerMetadataMaterial(
            "calendar-metadata",
            source,
            sourceVersion,
            externalReference
          )
        ]
      : []),
    // LUM-2's recording field is only timestamp metadata. It does not prove
    // that an accessible recording artifact exists, so it can inform the
    // interval above but must not become reusable capture material.
    ...(hasProviderAttendees || attendeePersonIds.length > 0
      ? [providerMetadataMaterial("attendees", source, sourceVersion, externalReference)]
      : [])
  ].filter((material) => materialAllowedByCapabilities(material, capabilities));
}

function providerMetadataMaterial(
  kind: Extract<MeetingCaptureMaterial["kind"], "attendees" | "calendar-metadata">,
  source: ObservedSourceRevision<"meeting-note">,
  sourceVersion: string,
  externalReference: ExternalReference
): MeetingCaptureMaterial {
  return {
    kind,
    provenance: "provider-metadata",
    sourceObjectId: source.source.sourceObjectId,
    sourceVersion,
    externalReference
  };
}

function materialAllowedByCapabilities(
  material: MeetingCaptureMaterial,
  capabilities: MeetingCaptureCapabilities
): boolean {
  if (material.kind === "verbatim-transcript") {
    return capabilities.rawTranscript === "available";
  }

  if (
    material.kind === "provider-summary" ||
    material.kind === "provider-action-items" ||
    material.kind === "derived-notes"
  ) {
    return (
      capabilities.enhancedNotes === "available" ||
      capabilities.enhancedNotes === "partial"
    );
  }

  if (material.kind === "attendees") {
    return capabilities.attendees === "available" || capabilities.attendees === "partial";
  }

  return true;
}

function sourceExternalReference(
  source: ObservedSourceRevision<"meeting-note">
): ExternalReference {
  return {
    providerId: source.source.providerId,
    objectType: "document",
    // The Notion URL identifies the containing page, while the root block is
    // retained separately as the exact immutable capture identity.
    externalId: source.source.parentObjectId ?? source.source.sourceObjectId,
    url: source.source.url,
    version: source.providerVersion ?? source.contentHash
  };
}

function ledgerSourceVersion(source: ObservedSourceRevision<"meeting-note">): string {
  return `observed-source-ledger:${source.revision}:${source.contentHash}`;
}

function normalizedPersonIds(values: readonly PersonId[] | undefined): PersonId[] {
  const normalized = (values ?? []).map((value) => value.trim());

  if (normalized.some((value) => value.length === 0)) {
    throw new Error("A canonical attendee Person identity may not be blank");
  }

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}
