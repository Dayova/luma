import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import { GranolaSourceError } from "./mcp-client.js";

const founder = z.enum(dayovaFounderPersonIds);
const connection = z
  .object({
    connectionId: z.string().min(1).max(128),
    ownerPersonId: founder,
    /** Durable, user-attested opt-in identity, never inferred from authentication. */
    optInId: z.string().min(1).max(128),
    accountFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    enabled: z.boolean(),
    audiencePersonIds: z.array(founder).min(1).max(4),
    automaticInternalMeetings: z.boolean().default(false),
    participantDirectory: z
      .array(
        z
          .object({
            email: z
              .string()
              .email()
              .transform((value) => value.toLowerCase()),
            personId: founder
          })
          .strict()
      )
      .max(16)
      .default([]),
    includedMeetingIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{1,128}$/)).max(500),
    excludedMeetingIds: z.array(z.string().regex(/^[a-zA-Z0-9-]{1,128}$/)).max(500)
  })
  .strict();
export const granolaPolicySchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1).max(128),
    connections: z.array(connection).max(4)
  })
  .strict();
export type GranolaConnectionPolicy = z.infer<typeof connection>;
export type GranolaPolicy = {
  read(connectionId: string): Promise<GranolaConnectionPolicy>;
};

/** Protected explicit per-user opt-in and exact-meeting inclusion; default admits nothing. */
export function createGranolaPolicy(input: {
  path: string;
  workspaceId: string;
}): GranolaPolicy {
  if (!isAbsolute(input.path)) throw new GranolaSourceError("policy-withheld");
  return {
    async read(connectionId) {
      try {
        const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > 200_000 ||
            (stat.mode & 0o022) !== 0 ||
            (stat.uid !== 0 && stat.uid !== process.geteuid?.())
          )
            throw new Error();
          const policy = granolaPolicySchema.parse(
            JSON.parse(await file.readFile("utf8")) as unknown
          );
          if (
            policy.workspaceId !== input.workspaceId ||
            new Set(policy.connections.map((item) => item.connectionId)).size !==
              policy.connections.length
          )
            throw new Error();
          const selected = policy.connections.find(
            (item) => item.connectionId === connectionId
          );
          if (
            !selected ||
            new Set(selected.audiencePersonIds).size !==
              selected.audiencePersonIds.length ||
            !selected.audiencePersonIds.includes(selected.ownerPersonId) ||
            new Set(selected.participantDirectory.map((entry) => entry.email)).size !==
              selected.participantDirectory.length
          )
            throw new Error();
          return selected;
        } finally {
          await file.close();
        }
      } catch {
        throw new GranolaSourceError("policy-withheld");
      }
    }
  };
}
