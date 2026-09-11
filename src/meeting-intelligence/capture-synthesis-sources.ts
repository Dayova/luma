import { createHash } from "node:crypto";
import type { LumaSynthesis } from "../domain/meeting-capture-synthesis.js";
import type { LogicalMeeting } from "../logical-meetings/interface.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type {
  CaptureSynthesisConfiguration,
  CurrentMeetingCaptureMaterial
} from "./meeting-capture-access.js";
export type Material = CurrentMeetingCaptureMaterial & {
  captureId: string;
  sourceRevision: number;
  evidenceId: string;
};
export type Prepared = {
  authorizationScopes: Record<string, string>;
  meeting: LogicalMeeting;
  audience: ContextAudience;
  materials: Material[];
  bindingDigest: string;
  materialDigest: string;
  compatibleMaterialDigests: string[];
  anchor: LumaSynthesis["canonicalAnchorRef"];
};
class Unavailable extends Error {
  constructor() {
    super("Capture source, original audience or binding is unavailable.");
  }
}
export const prepareCaptureSynthesisSources = async (
  config: CaptureSynthesisConfiguration | undefined,
  workspaceId: string,
  meetingId: string,
  original?: ContextAudience
): Promise<Prepared> => {
  if (!config) throw new Unavailable();
  const audience = await config.audience(workspaceId);
  if (
    !audience ||
    audience.workspaceId !== workspaceId ||
    !audience.personIds.length ||
    new Set(audience.personIds).size !== audience.personIds.length ||
    (original &&
      (original.workspaceId !== workspaceId ||
        audience.personIds.some((id) => !original.personIds.includes(id))))
  )
    throw new Unavailable();
  const boundAudience = { workspaceId, personIds: [...audience.personIds].sort() };
  const meeting = await config.logicalMeetings.get({
    workspaceId,
    logicalMeetingId: meetingId
  });
  if (!meeting || !meeting.captureRefs.length || meeting.captureRefs.length > 8)
    throw new Unavailable();
  // Publication metadata is not new source material or a new capture binding.
  const bindingDigest = captureBindingDigest(meeting);
  const materials: Material[] = [];
  const authorizationScopes: Record<string, string> = {};
  const anchors: NonNullable<LumaSynthesis["canonicalAnchorRef"]>[] = [];
  for (const capture of meeting.captureRefs) {
    const revision = capture.latestRevision;
    if (
      !["complete", "partial"].includes(revision.availability) ||
      !revision.materials.length
    )
      throw new Unavailable();
    const material = await config.access.readCurrent({
      workspaceId,
      capture: structuredClone(capture),
      audience: structuredClone(boundAudience)
    });
    if (!material.authorizationScopeId.trim()) throw new Unavailable();
    authorizationScopes[capture.id] = material.authorizationScopeId;
    if (material.canonicalAnchorRef) anchors.push(material.canonicalAnchorRef);
    if (
      digest(sorted(material.materials.map((item) => item.descriptor))) !==
      digest(sorted(revision.materials))
    )
      throw new Unavailable();
    for (const item of material.materials) {
      if (!item.text.trim() || item.text.length > 100_000) throw new Unavailable();
      materials.push({
        ...item,
        captureId: capture.id,
        sourceRevision: revision.sourceRevision,
        evidenceId: `capture-evidence:${digest([capture.id, revision.sourceRevision, item.descriptor])}`
      });
    }
  }
  if (
    materials.length > 64 ||
    materials.reduce((count, item) => count + item.text.length, 0) > 250_000 ||
    new Set(materials.map((item) => item.evidenceId)).size !== materials.length
  )
    throw new Unavailable();
  const finalMeeting = await config.logicalMeetings.get({
    workspaceId,
    logicalMeetingId: meetingId
  });
  if (
    captureBindingDigest(finalMeeting) !== bindingDigest ||
    digest(finalMeeting?.canonicalAnchorRef) !== digest(meeting.canonicalAnchorRef) ||
    digest(
      await config
        .audience(workspaceId)
        .then((value) =>
          value ? { ...value, personIds: [...value.personIds].sort() } : null
        )
    ) !== digest(boundAudience)
  )
    throw new Unavailable();
  const uniqueAnchors = new Map(
    anchors.map((anchor) => [digest([anchor.providerId, anchor.externalId]), anchor])
  );
  const anchor =
    meeting.canonicalAnchorRef ??
    (uniqueAnchors.size === 1 ? [...uniqueAnchors.values()][0]! : null);
  if (!anchor && uniqueAnchors.size > 1) throw new Unavailable();
  const materialDigest = digest(sorted(materials));
  return {
    meeting,
    audience: boundAudience,
    materials,
    bindingDigest,
    materialDigest,
    compatibleMaterialDigests: [
      ...new Set([
        materialDigest,
        ...legacyMaterialCollators.map((collator) =>
          digest(
            [...materials].sort((a, b) => collator.compare(canonical(a), canonical(b)))
          )
        )
      ])
    ],
    authorizationScopes,
    anchor
  };
};
// Read compatibility only: old releases used the host's default collation.
// Keep the supported pre-release English/German orders explicit, never guess a
// matching source from descriptors alone or rewrite a persisted digest.
const legacyMaterialCollators = ["en-US", "de-DE"].map(
  (locale) => new Intl.Collator(locale)
);
export function matchesMaterialDigest(prepared: Prepared, stored: string): boolean {
  return prepared.compatibleMaterialDigests.includes(stored);
}
export function sorted<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const a = canonical(left),
      b = canonical(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
export function captureBindingDigest(meeting: LogicalMeeting | null): string {
  return digest(meeting ? { ...meeting, canonicalAnchorRef: null } : null);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
