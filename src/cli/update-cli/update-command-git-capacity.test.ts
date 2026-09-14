import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as diskSpace from "../../infra/disk-space.js";
import { assessUpdateDiskSpace } from "../../infra/update-disk-space.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { updateGitInstall } from "./update-command-git.js";

afterEach(() => vi.restoreAllMocks());

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await processRunner.runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

async function fixture(base: string) {
  const root = path.join(base, "checkout");
  const stateDir = path.join(base, "state");
  await fs.mkdir(root);
  await fs.mkdir(stateDir);
  const env = {
    HOME: base,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    TMPDIR: base,
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.1"}');
  await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
  await fs.writeFile(
    path.join(root, ".gitignore"),
    "dist/\ndist-runtime/\nnode_modules/\n.artifacts/\n.local/\ntmp/\n.claude/\n",
  );
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "OpenClaw Test");
  await git(root, "config", "user.email", "openclaw@example.com");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return { root, env };
}

async function sparseFile(file: string, mib: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "");
  await fs.truncate(file, mib * 1024 * 1024);
}

function availableSpace(bytes: number) {
  return vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: targetPath,
    deviceId: 1,
    availableBytes: bytes,
    totalBytes: 1024 ** 3,
  }));
}

it.each(["ignored", "tracked", "runtime", "symlink", "npm-symlink", "split-volume"] as const)(
  "charges only Git checkout and runtime writes for %s data",
  async (scenario) => {
    await withTestDir({ prefix: "git-update-capacity-" }, async (base) => {
      const { root, env } = await fixture(base);
      if (scenario === "tracked" || scenario === "split-volume") {
        await sparseFile(path.join(root, "source.bin"), 40);
        await git(root, "add", "source.bin");
        await git(root, "commit", "-m", "tracked payload");
      } else if (scenario === "runtime") {
        await sparseFile(path.join(root, "dist", "runtime.bin"), 32);
      } else if (scenario === "symlink") {
        const external = path.join(base, "external");
        await sparseFile(path.join(external, "payload.bin"), 96);
        await fs.mkdir(path.join(root, "node_modules"));
        await fs.symlink(external, path.join(root, "node_modules", "external"), "junction");
      } else {
        for (const directory of [".local", "tmp", ".claude"]) {
          await sparseFile(path.join(root, directory, "operator.bin"), 32);
        }
      }
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      if (scenario === "npm-symlink") {
        await fs.mkdir(globalRoot, { recursive: true });
        await fs.symlink(root, packageRoot, "junction");
      }
      const capacity = availableSpace(220 * 1024 * 1024);
      if (scenario === "split-volume") {
        capacity.mockImplementation((targetPath) => ({
          targetPath,
          checkedPath: targetPath,
          deviceId: targetPath === root ? 1 : 2,
          availableBytes: (targetPath === root ? 120 : 8192) * 1024 * 1024,
          totalBytes: 16 * 1024 ** 3,
        }));
      }
      const before = await git(root, "status", "--porcelain");
      const result = await assessUpdateDiskSpace({
        root,
        ...(scenario === "npm-symlink"
          ? { installTarget: { manager: "npm" as const, command: "npm", globalRoot, packageRoot } }
          : { gitRoot: root }),
        config: {},
        env,
      });
      expect(result.exitCode, result.stderrTail ?? result.stdoutTail).toBe(
        scenario === "runtime" || scenario === "split-volume" ? 1 : 0,
      );
      expect(await git(root, "status", "--porcelain")).toBe(before);
      expect(await fs.readdir(env.OPENCLAW_STATE_DIR)).toEqual(["openclaw.json"]);
    });
  },
);

it.each([
  { current: true, inspection: false },
  { current: true, inspection: true },
  { current: false, inspection: false },
  { current: false, inspection: true },
])(
  "admits Git capacity after the resolved no-op (current=$current, inspection=$inspection)",
  async ({ current, inspection }) => {
    await withTestDir({ prefix: "git-update-noop-capacity-" }, async (base) => {
      const { root, env } = await fixture(base);
      const before = await git(root, "rev-parse", "HEAD");
      let target = before;
      if (!current) {
        await fs.writeFile(path.join(root, "candidate.txt"), "candidate\n");
        await git(root, "add", "candidate.txt");
        await git(root, "commit", "-m", "candidate");
        target = await git(root, "rev-parse", "HEAD");
        await git(root, "checkout", "--detach", before);
      }
      const capacity = availableSpace(0);
      const allocate = vi.spyOn(fs, "mkdtemp");
      const beforeGitMutation = vi.fn();
      const validateCandidate = vi.fn();
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const originalArgv = process.argv;
      process.argv = [process.execPath, path.join(root, "openclaw.mjs")];
      try {
        const result = await updateGitInstall({
          root,
          switchToGit: false,
          installKind: "git",
          timeoutMs: 5000,
          startedAt: Date.now(),
          progress: {},
          channel: "dev",
          tag: "latest",
          devTarget: { mode: "detached", ref: target },
          beforeGitMutation,
          validateCandidate,
          inspectGitTarget: inspection ? async () => {} : undefined,
          getManagedServiceEnv: () => undefined,
          capacityEnv: env,
          jsonMode: true,
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
        });
        expect(result).toMatchObject(
          current
            ? { status: "skipped", reason: "already-current" }
            : { status: "error", reason: "insufficient-disk-space" },
        );
        expect(capacity.mock.calls.length === 0).toBe(current);
        expect(
          allocate.mock.calls.some(
            ([prefix]) => prefix.includes("update-preflight-") || prefix.includes("ocu-pf-"),
          ),
        ).toBe(false);
        expect(beforeGitMutation).not.toHaveBeenCalled();
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(await git(root, "rev-parse", "HEAD")).toBe(before);
      } finally {
        process.argv = originalArgv;
      }
    });
  },
);
