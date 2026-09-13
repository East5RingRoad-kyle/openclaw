import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
let repoRoot: string;
let outputDir: string;

const mocks = vi.hoisted(() => ({
  readQaBootstrapScenarioCatalog: vi.fn(),
  runQaFlowSuiteStandard: vi.fn(),
  writeQaSuiteArtifacts: vi.fn(),
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-catalog.js")>()),
  readQaBootstrapScenarioCatalog: mocks.readQaBootstrapScenarioCatalog,
}));

vi.mock("./suite-planning.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-planning.js")>()),
  resolveQaSuiteOutputDir: vi.fn(
    async (_repoRoot: string, requestedOutputDir?: string) => requestedOutputDir ?? "/qa-output",
  ),
}));

vi.mock("./suite-run-standard.js", () => ({
  runQaFlowSuiteStandard: mocks.runQaFlowSuiteStandard,
}));

vi.mock("./suite-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-artifacts.js")>()),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));

function createControlUiTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: createQaBusState(),
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  repoRoot = await tempDirs.makeTempDir("qa-parity-control-ui-");
  outputDir = path.join(repoRoot, "output");
  vi.clearAllMocks();
  mocks.readQaBootstrapScenarioCatalog.mockReturnValue({
    scenarios: [
      makeQaSuiteTestScenario("runtime-channel", { surface: "channel" }),
      makeQaSuiteTestScenario("runtime-control-ui", { surface: "control-ui" }),
    ],
  });
  mocks.runQaFlowSuiteStandard.mockImplementation(
    async (
      params: QaSuiteRunParams | undefined,
      context: QaSuiteResolvedRunContext,
    ): Promise<QaSuiteResult> => ({
      outputDir: context.outputDir,
      evidencePath: "/qa-output/qa-evidence.json",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
      report: "",
      scenarios: context.selectedScenarios.map((scenario) => ({
        name: scenario.title,
        status: "pass",
        steps: [],
      })),
      startedScenarioIds: context.selectedScenarios.map((scenario) => scenario.id),
      watchUrl: "http://127.0.0.1:43123",
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }),
  );
  mocks.writeQaSuiteArtifacts.mockImplementation(async (params) => ({
    evidence: params.recordedEvidence,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  }));
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runtime parity Control UI ownership", () => {
  it("preserves repeated parity starts without merging progress slots", async () => {
    const lab = createControlUiTestLab();
    const result = await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      concurrency: 1,
      scenarioIds: ["runtime-channel", "runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
    });
    expect(mocks.runQaFlowSuiteStandard).toHaveBeenCalledTimes(4);
    expect(result.startedScenarioIds).toEqual(["runtime-channel", "runtime-channel"]);
    const snapshots = vi
      .mocked(lab.setScenarioRun)
      .mock.calls.map(([next]) => next?.scenarios.map((item) => item.status));
    expect(snapshots).toContainEqual(["pass", "pending"]);
    expect(snapshots.at(-1)).toEqual(["pass", "pass"]);
  });

  it.each([
    {
      label: "a non-Control UI scenario by default",
      scenarioId: "runtime-channel",
      explicit: undefined,
      enabled: false,
    },
    {
      label: "an interactive non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: true,
      enabled: true,
    },
    {
      label: "an explicitly disabled non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: false,
      enabled: false,
    },
    {
      label: "a Control UI scenario by default",
      scenarioId: "runtime-control-ui",
      explicit: undefined,
      enabled: true,
    },
    {
      label: "an explicitly disabled Control UI scenario",
      scenarioId: "runtime-control-ui",
      explicit: false,
      enabled: false,
    },
  ])("preserves Control UI policy in both runtime cells for $label", async (testCase) => {
    const lab = createControlUiTestLab();

    const result = await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      scenarioIds: [testCase.scenarioId],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      ...(testCase.explicit === undefined ? {} : { controlUiEnabled: testCase.explicit }),
    });

    expect(
      mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => ({
        runtime: params.forcedRuntime,
        controlUiEnabled: params.controlUiEnabled,
      })),
    ).toEqual([
      { runtime: "openclaw", controlUiEnabled: testCase.enabled },
      { runtime: "codex", controlUiEnabled: testCase.enabled },
    ]);
    expect(result.startedScenarioIds).toEqual([testCase.scenarioId]);
  });

  it("forwards config mutation to both runtime cells", async () => {
    const lab = createControlUiTestLab();
    const mutateConfig = vi.fn((config: OpenClawConfig) => config);

    await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      mutateConfig,
    });

    expect(mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => params.mutateConfig)).toEqual([
      mutateConfig,
      mutateConfig,
    ]);
  });

  it("forwards the same candidate command object to both runtime cells", async () => {
    const lab = createControlUiTestLab();
    const sutOpenClawCommand = {
      executablePath: "/qa-repo/dist/index.mjs",
      argsPrefix: ["--qa"],
      cwd: "/qa-repo",
      usePackagedPlugins: true,
    };

    await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      sutOpenClawCommand,
      lab,
      startLab: async () => lab,
    });

    expect(mocks.runQaFlowSuiteStandard).toHaveBeenCalledTimes(2);
    for (const [params] of mocks.runQaFlowSuiteStandard.mock.calls) {
      expect(params.sutOpenClawCommand).toBe(sutOpenClawCommand);
    }
  });

  it("retains both real child observations and selects one zero-claim comparison", async () => {
    const original = mocks.runQaFlowSuiteStandard.getMockImplementation()!;
    mocks.runQaFlowSuiteStandard.mockImplementation(async (params, context) => {
      const result = await original(params, context);
      const recording = await createQaSuiteEvidenceInvocation(params, context);
      const id = recording.invocation.begin(0);
      result.scenarios[0] = await recording.record(0, id, result.scenarios[0]!);
      result.evidence = recording.snapshot();
      return result;
    });
    const lab = createControlUiTestLab();
    const result = await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
    });
    const evidence = result.evidence as QaEvidenceSummaryV3Json;
    expect(projectQaEvidenceScenarioOutcomes(evidence)).toEqual([
      {
        scenarioId: "runtime-channel",
        scenarioInstanceId: evidence.occurrences[0]!.id,
        occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
        status: "pass",
      },
    ]);
    expect(evidence.entries).toHaveLength(3);
    expect(evidence.entries.at(-1)?.coverage).toEqual([]);
    expect(evidence.entries.every((entry) => entry.effective)).toBe(true);
    const childPaths = mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => params.outputDir);
    expect(new Set(childPaths).size).toBe(2);
    for (const occurrence of evidence.occurrences) {
      for (const receipt of occurrence.receipts) {
        expect(receipt.phase).toBe("prepared");
        expect(receipt.identity.package).toBeNull();
        expect(receipt.identity.protocol).toBeNull();
        expect(receipt.identity.accountRef).toBeNull();
        expect(receipt.identity.proofClass).toBeNull();
        const bytes = await fs.readFile(path.resolve(outputDir, receipt.artifact.path));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
      }
    }
  });

  it("retains a completed child before a later child throws and records the parent failure", async () => {
    const original = mocks.runQaFlowSuiteStandard.getMockImplementation()!;
    const failure = new Error("runtime cell failed before its result");
    let calls = 0;
    mocks.runQaFlowSuiteStandard.mockImplementation(async (params, context) => {
      const recording = await createQaSuiteEvidenceInvocation(params, context);
      if (++calls === 2) {
        throw failure;
      }
      const result = await original(params, context);
      result.scenarios[0] = await recording.record(
        0,
        recording.invocation.begin(0),
        result.scenarios[0]!,
      );
      result.evidence = recording.snapshot();
      return result;
    });
    let evidence: QaEvidenceSummaryV3Json | undefined;
    const lab = createControlUiTestLab();
    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        outputDir,
        providerMode: "mock-openai",
        scenarioIds: ["runtime-channel"],
        runtimePair: ["openclaw", "codex"],
        lab,
        startLab: async () => lab,
        onEvidence: (summary) => {
          evidence = structuredClone(summary);
        },
      }),
    ).rejects.toBe(failure);
    expect(evidence?.entries.map((entry) => entry.result.status)).toEqual(["pass", "fail"]);
    expect(evidence?.entries.at(-1)?.coverage).toEqual([]);
    expect(projectQaEvidenceScenarioOutcomes(evidence!)).toEqual([
      expect.objectContaining({ scenarioId: "runtime-channel", status: "fail" }),
    ]);
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
  });
});
