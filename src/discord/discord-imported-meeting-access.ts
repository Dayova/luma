import type { ImportedMeetingSource, WorkspaceConfig } from "../domain/model.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import { observedMeetingNoteToObservation } from "../knowledge/meeting-notes-ingestion.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import type { CreateDiscordMeetingBotInput } from "./discord-meeting-bot.js";

/** Adapts an existing accepted source to a Discord binding, never imports or merges it. */
export function createDiscordImportedMeetingAccess(input: {
  workspace: WorkspaceConfig;
  authorizedPersonIds: readonly string[];
  ledger: Pick<ObservedSourceLedger, "listCurrent">;
  sourceAccess: {
    requireCurrent(input: {
      source: ImportedMeetingSource;
      audience: ContextAudience;
    }): Promise<void>;
  };
  providerId: string;
  workItemProviderId: string;
}): NonNullable<CreateDiscordMeetingBotInput["importedMeetingAccess"]> {
  const audience = (): ContextAudience => ({
    workspaceId: input.workspace.workspaceId,
    personIds: [...input.authorizedPersonIds]
  });
  return {
    async resolve(request) {
      if (
        request.workspaceId !== input.workspace.workspaceId ||
        !canonicalNotionObjectId(request.pageId)
      )
        return null;
      const heads = await input.ledger.listCurrent({
        workspaceId: request.workspaceId,
        providerId: input.providerId,
        sourceKind: "meeting-note"
      });
      const matches = heads.filter(
        (head) =>
          canonicalNotionObjectId(head.source.parentObjectId ?? "") ===
            canonicalNotionObjectId(request.pageId) &&
          head.snapshot.lifecycle !== "removed"
      );
      if (matches.length !== 1 || !matches[0]) return null;
      const observation = observedMeetingNoteToObservation(
        { workspace: input.workspace, source: { ...matches[0], change: "unchanged" } },
        input.workItemProviderId
      );
      await input.sourceAccess.requireCurrent({
        source: observation.source,
        audience: audience()
      });
      return observation.meetingId;
    },
    async requireCurrent({ state, personIds }) {
      if (
        state.workspaceId !== input.workspace.workspaceId ||
        personIds.length !== input.authorizedPersonIds.length ||
        !personIds.every((id) => input.authorizedPersonIds.includes(id))
      )
        throw new Error("The imported Meeting audience is not admitted");
      const sources = new Map<string, ImportedMeetingSource>();
      for (const source of state.importedSources) {
        const key = JSON.stringify([source.providerId, source.sourceObjectId]);
        const previous = sources.get(key);
        if (!previous || source.sourceRevision > previous.sourceRevision)
          sources.set(key, source);
      }
      if (!sources.size || sources.size > 8)
        throw new Error("The imported Meeting source scope cannot be verified");
      for (const source of sources.values())
        await input.sourceAccess.requireCurrent({ source, audience: audience() });
    }
  };
}
