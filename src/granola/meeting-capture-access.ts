import type { MeetingCaptureAccess } from "../meeting-intelligence/meeting-capture-access.js";
import type { GranolaMeetingCaptureSource } from "./meeting-capture-source.js";
import { GranolaSourceError } from "./mcp-client.js";

/** Adapts the actual protected capture readers; neither provider text nor a grant can be supplied by the caller. */
export function createGranolaMeetingCaptureAccess(input: {
  sources: readonly { connectionId: string; source: GranolaMeetingCaptureSource }[];
}): MeetingCaptureAccess {
  const sources = new Map(
    input.sources.map((entry) => [entry.connectionId, entry.source])
  );
  if (sources.size !== input.sources.length)
    throw new GranolaSourceError("policy-withheld");
  return {
    async readCurrent({ workspaceId, capture, audience }) {
      const source = sources.get(capture.address.providerConnectionId);
      if (
        !source ||
        capture.address.providerId !== "granola" ||
        audience.workspaceId !== workspaceId
      )
        throw new GranolaSourceError("policy-withheld");
      const material = await source.readCurrent({
        revision: capture.latestRevision,
        audience
      });
      const [descriptor] = capture.latestRevision.materials;
      if (
        capture.latestRevision.materials.length !== 1 ||
        descriptor?.kind !== "derived-notes" ||
        descriptor.provenance !== material.provenance
      )
        throw new GranolaSourceError("provider-shape-unsupported");
      return {
        authorizationScopeId: material.authorizationScopeId,
        canonicalAnchorRef: null,
        materials: [{ descriptor, text: material.text }]
      };
    }
  };
}
