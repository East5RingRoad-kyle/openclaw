import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { resolveQaEvidenceContainment } from "./evidence-containment.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  QA_TEST_RUNNER_DEFAULTS,
  resolveScriptAttemptOutputDir,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
afterEach(() => harness.cleanup());

describe("native attempt child bundles", () => {
  it.each(["pass", "fail", "blocked", "skipped"] as const)(
    "retains an actual independent v3 subprocess across a %s retry in full and slim projections",
    async (status) => {
      const root = await harness.makeTempRepo("qa-native-child-");
      const script = path.join(root, "producer.mjs");
      const api = pathToFileURL(path.resolve("extensions/qa-lab/api.ts")).href;
      await fs.writeFile(
        script,
        `
import fs from "node:fs/promises";
import path from "node:path";
import { createQaEvidenceInvocation } from ${JSON.stringify(api)};
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const status = value("--status");
const output = value("--artifact-base");
const source = { ref: null, integrity: null };
const launch = {
  source, runtime: { id: "node", version: process.version }, package: null,
  protocol: null, accountRef: null, proofClass: null,
};
const scenarios = ["same", "other", "same"].map((id) => ({
  id, execution: { kind: "script" },
}));
const owner = createQaEvidenceInvocation({ scenarios, channel: null, launch });
for (const [index, result] of [status, "pass"].entries()) {
  const id = owner.begin(index);
  owner.complete(id, { status: result, entries: [{
    test: { id: scenarios[index].id, title: "Actual child check", kind: "script-test" },
    coverage: [
      { id: "qa.coverage", role: "primary" },
      { id: "qa.reporting", role: "primary" },
      { id: "other.claim", role: "primary" },
    ],
    result: { status: result },
  }] });
  owner.select(index, id);
}
await fs.writeFile(path.join(output, "qa-evidence.json"),
  JSON.stringify(owner.snapshot({ generatedAt: new Date().toISOString() })), { flag: "wx" });
console.log("child pid=" + process.pid);
process.exitCode = Number(value("--exit"));
`,
      );
      const run = async (
        nextStatus: string,
        exit: string,
        continuation?: QaEvidenceSummaryV3Json,
      ) => {
        const scenario = makeTestFileScenario("script", script);
        if (scenario.execution.kind !== "script") {
          throw new Error("expected script");
        }
        scenario.execution.args!.push("--status", nextStatus, "--exit", exit);
        return runQaTestFileScenarios({
          repoRoot: process.cwd(),
          outputDir: path.join(root, "out"),
          ...QA_TEST_RUNNER_DEFAULTS,
          scenarios: [scenario],
          commandTimeoutMs: 30_000,
          ...(continuation
            ? {
                evidenceContinuation: continuation,
                evidenceAnchors: resolveQaEvidenceContainment(
                  continuation.occurrences,
                  continuation.entries,
                ).rootInstances,
              }
            : {}),
        });
      };
      const first = await run("fail", "7");
      if (first.evidence.schemaVersion !== 3) {
        throw new Error("expected invocation evidence");
      }
      const firstId = first.results[0]!.evidenceOccurrenceId!;
      const captured = first.evidence.occurrences.find((item) => item.id === firstId)!;
      const receipt = captured.receipts.find((item) => item.artifact.kind === "producer-evidence")!;
      expect(receipt, await fs.readFile(first.results[0]!.logPath, "utf8")).toBeDefined();
      const originalPath = resolveQaArtifactPath(
        process.cwd(),
        process.cwd(),
        receipt.artifact.path,
      );
      const originalBytes = await fs.readFile(originalPath);
      expect(receipt.artifact.sha256).toBe(
        createHash("sha256").update(originalBytes).digest("hex"),
      );
      const original = validateQaEvidenceSummaryJson(JSON.parse(originalBytes.toString("utf8")));
      if (original.schemaVersion !== 3) {
        throw new Error("expected child v3");
      }
      expect(captured.childOccurrenceIds).toEqual(original.occurrences.map((item) => item.id));
      expect(projectQaEvidenceScenarioOutcomes(original).map((item) => item.status)).toEqual([
        "fail",
        "pass",
        null,
      ]);
      expect(new Set(original.occurrences.map((item) => item.id)).size).toBe(5);
      const second = await run(status, "0", first.evidence);
      if (second.evidence.schemaVersion !== 3) {
        throw new Error("expected invocation evidence");
      }
      expect(second.results[0]!.status).toBe(status === "pass" ? "pass" : "fail");
      if (status !== "pass") {
        expect(second.results[0]).toMatchObject({
          evidenceOccurrenceId: firstId,
          logPath: first.results[0]!.logPath,
          failureMessage: first.results[0]!.failureMessage,
        });
      }
      expect(await fs.readFile(originalPath)).toEqual(originalBytes);
      for (const occurrence of original.occurrences) {
        expect(second.evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(
          occurrence,
        );
      }
      const finalBytes = JSON.stringify(second.evidence);
      for (const evidenceMode of ["full", "slim"] as const) {
        const projected = validateQaEvidenceSummaryJson({
          ...second.evidence,
          evidenceMode,
          entries:
            evidenceMode === "full"
              ? second.evidence.entries
              : second.evidence.entries.map(({ execution: _execution, ...entry }) => entry),
        });
        expect(projectQaEvidenceScenarioOutcomes(projected)).toHaveLength(1);
        const active = getEffectiveQaEvidenceEntries(projected);
        expect(active.map((entry) => entry.result.status)).toEqual(
          status === "pass" ? ["pass", "pass", "pass"] : ["fail", "pass", "fail"],
        );
        expect(active.slice(0, 2).map((entry) => entry.coverage)).toEqual([
          [
            { id: "qa.coverage", role: "primary" },
            { id: "qa.reporting", role: "secondary" },
          ],
          [
            { id: "qa.coverage", role: "primary" },
            { id: "qa.reporting", role: "secondary" },
          ],
        ]);
        expect(active[2]!.coverage).toEqual([]);
      }
      expect(JSON.stringify(second.evidence)).toBe(finalBytes);
    },
  );

  it.each(["pass", "fail", "blocked", "skipped"] as const)(
    "selects the whole v2 producer and command attempt after %s",
    async (status) => {
      const root = await harness.makeTempRepo("qa-native-v2-retry-");
      const scenarios = [makeTestFileScenario("script", "producer.mjs")];
      const run = async (
        next: typeof status,
        exitCode: number,
        continuation?: QaEvidenceSummaryV3Json,
      ) =>
        runQaTestFileScenarios({
          repoRoot: root,
          outputDir: path.join(root, "out"),
          scenarios,
          ...QA_TEST_RUNNER_DEFAULTS,
          ...(continuation
            ? {
                evidenceContinuation: continuation,
                evidenceAnchors: resolveQaEvidenceContainment(
                  continuation.occurrences,
                  continuation.entries,
                ).rootInstances,
              }
            : {}),
          runCommand: async (command) => {
            await writeScriptProducerEvidence({
              outputDir: resolveScriptAttemptOutputDir(command),
              status: next,
              failureReason: next === "fail" ? "producer failed" : undefined,
            });
            return { exitCode, stdout: "", stderr: "" };
          },
        });
      const first = await run("fail", 7);
      if (first.evidence.schemaVersion !== 3) {
        throw new Error("expected v3 adapter");
      }
      const firstRows = structuredClone(first.evidence.entries);
      const second = await run(status, status === "fail" ? 7 : 0, first.evidence);
      expect(second.evidence.entries.slice(0, 2).map((entry) => entry.result)).toEqual(
        firstRows.map((entry) => entry.result),
      );
      expect(
        getEffectiveQaEvidenceEntries(second.evidence).map((entry) => entry.result.status),
      ).toEqual(status === "pass" ? ["pass"] : ["fail", "fail"]);
      expect(projectQaEvidenceScenarioOutcomes(second.evidence)[0]?.status).toBe(
        status === "pass" ? "pass" : "fail",
      );
    },
  );
});
