import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "@bb/host-workspace";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EVIDENCE_ENTRIES = 100_000;
const MAX_EVIDENCE_DEPTH = 128;
const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

type EvidenceEntry =
  | { kind: "directory"; mode: number; path: string }
  | {
      kind: "file";
      contentDigest: string;
      mode: number;
      path: string;
      size: number;
    }
  | { kind: "missing"; path: string }
  | { kind: "symlink"; mode: number; path: string; target: string };

interface EvidenceBudget {
  bytes: number;
  entries: number;
}

export interface SessionWorkspaceEvidence {
  diffDigest: string;
  indexDigest: string;
  untrackedManifestDigest: string;
}

function bytewiseCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestEvidence(domain: string, value: string): string {
  return `sha256:${createHash("sha256")
    .update(`bb-session-workspace-evidence-v2\0${domain}\0`)
    .update(value)
    .digest("hex")}`;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function requireBudgetEntry(
  budget: EvidenceBudget,
  relativePath: string,
): void {
  budget.entries += 1;
  if (budget.entries > MAX_EVIDENCE_ENTRIES) {
    throw new Error(
      `Workspace evidence exceeds ${MAX_EVIDENCE_ENTRIES} entries at ${relativePath}`,
    );
  }
}

function sameStat(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertStableStat(args: {
  after: Awaited<ReturnType<typeof fs.lstat>>;
  before: Awaited<ReturnType<typeof fs.lstat>>;
  relativePath: string;
}): void {
  if (!sameStat(args.before, args.after)) {
    throw new Error(
      `Workspace entry changed while evidence was captured: ${args.relativePath}`,
    );
  }
}

async function digestFile(args: {
  absolutePath: string;
  before: Awaited<ReturnType<typeof fs.lstat>>;
  budget: EvidenceBudget;
  relativePath: string;
}): Promise<string> {
  const handle = await fs.open(args.absolutePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStat(args.before, opened)) {
      throw new Error(
        `Workspace file changed before evidence capture: ${args.relativePath}`,
      );
    }
    if (args.budget.bytes + opened.size > MAX_EVIDENCE_BYTES) {
      throw new Error(
        `Workspace evidence exceeds ${MAX_EVIDENCE_BYTES} content bytes at ${args.relativePath}`,
      );
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let capturedBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      capturedBytes += bytesRead;
      if (args.budget.bytes + capturedBytes > MAX_EVIDENCE_BYTES) {
        throw new Error(
          `Workspace evidence exceeds ${MAX_EVIDENCE_BYTES} content bytes at ${args.relativePath}`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (capturedBytes !== opened.size || !sameStat(opened, after)) {
      throw new Error(
        `Workspace file changed during evidence capture: ${args.relativePath}`,
      );
    }
    args.budget.bytes += capturedBytes;
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function inspectEntry(args: {
  absolutePath: string;
  budget: EvidenceBudget;
  depth: number;
  entries: Map<string, EvidenceEntry>;
  relativePath: string;
}): Promise<void> {
  if (args.depth > MAX_EVIDENCE_DEPTH) {
    throw new Error(
      `Workspace evidence exceeds ${MAX_EVIDENCE_DEPTH} directory levels at ${args.relativePath}`,
    );
  }
  const before = await fs.lstat(args.absolutePath);
  requireBudgetEntry(args.budget, args.relativePath);

  if (before.isSymbolicLink()) {
    const target = await fs.readlink(args.absolutePath);
    const after = await fs.lstat(args.absolutePath);
    assertStableStat({ after, before, relativePath: args.relativePath });
    args.entries.set(args.relativePath, {
      kind: "symlink",
      mode: before.mode & 0o7777,
      path: args.relativePath,
      target,
    });
    return;
  }
  if (before.isFile()) {
    const contentDigest = await digestFile({
      absolutePath: args.absolutePath,
      before,
      budget: args.budget,
      relativePath: args.relativePath,
    });
    args.entries.set(args.relativePath, {
      kind: "file",
      contentDigest,
      mode: before.mode & 0o7777,
      path: args.relativePath,
      size: before.size,
    });
    return;
  }
  if (!before.isDirectory()) {
    throw new Error(
      `Workspace evidence cannot represent special file: ${args.relativePath}`,
    );
  }

  args.entries.set(args.relativePath, {
    kind: "directory",
    mode: before.mode & 0o7777,
    path: args.relativePath,
  });
  const names = (await fs.readdir(args.absolutePath)).sort(bytewiseCompare);
  for (const name of names) {
    const relativePath = args.relativePath
      ? `${args.relativePath}/${name}`
      : name;
    await inspectEntry({
      absolutePath: path.join(args.absolutePath, name),
      budget: args.budget,
      depth: args.depth + 1,
      entries: args.entries,
      relativePath,
    });
  }
  const after = await fs.lstat(args.absolutePath);
  assertStableStat({ after, before, relativePath: args.relativePath || "." });
}

function resolveWorkspaceEntry(rootPath: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`Git returned an unsafe workspace path: ${relativePath}`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const relation = path.relative(rootPath, absolutePath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(
      `Git returned a path outside the workspace: ${relativePath}`,
    );
  }
  return absolutePath;
}

async function buildManifest(args: {
  allowMissing: boolean;
  relativePaths: readonly string[] | null;
  rootPath: string;
}): Promise<string> {
  const entries = new Map<string, EvidenceEntry>();
  const budget: EvidenceBudget = { bytes: 0, entries: 0 };
  if (args.relativePaths === null) {
    const names = (await fs.readdir(args.rootPath)).sort(bytewiseCompare);
    for (const name of names) {
      await inspectEntry({
        absolutePath: path.join(args.rootPath, name),
        budget,
        depth: 1,
        entries,
        relativePath: name,
      });
    }
  } else {
    const relativePaths = [...new Set(args.relativePaths)].sort(
      bytewiseCompare,
    );
    for (const relativePath of relativePaths) {
      const absolutePath = resolveWorkspaceEntry(args.rootPath, relativePath);
      try {
        await inspectEntry({
          absolutePath,
          budget,
          depth: 1,
          entries,
          relativePath,
        });
      } catch (error) {
        if (!args.allowMissing || !isMissingPath(error)) throw error;
        requireBudgetEntry(budget, relativePath);
        entries.set(relativePath, { kind: "missing", path: relativePath });
      }
    }
  }
  return [...entries.values()]
    .sort((left, right) => bytewiseCompare(left.path, right.path))
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

function parseGitPathList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

export async function inspectNonGitWorkspaceEvidence(
  rootPath: string,
): Promise<SessionWorkspaceEvidence> {
  const manifest = await buildManifest({
    allowMissing: false,
    relativePaths: null,
    rootPath,
  });
  return {
    diffDigest: digestEvidence("non-git-content", manifest),
    indexDigest: digestEvidence("non-git-index", manifest),
    untrackedManifestDigest: digestEvidence("non-git-manifest", manifest),
  };
}

export async function inspectGitWorkspaceEvidence(
  rootPath: string,
): Promise<SessionWorkspaceEvidence> {
  const [index, modified, untracked] = await Promise.all([
    runGit(["ls-files", "--stage", "-z"], {
      cwd: rootPath,
      maxBufferBytes: MAX_GIT_LIST_BYTES,
    }),
    runGit(["ls-files", "--modified", "--deleted", "-z"], {
      cwd: rootPath,
      maxBufferBytes: MAX_GIT_LIST_BYTES,
    }),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: rootPath,
      maxBufferBytes: MAX_GIT_LIST_BYTES,
    }),
  ]);
  const [modifiedManifest, untrackedManifest] = await Promise.all([
    buildManifest({
      allowMissing: true,
      relativePaths: parseGitPathList(modified.stdout),
      rootPath,
    }),
    buildManifest({
      allowMissing: false,
      relativePaths: parseGitPathList(untracked.stdout),
      rootPath,
    }),
  ]);
  return {
    diffDigest: digestEvidence("git-working-tree", modifiedManifest),
    indexDigest: digestEvidence("git-index", index.stdout),
    untrackedManifestDigest: digestEvidence("git-untracked", untrackedManifest),
  };
}
