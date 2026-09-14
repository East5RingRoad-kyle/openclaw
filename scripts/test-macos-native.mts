// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

await runWithFailedTrailer("macos-native", async () => {
  const env = process.env;
  // Invocation checks prevent accidental local use; these markers are not a sandbox.
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "macOS" ||
    !env.RUNNER_TEMP ||
    !env.HOME ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Run native app tests in the disposable macos-swift GitHub CI job, never on an operator desktop.",
    );
  }
  const [profileMode, ...args] = process.argv.slice(2);
  if (profileMode !== "default" && profileMode !== "named") {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  if (!args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }

  // Keep paths short for tools honoring TMPDIR, independently of RUNNER_TEMP's length.
  // Foundation's Darwin temp directory belongs to the disposable OS worker instead.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  try {
    const home = path.join(root, "home");
    const state = path.join(root, "state");
    const tmp = path.join(root, "tmp");
    for (const dir of [home, state, tmp]) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "DEVELOPER_DIR",
      "SDKROOT",
      "TOOLCHAINS",
      "LANG",
      "LC_ALL",
      "TERM",
      "DYLD_FRAMEWORK_PATH",
      "DYLD_LIBRARY_PATH",
      "LLVM_PROFILE_FILE",
      "SWIFTPM_MODULECACHE_OVERRIDE",
      "CLANG_MODULE_CACHE_PATH",
      // Preserve Actions' orphan-cleanup correlation through the isolated child env.
      "RUNNER_TRACKING_ID",
    ]) {
      if (env[key] !== undefined) {
        childEnv[key] = env[key];
      }
    }
    Object.assign(childEnv, {
      CI: "true",
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: `${tmp}/`,
      TMP: tmp,
      TEMP: tmp,
      // The full suite protects default-profile lifecycle behavior. Named-profile
      // construction is exercised separately; both use the disposable runner's account.
      OPENCLAW_PROFILE: profileMode === "named" ? `test-${randomUUID()}` : "default",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    });

    // Keep SwiftPM's build cache available without inheriting the runner's app state.
    const cache = path.join(home, "Library/Caches");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(env.HOME, "Library/Caches/org.swift.swiftpm"),
      path.join(cache, "org.swift.swiftpm"),
    );
    const keychain = path.join(home, "Library/Keychains/native-tests.keychain-db");
    // Security writes its user preferences beneath HOME but does not create the parent.
    for (const dir of [path.dirname(keychain), path.join(home, "Library/Preferences")]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const run = async (
      bin: string,
      commandArgs: string[],
      timeoutMs?: number,
      output?: Buffer[],
      commandEnv = childEnv,
    ) => {
      canRemove = false;
      const code = await runManagedCommand({
        bin,
        args: commandArgs,
        env: commandEnv,
        stdio: output ? ["inherit", "pipe", "inherit"] : "inherit",
        onReady: output
          ? (child) => child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
          : undefined,
        requireProcessTreeExit: true,
        timeoutMs,
      });
      canRemove = true;
      return code;
    };
    // Empty test-only password prevents prompts; no automatic locking while the suite runs.
    // Only the user domain changes. Common/dynamic Keychains still require a disposable host.
    try {
      for (const command of [
        ["create-keychain", "-p", "", keychain],
        ["unlock-keychain", "-p", "", keychain],
        ["set-keychain-settings", keychain],
        ["list-keychains", "-d", "user", "-s", keychain],
        ["default-keychain", "-d", "user", "-s", keychain],
      ]) {
        process.exitCode = await run("security", command, 30_000);
        if (process.exitCode !== 0) {
          console.error(`[macos-native] security ${command[0]} failed (exit ${process.exitCode})`);
          return;
        }
      }
      const eventStreamPath = path.join(root, "swift-testing-events.jsonl");
      process.exitCode = await run("swift", [
        "test",
        ...args,
        "--event-stream-output-path",
        eventStreamPath,
        "--event-stream-version",
        "6.3",
      ]);
      if (process.exitCode === 0) {
        try {
          let phase: "pending" | "running" | "ended" = "pending";
          const lines = fs.readFileSync(eventStreamPath, "utf8").split("\n");
          if (lines.at(-1) === "") {
            lines.pop();
          }
          for (const line of lines) {
            const record: unknown = JSON.parse(line);
            if (typeof record !== "object" || record === null || !("kind" in record)) {
              throw new Error("Invalid Swift Testing event record");
            }
            // Swift Testing permits new record and event kinds without a schema change.
            if (record.kind !== "event" && record.kind !== "test") {
              continue;
            }
            if (!("version" in record) || record.version !== "6.3.0") {
              throw new Error("Expected Swift Testing event schema 6.3.0");
            }
            if (record.kind !== "event") {
              continue;
            }
            if (
              !("payload" in record) ||
              typeof record.payload !== "object" ||
              record.payload === null ||
              !("kind" in record.payload) ||
              typeof record.payload.kind !== "string"
            ) {
              throw new Error("Invalid Swift Testing event payload");
            }
            if (record.payload.kind === "runStarted") {
              if (phase !== "pending") {
                throw new Error("Unexpected Swift Testing runStarted");
              }
              phase = "running";
            } else if (record.payload.kind === "runEnded") {
              if (phase !== "running") {
                throw new Error("Unexpected Swift Testing runEnded");
              }
              phase = "ended";
            }
          }
          if (phase !== "ended") {
            throw new Error("Swift Testing did not finish its run");
          }
        } catch (error) {
          process.exitCode = 1;
          console.error("[macos-native] Swift exited 0 without valid test completion", error);
        }
        // Temporary named-run exit probe; remove once the early exit is attributed.
        if (process.exitCode === 1 && profileMode === "named") {
          try {
            const xcodePaths = { swift: "", lldb: "", platform: "" };
            for (const [name, query] of [
              ["swift", ["--find", "swift"]],
              ["lldb", ["--find", "lldb"]],
              ["platform", ["--sdk", "macosx", "--show-sdk-platform-path"]],
            ] as const) {
              const output: Buffer[] = [];
              const code = await run("xcrun", [...query], 30_000, output);
              const resolved = Buffer.concat(output).toString("utf8").trim();
              if (code !== 0 || !path.isAbsolute(resolved)) {
                throw new Error(`Could not resolve selected Xcode ${name} (exit ${code})`);
              }
              xcodePaths[name] = resolved;
            }
            const buildPath = path.resolve("apps/macos/.build/debug");
            const platformDeveloper = path.join(xcodePaths.platform, "Developer");
            const diagnosticEnv = {
              ...childEnv,
              DYLD_FRAMEWORK_PATH: [
                childEnv.DYLD_FRAMEWORK_PATH,
                path.join(platformDeveloper, "Library/Frameworks"),
                path.join(platformDeveloper, "Library/PrivateFrameworks"),
              ]
                .filter(Boolean)
                .join(":"),
              DYLD_LIBRARY_PATH: [
                childEnv.DYLD_LIBRARY_PATH,
                buildPath,
                path.join(platformDeveloper, "usr/lib"),
              ]
                .filter(Boolean)
                .join(":"),
              LLVM_PROFILE_FILE: path.join(root, "named-diagnostic-%m.%p.profraw"),
            };
            const diagnosticCode = await run(
              xcodePaths.lldb,
              [
                "--batch",
                "--no-lldbinit",
                "-o",
                "version",
                "-o",
                'breakpoint set --name exit --name _exit -C "register read x0" -C "thread backtrace all" --auto-continue true',
                "-o",
                'breakpoint set --name CFRunLoopStop --thread-index 1 -C "register read x0" -C "thread backtrace all" --auto-continue true',
                "-o",
                "run",
                "-o",
                "process status",
                "-o",
                "breakpoint list 1 2",
                "-k",
                "thread backtrace all",
                "--",
                path.resolve(
                  path.dirname(xcodePaths.swift),
                  "../libexec/swift/pm/swiftpm-testing-helper",
                ),
                "--test-bundle-path",
                path.join(
                  buildPath,
                  "OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests",
                ),
                ...args,
                "--testing-library",
                "swift-testing",
              ],
              120_000,
              undefined,
              diagnosticEnv,
            );
            console.error(
              `[macos-native] Named exit diagnostic exited ${diagnosticCode}; preserving completion failure`,
            );
          } catch (diagnosticError) {
            console.error(
              "[macos-native] Named exit diagnostic failed; preserving completion failure",
              diagnosticError,
            );
          }
        }
      }
    } finally {
      // A completed failed create may leave a database. Never delete it until every child closed.
      if (canRemove && fs.existsSync(keychain)) {
        const cleanupCode = await run("security", ["delete-keychain", keychain], 30_000);
        if (cleanupCode !== 0) {
          canRemove = false;
          process.exitCode ||= cleanupCode;
          console.error(`[macos-native] security delete-keychain failed (exit ${cleanupCode})`);
        }
      }
    }
  } finally {
    // Retain evidence/resources if process-tree completion could not be established.
    if (canRemove) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`[macos-native] retained resources after incomplete launch/cleanup: ${root}`);
    }
  }
});
