import { z } from "zod";
import type { DecisionFollowUpIntent } from "../domain/decision-records.js";
import type { DecisionStandingGrant } from "../domain/automatic-decisions.js";
import {
  decisionAudienceSchema,
  decisionEvidenceReferenceSchema,
  decisionExternalReferenceSchema
} from "../domain/decision-record-schemas.js";
import type { DecisionIntelligenceDependencies } from "./decision-intelligence.js";
import { decisionDigest } from "./persistence.js";
const id = z.string().trim().min(1).max(512);
export const decisionStandingGrantSchema: z.ZodType<
  DecisionStandingGrant,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    id,
    revision: id,
    contentHash: id,
    source: decisionExternalReferenceSchema,
    audience: decisionAudienceSchema,
    purpose: z.literal("automatic-decision-recording"),
    authorizedBy: id,
    actor: z.object({ providerId: id, providerUserId: id }).strict(),
    instruction: z.string().trim().min(1).max(4000),
    evidence: decisionEvidenceReferenceSchema,
    scopeId: id,
    actions: z
      .array(z.enum(["create", "link", "amend", "supersede", "reverse"]))
      .min(1)
      .max(5),
    modalities: z
      .array(z.enum(["final-decision", "accepted-proposal", "reversal"]))
      .min(1)
      .max(3),
    dispositions: z
      .array(z.enum(["adopt", "pause", "discard"]))
      .min(1)
      .max(3),
    validFrom: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }).nullable()
  })
  .strict()
  .refine(
    (grant) =>
      grant.evidence.source === "human-judgment" &&
      grant.evidence.participantId === grant.authorizedBy &&
      grant.evidence.excerpt === grant.instruction &&
      grant.evidence.sourceVersion === grant.revision &&
      grant.evidence.externalReference?.providerId === grant.source.providerId &&
      grant.evidence.externalReference?.externalId === grant.source.externalId &&
      grant.audience.personIds.includes(grant.authorizedBy)
  );

/** Exact policy proof is checked at every execution boundary, independently of AI confidence. */
export async function requireAutomaticPolicyCurrent(
  input: DecisionIntelligenceDependencies,
  intent: DecisionFollowUpIntent
): Promise<void> {
  if (intent.authorization.basis !== "standing-policy") return;
  const grant = decisionStandingGrantSchema.parse(intent.authorization.grant);
  const candidate = intent.interpretation.candidate;
  const now = (input.now ?? (() => new Date()))().getTime();
  const person = await input.accessPolicy.authorize({
    workspaceId: intent.source.audience.workspaceId,
    ...grant.actor
  });
  if (
    !input.automatic?.policy ||
    person?.personId !== grant.authorizedBy ||
    grant.scopeId !== candidate.scopeId ||
    candidate.decisionMakerPersonIds.length !== 1 ||
    candidate.decisionMakerPersonIds[0] !== grant.authorizedBy ||
    !grant.actions.some(
      (action) => action === intent.interpretation.reconciliation.action
    ) ||
    !grant.modalities.some((modality) => modality === candidate.modality) ||
    !grant.dispositions.some((disposition) => disposition === candidate.disposition) ||
    Date.parse(grant.validFrom) > now ||
    (grant.validUntil !== null && Date.parse(grant.validUntil) <= now) ||
    decisionDigest({
      ...grant.audience,
      personIds: [...grant.audience.personIds].sort()
    }) !==
      decisionDigest({
        ...intent.source.audience,
        personIds: [...intent.source.audience.personIds].sort()
      })
  )
    throw new Error(
      "The standing recording policy no longer authorizes this exact decision class and audience"
    );
  await input.automatic.policy.requireCurrent({
    audience: intent.source.audience,
    grant
  });
}
