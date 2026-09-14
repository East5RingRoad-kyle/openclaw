import { createHash } from "node:crypto";
import path from "node:path";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import type { HandoffProcessIdentity } from "./update-managed-service-handoff-schema.js";
import { readWindowsProcessArgsSync } from "./windows-port-pids.js";

const WINDOWS_ARGV_IDENTITY_PREFIX = "win32-argv-sha256:";
const WINDOWS_ARGV_IDENTITY_PATTERN = /^win32-argv-sha256:[a-f0-9]{64}$/;

function windowsArgvIdentity(argv: readonly string[]): string | null {
  if (!argv[0]) {
    return null;
  }
  const normalized = [path.win32.normalize(argv[0]).toLowerCase(), ...argv.slice(1)];
  return (
    WINDOWS_ARGV_IDENTITY_PREFIX +
    createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
  );
}

/** Process facts shared by lease admission, live ownership, and cleanup. */
export function createManagedHandoffProcessIdentityReader(options: {
  env: NodeJS.ProcessEnv;
  onWarning?: (pid: number, message: string) => void;
}) {
  const warnedIdentityPids = new Set<number>();
  // Lease reclamation needs ESRCH evidence; other probe errors cannot prove absence.
  const isPidAlive = (pid: number) => !isPidDefinitelyDead(pid);

  function readProcessStartIdentity(pid: number): string | null {
    const start = getFileLockProcessStartTime(pid, {
      ...options.env,
      LC_ALL: "C",
      TZ: "UTC",
    });
    return start === null ? null : String(start);
  }

  function readWindowsArgvIdentity(pid: number): string | null {
    const argv =
      pid === process.pid
        ? [process.argv0, ...process.execArgv, ...process.argv.slice(1)]
        : readWindowsProcessArgsSync(pid, undefined, options.env);
    return argv ? windowsArgvIdentity(argv) : null;
  }
  function inspectProcessIdentity(
    value: HandoffProcessIdentity,
  ): "live" | "dead" | "unknown" | "mismatch" {
    if (!isPidAlive(value.pid)) {
      return "dead";
    }
    if (process.platform === "win32" && WINDOWS_ARGV_IDENTITY_PATTERN.test(value.startIdentity)) {
      const argvIdentity = readWindowsArgvIdentity(value.pid);
      return argvIdentity === null
        ? "unknown"
        : argvIdentity === value.startIdentity
          ? "live"
          : "mismatch";
    }
    const start = readProcessStartIdentity(value.pid);
    return start === null ? "unknown" : start === value.startIdentity ? "live" : "dead";
  }
  function processState(value: HandoffProcessIdentity): "live" | "dead" | "unknown" {
    const state = inspectProcessIdentity(value);
    // Launcher disagreement revokes attribution; it cannot prove process death.
    return state === "mismatch" ? "unknown" : state;
  }
  function isProcessIdentityCurrent(value: HandoffProcessIdentity, ownedCustody = false): boolean {
    const state = inspectProcessIdentity(value);
    return (
      state === "live" ||
      (state === "unknown" &&
        ownedCustody &&
        process.platform === "win32" &&
        WINDOWS_ARGV_IDENTITY_PATTERN.test(value.startIdentity))
    );
  }
  function processIdentity(pid = process.pid, argv?: readonly string[]): HandoffProcessIdentity {
    const startIdentity = readProcessStartIdentity(pid);
    if (startIdentity !== null) {
      return { pid, startIdentity };
    }
    const attribution =
      process.platform === "win32"
        ? argv
          ? windowsArgvIdentity(argv)
          : readWindowsArgvIdentity(pid)
        : null;
    if (attribution) {
      if (!warnedIdentityPids.has(pid)) {
        warnedIdentityPids.add(pid);
        const message = `Native Windows creation-time queries returned no identity for PID ${pid}; continuing with PID and launcher attribution.`;
        try {
          if (options.onWarning) {
            options.onWarning(pid, message);
          }
        } catch {
          // Diagnostic persistence cannot interrupt an attributed update process.
        }
      }
      return { pid, startIdentity: attribution, startIdentitySource: "argv-sha256" };
    }
    throw new Error("managed handoff process start identity is unavailable");
  }
  return {
    isPidAlive,
    readProcessStartIdentity,
    processIdentity,
    processState,
    isProcessIdentityCurrent,
  };
}
