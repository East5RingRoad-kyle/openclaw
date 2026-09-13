// Qa Lab tests bound the evidence checkout ref git probe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  // Node's execFile promisify contract returns both streams, not just stdout.
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFileMock(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

import {
  captureQaEvidenceLaunchIdentity,
  captureQaEvidenceSourceIdentity,
  resolveQaEvidenceEnvironment,
} from "./evidence-environment.js";

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
});

describe("captured evidence source identity", () => {
  it("binds dirty tracked and untracked bytes while retaining the actual committed ref", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-source-identity-"));
    let patch = "tracked change";
    let untracked = "new.ts\0";
    execFileMock.mockImplementation((_command, args, _options, callback) =>
      callback(
        null,
        args[0] === "rev-parse" ? "actual-head\n" : args[0] === "diff" ? patch : untracked,
        "",
      ),
    );
    try {
      await fs.writeFile(path.join(root, "new.ts"), "first");
      const first = await captureQaEvidenceSourceIdentity(root);
      expect(first).toMatchObject({ gitSha: "actual-head", sourceDirty: true });
      expect(first.sourcePatchSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await captureQaEvidenceSourceIdentity(root)).toEqual(first);
      await fs.writeFile(path.join(root, "new.ts"), "replacement");
      expect((await captureQaEvidenceSourceIdentity(root)).sourcePatchSha256).not.toBe(
        first.sourcePatchSha256,
      );
      untracked = "";
      patch = "";
      expect(await captureQaEvidenceSourceIdentity(root)).toEqual({
        gitSha: "actual-head",
        sourceDirty: false,
        sourcePatchSha256: null,
      });
      expect((await captureQaEvidenceLaunchIdentity(root)).source).toEqual({
        ref: "actual-head",
        integrity: "git:actual-head",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed source observation unknown instead of borrowing inherited evidence labels", async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error("source unavailable"), "", ""),
    );
    const identity = await captureQaEvidenceLaunchIdentity("unavailable-checkout");
    expect(identity).toEqual({
      source: { ref: null, integrity: null },
      runtime: { id: "node", version: process.version },
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    });
  });
});

describe("resolveQaEvidenceEnvironment", () => {
  it("bounds the checkout ref git probe with a timeout", () => {
    execFileSyncMock.mockReturnValue("abc123\n");

    const environment = resolveQaEvidenceEnvironment({ env: {} });

    expect(environment.ref).toBe("abc123");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      expect.objectContaining({
        killSignal: "SIGKILL",
        timeout: 5_000,
      }),
    );
  });

  it("falls back to GITHUB_SHA when the git probe times out", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
    });

    const environment = resolveQaEvidenceEnvironment({ env: { GITHUB_SHA: "fallbacksha" } });

    expect(environment.ref).toBe("fallbacksha");
  });

  it("prefers OPENCLAW_QA_REF without invoking git", () => {
    const environment = resolveQaEvidenceEnvironment({
      env: { OPENCLAW_QA_REF: "qa-ref", GITHUB_SHA: "fallbacksha" },
    });

    expect(environment.ref).toBe("qa-ref");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns a null ref when the probe fails and no env fallback exists", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git unavailable");
    });

    const environment = resolveQaEvidenceEnvironment({ env: {} });

    expect(environment.ref).toBeNull();
  });
});
