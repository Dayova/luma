import type {
  ContextCatalog,
  ContextReceiptVerifier,
  MeetingContextProofLeaves,
  OrganizationalContextBundle,
  OrganizationalContextRequest,
  ContextAudience,
  ContextSource,
  RetrievedContextSource
} from "./interface.js";

/** All provider operations stay inside the enclosing verifier's single read deadline. */
export function createMeetingReceiptGraph(input: {
  leaves: MeetingContextProofLeaves;
  verify(
    request: OrganizationalContextRequest,
    receiptId: string,
    audience: ContextAudience,
    catalog: ContextCatalog,
    deadlineAt: number
  ): Promise<OrganizationalContextBundle>;
}): ContextReceiptVerifier {
  return {
    async requireCurrent(request) {
      request = structuredClone(request);
      const deadlineAt = Date.now() + 15_000;
      const snapshots = new Map<string, ContextSource | null>();
      const fences = new Map<string, () => Promise<void>>();
      const completed: Array<() => Promise<OrganizationalContextBundle>> = [];
      let exhausted = false;
      const exhaust = () => {
        exhausted = true;
        throw new Error("Meeting dependency proof reached its graph or time bound.");
      };
      let leafReads = 0,
        receiptReads = 0;
      const bounded = () => {
        if (exhausted || Date.now() >= deadlineAt) exhaust();
      };
      const verify = async (
        original: OrganizationalContextRequest,
        id: string,
        path: readonly string[]
      ): Promise<OrganizationalContextBundle> => {
        bounded();
        if (++receiptReads > 40 || path.length > 4) exhaust();
        const read = async (
          args: Parameters<ContextCatalog["read"]>[0]
        ): Promise<ContextSource | null> => {
          bounded();
          const key = JSON.stringify([
            args.audience,
            args.subject,
            args.sourceId,
            args.time,
            path
          ]);
          if (snapshots.has(key)) return snapshots.get(key)!;
          if (++leafReads > 40) exhaust();
          const leaf = await input.leaves.read(args);
          bounded();
          if (!leaf || path.includes(leaf.meetingId)) {
            snapshots.set(key, null);
            return null;
          }
          if (path.length >= 4) exhaust();
          const dependencies: Array<{ id: string; sources: RetrievedContextSource[] }> =
            [];
          for (const receipt of leaf.receipts) {
            const proof = await verify(receipt.request, receipt.id, [
              ...path,
              leaf.meetingId
            ]);
            dependencies.push({ id: receipt.id, sources: proof.sources });
          }
          await leaf.requireCurrent(dependencies);
          bounded();
          fences.set(
            JSON.stringify([leaf.meetingId, leaf.source.id, leaf.source.version]),
            () => leaf.requireCurrent(dependencies)
          );
          snapshots.set(key, leaf.source);
          return leaf.source;
        };
        const catalog: ContextCatalog = {
          id: input.leaves.id,
          dependencyKind: "meeting",
          read,
          search: async (args) => {
            bounded();
            const raw = await input.leaves.search(args);
            const sourceIds: string[] = [];
            for (const sourceId of raw.sourceIds) {
              bounded();
              try {
                const source = await read({ ...args, sourceId });
                if (source) sourceIds.push(sourceId);
              } catch {
                // The same eligibility rule as ordinary discovery: a descendant
                // that needs an ancestor already on this path is circular here.
                // Exhaustion must never masquerade as an empty discovery.
                bounded();
              }
            }
            return { ...raw, sourceIds };
          }
        };
        const reprove = () =>
          input.verify(original, id, request.audience, catalog, deadlineAt);
        const bundle = await reprove();
        bounded();
        completed.push(reprove);
        return bundle;
      };
      const path = [
        ...new Set(
          [request.subject, request.originalRequest.subject]
            .filter((subject) => subject?.type === "meeting")
            .map((subject) => subject!.id)
        )
      ];
      const bundle = await verify(request.originalRequest, request.receiptId, path);
      // Recheck external discovery and grants after the whole graph is read.
      // The scoped catalogs retain exact snapshots; final leaf fences below
      // independently recheck original source grants and Human revision heads.
      for (const reprove of [...completed]) {
        bounded();
        await reprove();
      }
      for (const fence of fences.values()) {
        bounded();
        await fence();
      }
      bounded();
      return { sources: bundle.sources };
    }
  };
}
