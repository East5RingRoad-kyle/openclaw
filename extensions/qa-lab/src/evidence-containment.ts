import type { QaEvidenceOccurrence, QaEvidenceSummaryV3Entry } from "./evidence-summary-schema.js";

/** Direct bundle membership preserves child-local selection across outer retries. */
export function resolveQaEvidenceContainment(
  occurrences: readonly QaEvidenceOccurrence[],
  entries: readonly QaEvidenceSummaryV3Entry[],
) {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const parentById = new Map<string, string>();
  const localActivity = new Map(
    entries.map((entry) => [entry.binding.occurrenceId, entry.effective]),
  );
  for (const owner of occurrences) {
    if (!owner.childOccurrenceIds) {
      continue;
    }
    const bundleReceipts = owner.receipts.filter(
      (receipt) => receipt.artifact.kind === "producer-evidence",
    );
    if (
      owner.scenario?.kind !== "observation" ||
      owner.terminalStatus === null ||
      bundleReceipts.length !== 1 ||
      bundleReceipts[0]!.phase !== "prepared"
    ) {
      throw new Error("child evidence requires a completed command and captured bundle receipt");
    }
    for (const id of owner.childOccurrenceIds) {
      if (id === owner.id || !byId.has(id) || parentById.has(id)) {
        throw new Error("child evidence membership is missing, repeated, or conflicting");
      }
      parentById.set(id, owner.id);
    }
  }
  for (const occurrence of occurrences) {
    const references = [
      occurrence.retryOf,
      occurrence.scenario?.kind === "observation"
        ? occurrence.scenario.instanceOccurrenceId
        : occurrence.scenario?.resultOccurrenceId,
    ];
    if (references.some((id) => id && parentById.get(id) !== parentById.get(occurrence.id))) {
      throw new Error("child evidence membership must contain complete local ownership");
    }
    const visited = new Set([occurrence.id]);
    let parent = parentById.get(occurrence.id);
    while (parent) {
      if (visited.has(parent)) {
        throw new Error("cyclic child evidence membership");
      }
      visited.add(parent);
      parent = parentById.get(parent);
    }
  }
  function rootId(id: string) {
    let root = id;
    let parent = parentById.get(root);
    while (parent) {
      root = parent;
      parent = parentById.get(root);
    }
    return root;
  }
  function isActive(id: string) {
    let parent = parentById.get(id);
    while (parent) {
      // Bundle owners always publish a command row. Missing rows cannot make
      // retained child detail count as a successful enclosing attempt.
      if (localActivity.get(parent) !== true) {
        return false;
      }
      parent = parentById.get(parent);
    }
    return true;
  }
  const rootInstances = occurrences.filter(
    (occurrence) => occurrence.scenario?.kind === "instance" && !parentById.has(occurrence.id),
  );
  return { parentById, rootId, isActive, rootInstances };
}
