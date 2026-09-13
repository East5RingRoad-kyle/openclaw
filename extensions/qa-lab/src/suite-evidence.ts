import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRepoRootRelativeRef, toRepoRelativePath } from "./cli-paths.js";
import { captureQaEvidenceLaunchIdentity } from "./evidence-environment.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  buildQaSuiteEvidenceSummary,
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";
import type {
  QaSuiteEnvironment,
  QaSuiteResolvedRunContext,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
} from "./suite-types.js";

/** Rebase both raw entries and bound receipts through the same artifact owner. */
export function rebaseQaSuiteEvidence(summary: QaEvidenceSummaryJson, from: string, to: string) {
  const rebased = structuredClone(summary);
  const artifacts = [
    ...rebased.entries.flatMap((entry) => entry.execution?.artifacts ?? []),
    ...(rebased.schemaVersion === 3
      ? rebased.occurrences.flatMap((occurrence) =>
          occurrence.receipts.map((receipt) => receipt.artifact),
        )
      : []),
  ];
  for (const artifact of artifacts) {
    if (artifact.source === "qa-suite" && isRepoRootRelativeRef(artifact.path)) {
      artifact.path = toRepoRelativePath(to, path.resolve(from, artifact.path));
    }
  }
  return validateQaEvidenceSummaryJson(rebased);
}

/** Flow lifecycle adapter: scheduling and selection remain with the invocation owner. */
export async function createQaSuiteEvidenceInvocation(
  params: QaSuiteRunParams | undefined,
  context: Pick<
    QaSuiteResolvedRunContext,
    "repoRoot" | "outputDir" | "selectedScenarios" | "providerMode" | "primaryModel" | "transportId"
  >,
) {
  const launch = structuredClone(
    params?.evidenceAnchors?.[0]?.launch ??
      (await captureQaEvidenceLaunchIdentity(context.repoRoot)),
  );
  const channel =
    params?.channelId ?? params?.channelDriverSelection?.channel ?? context.transportId;
  const invocation = createQaEvidenceInvocation({
    scenarios: context.selectedScenarios,
    channel,
    launch,
    anchors: params?.evidenceAnchors,
    continuation: params?.evidenceContinuation,
  });
  const snapshot = () =>
    invocation.snapshot({
      generatedAt: new Date().toISOString(),
      evidenceMode: params?.evidenceMode,
    });
  const publish = () => params?.onEvidence?.(snapshot());
  const recordedResults = new Map<string, QaSuiteScenarioResult>();
  publish();

  async function record(
    index: number,
    id: string,
    result: QaSuiteScenarioResult,
    options: {
      diagnostic?: boolean;
      env?: QaSuiteEnvironment;
      selectedId?: string;
      importedEntries?: readonly QaEvidenceSummaryEntry[];
    } = {},
  ) {
    const scenario = context.selectedScenarios[index];
    if (!scenario) {
      throw new Error(`unknown scheduled flow scenario ${index}`);
    }
    const observed = options.env?.gateway.evidenceIdentity;
    const runtimeIdentity: QaEvidenceIdentity | null = observed
      ? {
          source: { ref: null, integrity: null },
          runtime: { id: "openclaw", version: observed.version },
          package: null,
          protocol: `gateway:${observed.protocol}`,
          // The adapter's configured account is not a target acknowledgement.
          accountRef: null,
          // A connected local gateway does not prove live-channel/provider delivery.
          proofClass: null,
        }
      : null;
    const relativePath = path.join("artifacts", "occurrences", `${id}.json`);
    const artifactPath = path.join(context.outputDir, relativePath);
    const recordedResult = { ...result, evidenceOccurrenceId: id };
    const content = `${JSON.stringify({ result: recordedResult, launch, runtime: runtimeIdentity }, null, 2)}\n`;
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    // Attempt artifacts are never overwritten by retries or same-label instances.
    await fs.writeFile(artifactPath, content, { flag: "wx", mode: 0o600 });
    const artifact = {
      kind: "scenario-observation",
      path: relativePath.split(path.sep).join("/"),
      source: "qa-suite",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const preparedId = `${id}:prepared`;
    const runtimeId = `${id}:runtime`;
    const receipts = [
      { id: preparedId, phase: "prepared" as const, identity: launch, artifact },
      ...(runtimeIdentity
        ? [{ id: runtimeId, phase: "runtime" as const, identity: runtimeIdentity, artifact }]
        : []),
    ];
    const rows = buildQaSuiteEvidenceSummary({
      artifactPaths: [{ kind: artifact.kind, path: artifact.path }],
      channelId: channel,
      channelDriver: params?.channelDriver,
      generatedAt: new Date().toISOString(),
      env: {
        ...process.env,
        ...(launch.source.ref ? { OPENCLAW_QA_REF: launch.source.ref } : {}),
      },
      primaryModel: context.primaryModel,
      providerMode: context.providerMode,
      repoRoot: context.repoRoot,
      scenarioDefinitions: [scenario],
      scenarioResults: [result],
    }).entries;
    invocation.complete(id, {
      status: result.status === "skip" ? "skipped" : result.status,
      receipts,
      entries: (options.importedEntries ?? rows).map((entry) => ({
        ...entry,
        ...(options.diagnostic ? { coverage: [] } : {}),
        binding: {
          occurrenceId: id,
          assertionId: null,
          receiptId: options.importedEntries ? null : runtimeIdentity ? runtimeId : preparedId,
        },
        effective: true,
      })),
    });
    const selectedId = invocation.select(index, options.selectedId ?? id);
    recordedResults.set(id, recordedResult);
    publish();
    if (selectedId === id) return recordedResult;
    if (result.evidenceOccurrenceId === selectedId) return structuredClone(result);
    const retained = recordedResults.get(selectedId);
    if (retained) return structuredClone(retained);
    const selected = invocation.selectedObservation(index)!;
    const receipt = selected.occurrence.receipts.find(
      (item) =>
        item.artifact.source === "qa-suite" && item.artifact.kind === "scenario-observation",
    );
    if (!receipt) throw new Error("selected flow result has no captured artifact");
    const bytes = await fs.readFile(path.resolve(context.outputDir, receipt.artifact.path));
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.artifact.sha256) {
      throw new Error("selected flow result artifact changed");
    }
    // SAFETY: This owner's immutable result artifact matches its recorded hash; selection is checked below.
    const saved = JSON.parse(bytes.toString()) as { result: QaSuiteScenarioResult };
    if (
      saved.result.evidenceOccurrenceId !== selectedId ||
      saved.result.status !==
        (selected.occurrence.terminalStatus === "skipped"
          ? "skip"
          : selected.occurrence.terminalStatus)
    ) {
      throw new Error("selected flow result artifact disagrees with its observation");
    }
    recordedResults.set(selectedId, saved.result);
    return structuredClone(saved.result);
  }

  return { invocation, record, snapshot, publish };
}
