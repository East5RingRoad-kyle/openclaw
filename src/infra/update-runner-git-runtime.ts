import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";
import type { CommandRunner } from "./update-runner-types.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeTree,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

async function collectRuntimeDirectories(
  root: string,
  runCommand: CommandRunner,
  timeoutMs: number,
) {
  const result = await runCommand(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      "dist",
      "dist-runtime",
      "node_modules",
      "**/dist",
      "**/dist-runtime",
      "**/node_modules",
      ":(exclude).artifacts/**",
      ":(exclude).worktrees/**",
      ":(exclude).claude/**",
    ],
    { cwd: root, timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error("Cannot enumerate candidate runtime outputs");
  }
  return (
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/u, ""))
      // Git's --directory can collapse an excluded subtree to its ignored parent.
      .filter(
        (entry) =>
          ["dist", "dist-runtime", "node_modules"].includes(path.basename(entry)) &&
          !entry.split("/").some((part) => part.startsWith(".")),
      )
  );
}

/** Size the checkout and the same generated roots that runtime promotion copies. */
export async function measureGitUpdateFiles(params: {
  root: string;
  sourceRoot?: string;
  revision?: string;
  runCommand: CommandRunner;
  timeoutMs: number;
}): Promise<{
  sourceBytes: number;
  runtime: Array<{ relative: string; bytes: number }>;
  incomplete: boolean;
}> {
  let incomplete = false;
  let sourceBytes = 4096;
  const sourceRoot = params.sourceRoot ?? params.root;
  try {
    const source = await params.runCommand(
      ["git", "-C", sourceRoot, "ls-tree", "-r", "-t", "-l", "-z", params.revision ?? "HEAD"],
      {
        cwd: sourceRoot,
        timeoutMs: params.timeoutMs,
        env: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (source.code !== 0) {
      incomplete = true;
    } else {
      for (const entry of source.stdout.split("\0").filter(Boolean)) {
        const header = /^\d+ (blob|tree|commit) [0-9a-f]+ +([0-9]+|-)\t/u.exec(entry);
        if (!header || (header[1] === "blob" && header[2] === "-")) {
          incomplete = true;
          continue;
        }
        sourceBytes += Math.max(
          4096,
          Math.ceil(Number(header[2] === "-" ? 0 : header[2]) / 4096) * 4096,
        );
      }
    }
  } catch {
    incomplete = true;
  }
  const root = await fs.realpath(params.root);
  const directories = await collectRuntimeDirectories(
    root,
    params.runCommand,
    params.timeoutMs,
  ).catch(() => {
    incomplete = true;
    return [];
  });
  const roots = new Set(directories.map((relative) => path.join(root, relative)));
  for (const relative of directories) {
    if (path.basename(relative) !== "node_modules") {
      continue;
    }
    try {
      const modules = path.join(root, relative);
      const contents = await readRuntimeModulesManifest(path.join(modules, ".modules.yaml"));
      const virtualStoreDir = contents?.manifest.virtualStoreDir;
      if (typeof virtualStoreDir === "string") {
        const store = path.resolve(modules, virtualStoreDir);
        const entry = path.join(await fs.realpath(path.dirname(store)), path.basename(store));
        if (entry !== root && isPathInside(root, entry)) {
          roots.add(entry);
        } else {
          incomplete = true;
        }
      }
    } catch {
      incomplete = true;
    }
  }
  async function measure(file: string): Promise<number> {
    try {
      // Promotion preserves links; a link's external payload is not a copied tree.
      const stat = await fs.lstat(file);
      if (!stat.isDirectory()) {
        return Math.max(4096, Math.ceil(stat.size / 4096) * 4096);
      }
      let bytes = 4096;
      for (const entry of await fs.readdir(file)) {
        bytes += await measure(path.join(file, entry));
      }
      return bytes;
    } catch {
      incomplete = true;
      return 0;
    }
  }
  const runtime: Array<{ relative: string; bytes: number }> = [];
  for (const source of roots) {
    if (![...roots].some((other) => other !== source && isPathInside(other, source))) {
      runtime.push({ relative: path.relative(root, source), bytes: await measure(source) });
    }
  }
  return { sourceBytes, runtime, incomplete };
}

/** Stage on the destination filesystem; activation only renames the already validated runtime. */
export async function prepareGitRuntimePromotion(
  root: string,
  candidateRoot: string,
  runCommand: CommandRunner,
  timeoutMs: number,
  cleanupRoot: string,
) {
  const relocation: RuntimeRelocation = {
    sourceRoot: await fs.realpath(candidateRoot),
    destinationRoot: await fs.realpath(root),
    sourceAliases: [candidateRoot],
  };
  const directories = await collectRuntimeDirectories(relocation.sourceRoot, runCommand, timeoutMs);
  const copiedRoots = new Map<string, RuntimeRelocation>();
  for (const relative of directories) {
    const sourceRoot = path.join(relocation.sourceRoot, relative);
    copiedRoots.set(sourceRoot, {
      sourceRoot,
      destinationRoot: path.join(relocation.destinationRoot, relative),
    });
  }
  const stores = new Map<string, RuntimeRelocation>();
  const ownedRoot = await fs.realpath(cleanupRoot);
  for (const relative of directories) {
    if (path.basename(relative) !== "node_modules") {
      continue;
    }
    const modulesDir = path.join(relocation.sourceRoot, relative);
    const contents = await readRuntimeModulesManifest(path.join(modulesDir, ".modules.yaml"));
    const virtualStoreDir = contents?.manifest.virtualStoreDir;
    if (typeof virtualStoreDir !== "string") {
      continue;
    }
    const store = path.resolve(modulesDir, virtualStoreDir);
    // Own the directory entry, not a symlink's external payload. A sibling store
    // can be outside the worktree but still inside its disposable preflight tree.
    const sourceRoot = path.join(await fs.realpath(path.dirname(store)), path.basename(store));
    const owned = isPathInside(ownedRoot, sourceRoot);
    const storeRelocation = {
      sourceRoot,
      destinationRoot: owned
        ? path.resolve(relocation.destinationRoot, path.relative(relocation.sourceRoot, sourceRoot))
        : sourceRoot,
      sourceAliases: [store],
    };
    const destinationEntry = path.join(
      resolvePathViaExistingAncestorSync(path.dirname(storeRelocation.destinationRoot)),
      path.basename(storeRelocation.destinationRoot),
    );
    if (
      isPathInside(sourceRoot, relocation.sourceRoot) ||
      (owned && isPathInside(destinationEntry, relocation.destinationRoot))
    ) {
      throw new Error(
        "Candidate pnpm virtual store overlaps the source or live checkout; use a dedicated store directory before updating.",
      );
    }
    stores.set(sourceRoot, storeRelocation);
    if (owned) {
      copiedRoots.set(sourceRoot, storeRelocation);
    }
  }
  // A store reached through a symlinked parent retains its physical external owner;
  // resolve that specific mapping before the encompassing checkout mapping.
  const relocations = [...stores.values(), relocation];
  const roots = [...copiedRoots.values()].filter(
    (entry) =>
      ![...copiedRoots.keys()].some(
        (other) => other !== entry.sourceRoot && isPathInside(other, entry.sourceRoot),
      ),
  );
  const destinations = roots.map(({ destinationRoot }) =>
    path.join(
      resolvePathViaExistingAncestorSync(path.dirname(destinationRoot)),
      path.basename(destinationRoot),
    ),
  );
  // External payloads may survive a moved symlink, but stores inside renamed
  // directory entries disappear from the candidate's retained dependency links.
  for (const store of stores.keys()) {
    const payload = await fs.realpath(store);
    if (
      (!copiedRoots.has(store) && destinations.some((dest) => isPathInside(dest, store))) ||
      (!roots.some(({ sourceRoot }) => isPathInside(sourceRoot, payload)) &&
        destinations.some((dest) => isPathInside(dest, payload)))
    ) {
      throw new Error("Candidate pnpm virtual store overlaps a runtime directory being replaced.");
    }
  }
  const staged: Array<{ destination: string; temporary: string; previous: boolean }> = [];
  const promoted: typeof staged = [];
  let restoreStarted = false;
  const cleanup = async () => {
    // Failed restoration must retain pending originals; successfully restored
    // entries leave the promoted list before cleanup or another restore attempt.
    await Promise.all(
      staged
        .filter((entry) => !restoreStarted || !promoted.includes(entry))
        .map((entry) => fs.rm(entry.temporary, { recursive: true, force: true })),
    );
  };
  try {
    for (const { sourceRoot, destinationRoot: destination } of roots) {
      // .artifacts may point at another volume. A sibling of each destination
      // guarantees rename-only activation, including nested workspace outputs.
      const temporary = `${destination}.openclaw-update-${randomUUID()}.tmp`;
      const entry = { destination, temporary, previous: false };
      staged.push(entry);
      await fs.mkdir(temporary, { recursive: true });
      const candidate = path.join(temporary, "candidate");
      await fs.cp(sourceRoot, candidate, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await relocateRuntimeTree(candidate, sourceRoot, destination, relocations);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    // Source fences may hide only transaction-owned staging. The same exact
    // paths preserve pending originals while rollback cleans unrelated files.
    sourceTreeStagingPaths: staged.flatMap(({ temporary }) => {
      const relative = path.relative(relocation.destinationRoot, temporary);
      return relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
        ? [relative.split(path.sep).join("/")]
        : [];
    }),
    async activate() {
      for (const entry of staged) {
        try {
          await fs.rename(entry.destination, path.join(entry.temporary, "previous"));
          entry.previous = true;
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
        }
        promoted.push(entry);
        await fs.rename(path.join(entry.temporary, "candidate"), entry.destination);
      }
    },
    async restore() {
      restoreStarted = true;
      for (const entry of promoted.toReversed()) {
        await fs.rm(entry.destination, { recursive: true, force: true });
        if (entry.previous) {
          await fs.rename(path.join(entry.temporary, "previous"), entry.destination);
        }
        promoted.pop();
      }
    },
    cleanup,
  };
}
