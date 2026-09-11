import type { LumaDatabase } from "../persistence/db.js";
import {
  ImportedSourceUnavailableError,
  type ImportedSourceAnalysisConfiguration,
  type ImportedSourceHistoryAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import { hasNativeReviewSourceBinding } from "../knowledge/native-review-source-access.js";
import type { ImportedMeetingSource } from "../domain/model.js";

type SourceConfiguration = ImportedSourceAnalysisConfiguration & {
  access: ImportedSourceHistoryAccess;
};

/** Dispatch by retained provenance before applying current grants. Denials never fall through. */
export function createImportedSourceAnalysisRouter(input: {
  database: LumaDatabase;
  workspaceId: string;
  audience: ImportedSourceAnalysisConfiguration["audience"];
  generic?: SourceConfiguration;
  native?: { sourceHistoryAccess: ImportedSourceHistoryAccess };
}) {
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new ImportedSourceUnavailableError());
    const run = operation();
    pending.add(run);
    void run.finally(() => pending.delete(run)).catch(() => undefined);
    return run;
  };
  const select = async (source: ImportedMeetingSource) => {
    const native = await hasNativeReviewSourceBinding({
      database: input.database,
      workspaceId: input.workspaceId,
      source
    });
    const access = native ? input.native?.sourceHistoryAccess : input.generic?.access;
    if (!access) throw new ImportedSourceUnavailableError();
    return access;
  };
  const configuration: SourceConfiguration | undefined =
    input.native || input.generic
      ? {
          audience: input.audience,
          access: {
            requireCurrent: (request) =>
              track(async () => {
                const bound = structuredClone(request);
                const access = await select(bound.source);
                await access.requireCurrent(bound);
                if ((await select(bound.source)) !== access)
                  throw new ImportedSourceUnavailableError();
              }),
            requireRetained: (request) =>
              track(async () => {
                const bound = structuredClone(request);
                const access = await select(bound.source);
                await access.requireRetained(bound);
                if ((await select(bound.source)) !== access)
                  throw new ImportedSourceUnavailableError();
              })
          }
        }
      : undefined;
  return {
    configuration,
    async stop() {
      stopped = true;
      while (pending.size) await Promise.allSettled([...pending]);
    }
  };
}
