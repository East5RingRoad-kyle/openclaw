// Qa Lab plugin module resolves evidence runtime metadata.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { QaEvidenceIdentity } from "./evidence-summary.js";

// A wedged git (NFS hang, credential helper prompt) must not block evidence
// metadata resolution; the caller already falls back to GITHUB_SHA/null.
const QA_EVIDENCE_GIT_PROBE_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

/** The source owner captures the actual checkout, including uncommitted inputs. */
export async function captureQaEvidenceSourceIdentity(repoRoot: string) {
  const options = {
    cwd: repoRoot,
    encoding: "utf8" as const,
    timeout: QA_EVIDENCE_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  };
  const { stdout: ref } = await execFileAsync("git", ["rev-parse", "HEAD"], options);
  const [{ stdout: patch }, { stdout: untrackedOutput }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "HEAD", "--", "."], options),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options),
  ]);
  const gitSha = ref.trim();
  const untracked = untrackedOutput.split("\0").filter(Boolean).toSorted();
  if (!patch.length && !untracked.length) {
    return { gitSha, sourceDirty: false, sourcePatchSha256: null };
  }
  const hash = createHash("sha256").update(patch);
  for (const relativePath of untracked) {
    const filePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(filePath);
    hash.update(`\0${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(await fs.readlink(filePath));
    } else if (stat.isFile()) {
      hash.update(await fs.readFile(filePath));
    }
  }
  return { gitSha, sourceDirty: true, sourcePatchSha256: hash.digest("hex") };
}

function resolveQaEvidenceCheckoutRef(repoRoot?: string) {
  try {
    const ref = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot ?? process.cwd(),
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: QA_EVIDENCE_GIT_PROBE_TIMEOUT_MS,
    }).trim();
    return ref || undefined;
  } catch {
    return undefined;
  }
}

export function resolveQaEvidenceEnvironment(params: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}) {
  return {
    // GitHub's GITHUB_SHA describes the workflow event, not necessarily the
    // checked-out ref selected by a manual or remote QA run.
    ref:
      params.env?.OPENCLAW_QA_REF?.trim() ||
      resolveQaEvidenceCheckoutRef(params.repoRoot) ||
      params.env?.GITHUB_SHA?.trim() ||
      null,
    os: process.platform,
    nodeVersion: process.version,
  };
}

/** Capture the launching checkout/process, never a reporter's inherited label. */
export async function captureQaEvidenceLaunchIdentity(
  repoRoot: string,
): Promise<QaEvidenceIdentity> {
  const source = await captureQaEvidenceSourceIdentity(repoRoot).catch(() => null);
  return {
    source: {
      ref: source?.gitSha ?? null,
      integrity: source
        ? `git:${source.gitSha}${source.sourcePatchSha256 ? `+sha256:${source.sourcePatchSha256}` : ""}`
        : null,
    },
    runtime: { id: "node", version: process.version },
    // Installed target/package/protocol facts need their own producer receipt.
    package: null,
    protocol: null,
    accountRef: null,
    proofClass: null,
  };
}
