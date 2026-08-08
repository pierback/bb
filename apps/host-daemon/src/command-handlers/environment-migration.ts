import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DiscoveredWorkspaceProperties } from "@bb/domain";
import {
  environmentMigrationManifestSchema,
  type EnvironmentMigrationArtifact,
  type EnvironmentMigrationManifest,
  type HostDaemonOnlineRpcResult,
} from "@bb/host-daemon-contract";
import { runGit } from "@bb/host-workspace";
import {
  ExpectedCommandDispatchError,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import { z } from "zod";

const MIGRATION_DIRECTORY = "environment-migrations";
const MANIFEST_FILE = "manifest.json";
const RECEIPT_FILE = "receipt.json";
const ARTIFACT_DIRECTORY = "artifacts";
const GIT_BUNDLE_RELATIVE_PATH = "workspace.bundle";
const ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH =
  ".bb/environment-transfer.json";
const MAX_ENVIRONMENT_TRANSFER_MANIFEST_BYTES = 64 * 1_024;
const TRANSFER_TIMEOUT_MS = 20 * 60 * 1_000;

const environmentTransferRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Transfer paths must be safe POSIX-relative paths",
  );
const environmentTransferConfigSchema = z
  .object({
    version: z.literal(1),
    includeIgnoredFiles: z
      .array(environmentTransferRelativePathSchema)
      .max(10_000)
      .refine(
        (entries) => new Set(entries).size === entries.length,
        "Ignored file allowlist entries must be unique",
      ),
  })
  .strict();
type EnvironmentTransferConfig = z.infer<
  typeof environmentTransferConfigSchema
>;

const targetReceiptSchema = z
  .object({
    completed: z.boolean(),
    finalWorkspacePath: z.string().min(1),
    installedProviderSessionPaths: z.array(z.string().min(1)),
  })
  .strict();
type TargetReceipt = z.infer<typeof targetReceiptSchema>;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrationKey(environmentId: string, migrationId: string): string {
  return digest(`${environmentId}\0${migrationId}`);
}

function migrationStagePath(args: {
  dataDir: string;
  environmentId: string;
  migrationId: string;
  side: "source" | "target";
}): string {
  return path.join(
    args.dataDir,
    MIGRATION_DIRECTORY,
    args.side,
    migrationKey(args.environmentId, args.migrationId),
  );
}

function artifactStagePath(stagePath: string, artifactId: string): string {
  return path.join(stagePath, ARTIFACT_DIRECTORY, artifactId);
}

function isPathWithinOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(candidatePath),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function codexHome(options: CommandDispatchOptions): string {
  const configured = options.runtimeManager.getShellEnv().CODEX_HOME;
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), ".codex");
}

function toPosixRelativePath(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes migration root: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

function resolveRelativePath(rootPath: string, relativePath: string): string {
  const resolved = path.resolve(rootPath, ...relativePath.split("/"));
  const root = path.resolve(rootPath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe migration path: ${relativePath}`);
  }
  return resolved;
}

async function fileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return digest(content);
}

async function readEnvironmentTransferConfig(
  workspacePath: string,
): Promise<EnvironmentTransferConfig> {
  const manifestPath = resolveRelativePath(
    workspacePath,
    ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH,
  );
  let stat: Stats;
  try {
    stat = await fs.lstat(manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, includeIgnoredFiles: [] };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExpectedCommandDispatchError(
      "invalid_environment_transfer_manifest",
      `${ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH} must be a regular file`,
    );
  }
  if (stat.size > MAX_ENVIRONMENT_TRANSFER_MANIFEST_BYTES) {
    throw new ExpectedCommandDispatchError(
      "invalid_environment_transfer_manifest",
      `${ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH} exceeds ${MAX_ENVIRONMENT_TRANSFER_MANIFEST_BYTES} bytes`,
    );
  }
  try {
    return environmentTransferConfigSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, "utf8")),
    );
  } catch (error) {
    throw new ExpectedCommandDispatchError(
      "invalid_environment_transfer_manifest",
      `${ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function stageFile(args: {
  artifactsPath: string;
  kind: EnvironmentMigrationArtifact["kind"];
  relativePath: string;
  sourcePath: string;
}): Promise<EnvironmentMigrationArtifact> {
  const stat = await fs.lstat(args.sourcePath);
  if (!stat.isFile()) {
    throw new ExpectedCommandDispatchError(
      "unsupported_migration_entry",
      `Migration only supports regular files: ${args.relativePath}`,
    );
  }
  const id = digest(`${args.kind}\0${args.relativePath}`);
  const targetPath = path.join(args.artifactsPath, id);
  await fs.copyFile(args.sourcePath, targetPath);
  return {
    id,
    kind: args.kind,
    relativePath: args.relativePath,
    sizeBytes: stat.size,
    sha256: await fileSha256(targetPath),
    mode: stat.mode & 0o777,
  };
}

async function requireWorkspaceEntryRealPath(args: {
  relativePath: string;
  sourcePath: string;
  workspaceRealPath: string;
}): Promise<string> {
  let realPath: string;
  try {
    realPath = await fs.realpath(args.sourcePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ExpectedCommandDispatchError(
        "unsafe_migration_symlink",
        `Workspace entry must resolve to an existing in-workspace target: ${args.relativePath}`,
      );
    }
    throw error;
  }
  if (!isPathWithinOrEqual(args.workspaceRealPath, realPath)) {
    throw new ExpectedCommandDispatchError(
      "unsafe_migration_symlink",
      `Workspace entry resolves outside the workspace: ${args.relativePath}`,
    );
  }
  return realPath;
}

function isPortableRelativeSymlinkTarget(target: string): boolean {
  return (
    target.length > 0 &&
    !target.includes("\0") &&
    !target.includes("\\") &&
    !path.posix.isAbsolute(target) &&
    !path.win32.isAbsolute(target)
  );
}

async function rejectSymlinkAncestors(args: {
  relativePath: string;
  workspacePath: string;
}): Promise<void> {
  const segments = args.relativePath.split("/");
  let candidatePath = args.workspacePath;
  for (const segment of segments.slice(0, -1)) {
    candidatePath = path.join(candidatePath, segment);
    if ((await fs.lstat(candidatePath)).isSymbolicLink()) {
      throw new ExpectedCommandDispatchError(
        "unsafe_migration_symlink",
        `Workspace entry traverses a symlink ancestor: ${args.relativePath}`,
      );
    }
  }
}

async function stageWorkspaceEntry(args: {
  artifactsPath: string;
  relativePath: string;
  sourcePath: string;
  workspacePath: string;
  workspaceRealPath: string;
}): Promise<EnvironmentMigrationArtifact> {
  await rejectSymlinkAncestors({
    relativePath: args.relativePath,
    workspacePath: args.workspacePath,
  });
  const stat = await fs.lstat(args.sourcePath);
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(args.sourcePath);
    const resolvedTarget = path.resolve(
      path.dirname(args.sourcePath),
      linkTarget,
    );
    if (
      !isPortableRelativeSymlinkTarget(linkTarget) ||
      !isPathWithinOrEqual(args.workspacePath, resolvedTarget)
    ) {
      throw new ExpectedCommandDispatchError(
        "unsafe_migration_symlink",
        `Workspace symlink must use a relative in-workspace target: ${args.relativePath}`,
      );
    }
    await requireWorkspaceEntryRealPath({
      relativePath: args.relativePath,
      sourcePath: args.sourcePath,
      workspaceRealPath: args.workspaceRealPath,
    });
    const kind = "workspace-symlink" as const;
    const id = digest(`${kind}\0${args.relativePath}`);
    const content = Buffer.from(linkTarget, "utf8");
    const targetPath = path.join(args.artifactsPath, id);
    await fs.writeFile(targetPath, content, { flag: "wx" });
    return {
      id,
      kind,
      relativePath: args.relativePath,
      sizeBytes: content.byteLength,
      sha256: digest(content),
      mode: stat.mode & 0o777,
    };
  }
  if (!stat.isFile()) {
    throw new ExpectedCommandDispatchError(
      "unsupported_migration_entry",
      `Migration only supports regular files and symlinks: ${args.relativePath}`,
    );
  }
  await requireWorkspaceEntryRealPath({
    relativePath: args.relativePath,
    sourcePath: args.sourcePath,
    workspaceRealPath: args.workspaceRealPath,
  });
  return await stageFile({
    artifactsPath: args.artifactsPath,
    kind: "workspace-file",
    relativePath: args.relativePath,
    sourcePath: args.sourcePath,
  });
}

async function stageGitWorkspaceEntry(args: {
  artifactsPath: string;
  relativePath: string;
  workspacePath: string;
  workspaceRealPath: string;
}): Promise<EnvironmentMigrationArtifact | null> {
  const sourcePath = resolveRelativePath(args.workspacePath, args.relativePath);
  try {
    return await stageWorkspaceEntry({
      artifactsPath: args.artifactsPath,
      relativePath: args.relativePath,
      sourcePath,
      workspacePath: args.workspacePath,
      workspaceRealPath: args.workspaceRealPath,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // `git ls-files --cached` includes tracked paths deleted in the working
      // tree. Their absence is preserved because target restore starts from an
      // empty checkout and overlays only files that still exist.
      return null;
    }
    throw error;
  }
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const result = await runGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: workspacePath, timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  return result.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();
}

async function listExplicitIgnoredWorkspaceEntries(args: {
  config: EnvironmentTransferConfig;
  workspacePath: string;
}): Promise<string[]> {
  const entries = [...args.config.includeIgnoredFiles].sort();
  for (const relativePath of entries) {
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      throw new ExpectedCommandDispatchError(
        "unsafe_environment_transfer_entry",
        `Git internals cannot be transferred: ${relativePath}`,
      );
    }
    const ignored = await runGit(
      ["check-ignore", "--quiet", "--", relativePath],
      {
        cwd: args.workspacePath,
        allowFailure: true,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      },
    );
    if (ignored.exitCode !== 0) {
      throw new ExpectedCommandDispatchError(
        "invalid_environment_transfer_entry",
        `${relativePath} is not an ignored file; only ignored files belong in ${ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH}`,
      );
    }
    let stat: Stats;
    try {
      stat = await fs.lstat(
        resolveRelativePath(args.workspacePath, relativePath),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new ExpectedCommandDispatchError(
          "missing_environment_transfer_entry",
          `Allowlisted ignored file does not exist: ${relativePath}`,
        );
      }
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new ExpectedCommandDispatchError(
        "unsupported_migration_entry",
        `Allowlisted entries must name exact files or symlinks, not directories: ${relativePath}`,
      );
    }
  }
  return entries;
}

async function listWorkspaceEntriesRecursively(
  rootPath: string,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWorkspaceEntriesRecursively(entryPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    } else {
      throw new ExpectedCommandDispatchError(
        "unsupported_migration_entry",
        `Unsupported workspace entry: ${entryPath}`,
      );
    }
  }
  return files;
}

async function findCodexSessionFiles(
  homePath: string,
  providerThreadIds: readonly string[],
): Promise<string[]> {
  const candidates = (
    await Promise.all(
      ["sessions", "archived_sessions"].map((directory) =>
        listWorkspaceEntriesRecursively(path.join(homePath, directory)),
      ),
    )
  ).flat();
  const requested = new Set(providerThreadIds);
  return candidates
    .filter(
      (filePath) =>
        filePath.endsWith(".jsonl") &&
        [...requested].some((providerThreadId) =>
          path.basename(filePath).includes(providerThreadId),
        ),
    )
    .sort();
}

function validateArtifactTopology(
  artifacts: readonly EnvironmentMigrationArtifact[],
): void {
  const artifactIds = new Set<string>();
  const destinationKeys = new Set<string>();
  const workspaceArtifacts = artifacts.filter(
    (artifact) =>
      artifact.kind === "workspace-file" ||
      artifact.kind === "workspace-symlink",
  );
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)) {
      throw new ExpectedCommandDispatchError(
        "migration_artifact_conflict",
        `Duplicate migration artifact id: ${artifact.id}`,
      );
    }
    artifactIds.add(artifact.id);
    const destinationNamespace =
      artifact.kind === "workspace-file" ||
      artifact.kind === "workspace-symlink"
        ? "workspace"
        : artifact.kind;
    const destinationKey = `${destinationNamespace}\0${artifact.relativePath}`;
    if (destinationKeys.has(destinationKey)) {
      throw new ExpectedCommandDispatchError(
        "migration_artifact_conflict",
        `Duplicate migration artifact destination: ${artifact.relativePath}`,
      );
    }
    destinationKeys.add(destinationKey);
  }
  const workspaceArtifactByPath = new Map(
    workspaceArtifacts.map((artifact) => [artifact.relativePath, artifact]),
  );
  for (const artifact of workspaceArtifacts) {
    const segments = artifact.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestorPath = segments.slice(0, index).join("/");
      const ancestor = workspaceArtifactByPath.get(ancestorPath);
      if (ancestor) {
        throw new ExpectedCommandDispatchError(
          ancestor.kind === "workspace-symlink"
            ? "unsafe_migration_symlink"
            : "migration_artifact_conflict",
          `Workspace entry ${artifact.relativePath} traverses artifact ${ancestorPath}`,
        );
      }
    }
  }
}

function validateMigrationManifest(
  manifest: EnvironmentMigrationManifest,
): void {
  validateArtifactTopology(manifest.artifacts);
  const computedTotalBytes = manifest.artifacts.reduce(
    (total, artifact) => total + artifact.sizeBytes,
    0,
  );
  if (computedTotalBytes !== manifest.totalBytes) {
    throw new ExpectedCommandDispatchError(
      "migration_manifest_conflict",
      `Migration manifest total ${manifest.totalBytes} does not match artifact total ${computedTotalBytes}`,
    );
  }
  if (
    manifest.isGitRepo &&
    manifest.artifacts.some(
      (artifact) =>
        (artifact.kind === "workspace-file" ||
          artifact.kind === "workspace-symlink") &&
        (artifact.relativePath === ".git" ||
          artifact.relativePath.startsWith(".git/")),
    )
  ) {
    throw new ExpectedCommandDispatchError(
      "unsafe_environment_transfer_entry",
      "Git metadata cannot be overlaid by workspace artifacts",
    );
  }
}

async function readManifest(
  stagePath: string,
): Promise<EnvironmentMigrationManifest> {
  const raw = await fs.readFile(path.join(stagePath, MANIFEST_FILE), "utf8");
  const manifest = environmentMigrationManifestSchema.parse(JSON.parse(raw));
  validateMigrationManifest(manifest);
  return manifest;
}

async function writeManifest(
  stagePath: string,
  manifest: EnvironmentMigrationManifest,
): Promise<void> {
  validateMigrationManifest(manifest);
  await fs.writeFile(
    path.join(stagePath, MANIFEST_FILE),
    JSON.stringify(manifest),
    "utf8",
  );
}

async function readTargetReceipt(
  stagePath: string,
): Promise<TargetReceipt | null> {
  try {
    return targetReceiptSchema.parse(
      JSON.parse(await fs.readFile(path.join(stagePath, RECEIPT_FILE), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTargetReceipt(
  stagePath: string,
  receipt: TargetReceipt,
): Promise<void> {
  await fs.writeFile(
    path.join(stagePath, RECEIPT_FILE),
    JSON.stringify(receipt),
    "utf8",
  );
}

async function sourceManifest(
  command: CommandOf<"environment.migration.source_prepare">,
  options: CommandDispatchOptions,
  stagePath: string,
): Promise<EnvironmentMigrationManifest> {
  const workspacePath = path.resolve(command.workspaceContext.workspacePath);
  const workspaceStat = await fs.stat(workspacePath);
  if (!workspaceStat.isDirectory()) {
    throw new ExpectedCommandDispatchError(
      "workspace_not_directory",
      `Workspace is not a directory: ${workspacePath}`,
    );
  }
  const workspaceRealPath = await fs.realpath(workspacePath);
  const transferConfig = await readEnvironmentTransferConfig(workspacePath);

  const artifactsPath = path.join(stagePath, ARTIFACT_DIRECTORY);
  await fs.mkdir(artifactsPath, { recursive: true });
  const gitProbe = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: workspacePath,
    allowFailure: true,
  });
  const isGitRepo =
    gitProbe.exitCode === 0 && gitProbe.stdout.trim() === "true";
  const artifacts: EnvironmentMigrationArtifact[] = [];

  if (isGitRepo) {
    const bundleSourcePath = path.join(stagePath, GIT_BUNDLE_RELATIVE_PATH);
    const head = await runGit(["rev-parse", "--verify", "HEAD"], {
      cwd: workspacePath,
      allowFailure: true,
    });
    if (head.exitCode === 0) {
      await runGit(["bundle", "create", bundleSourcePath, "--all"], {
        cwd: workspacePath,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      artifacts.push(
        await stageFile({
          artifactsPath,
          kind: "git-bundle",
          relativePath: GIT_BUNDLE_RELATIVE_PATH,
          sourcePath: bundleSourcePath,
        }),
      );
      await fs.rm(bundleSourcePath, { force: true });
    }

    for (const relativePath of await listWorkspaceFiles(workspacePath)) {
      const artifact = await stageGitWorkspaceEntry({
        artifactsPath,
        relativePath,
        workspacePath,
        workspaceRealPath,
      });
      if (artifact) {
        artifacts.push(artifact);
      }
    }
    for (const relativePath of await listExplicitIgnoredWorkspaceEntries({
      config: transferConfig,
      workspacePath,
    })) {
      artifacts.push(
        await stageWorkspaceEntry({
          artifactsPath,
          relativePath,
          sourcePath: resolveRelativePath(workspacePath, relativePath),
          workspacePath,
          workspaceRealPath,
        }),
      );
    }
  } else {
    if (transferConfig.includeIgnoredFiles.length > 0) {
      throw new ExpectedCommandDispatchError(
        "invalid_environment_transfer_manifest",
        `${ENVIRONMENT_TRANSFER_MANIFEST_RELATIVE_PATH} cannot allowlist ignored files outside a Git workspace`,
      );
    }
    for (const filePath of (
      await listWorkspaceEntriesRecursively(workspacePath)
    ).sort()) {
      const relativePath = toPosixRelativePath(workspacePath, filePath);
      artifacts.push(
        await stageWorkspaceEntry({
          artifactsPath,
          relativePath,
          sourcePath: filePath,
          workspacePath,
          workspaceRealPath,
        }),
      );
    }
  }

  const unsupportedProvider = command.providerSessions.find(
    (session) => session.providerId !== "codex",
  );
  if (unsupportedProvider) {
    throw new ExpectedCommandDispatchError(
      "unsupported_provider_migration",
      `Provider ${unsupportedProvider.providerId} does not support portable sessions`,
    );
  }
  const providerThreadIds = command.providerSessions.map(
    (session) => session.providerThreadId,
  );
  const providerHomePath = codexHome(options);
  const sessionFiles = await findCodexSessionFiles(
    providerHomePath,
    providerThreadIds,
  );
  for (const filePath of sessionFiles) {
    artifacts.push(
      await stageFile({
        artifactsPath,
        kind: "provider-session",
        relativePath: toPosixRelativePath(providerHomePath, filePath),
        sourcePath: filePath,
      }),
    );
  }
  for (const providerThreadId of providerThreadIds) {
    if (
      !sessionFiles.some((filePath) =>
        path.basename(filePath).includes(providerThreadId),
      )
    ) {
      throw new ExpectedCommandDispatchError(
        "provider_session_not_found",
        `Could not locate portable Codex session ${providerThreadId}`,
      );
    }
  }

  const manifest = {
    artifacts,
    totalBytes: artifacts.reduce(
      (total, artifact) => total + artifact.sizeBytes,
      0,
    ),
    workspaceName: path.basename(workspacePath),
    workspaceProvisionType: command.workspaceContext.workspaceProvisionType,
    isGitRepo,
  };
  validateMigrationManifest(manifest);
  return manifest;
}

export async function prepareEnvironmentMigrationSource(
  command: CommandOf<"environment.migration.source_prepare">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"environment.migration.source_prepare">> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "source",
  });
  try {
    return await readManifest(stagePath);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  if (!options.runtimeManager.isEnvironmentQuiescent(command.environmentId)) {
    throw new ExpectedCommandDispatchError(
      "environment_busy",
      `Environment ${command.environmentId} still has active work`,
    );
  }
  await options.runtimeManager.forgetEnvironment(command.environmentId);
  await fs.rm(stagePath, { recursive: true, force: true });
  await fs.mkdir(stagePath, { recursive: true });
  try {
    const manifest = await sourceManifest(command, options, stagePath);
    await writeManifest(stagePath, manifest);
    return manifest;
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    throw error;
  }
}

export async function readEnvironmentMigrationSource(
  command: CommandOf<"environment.migration.source_read">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"environment.migration.source_read">> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "source",
  });
  const manifest = await readManifest(stagePath);
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === command.artifactId,
  );
  if (!artifact) {
    throw new ExpectedCommandDispatchError(
      "unknown_migration_artifact",
      `Unknown migration artifact ${command.artifactId}`,
    );
  }
  if (command.offset > artifact.sizeBytes) {
    throw new ExpectedCommandDispatchError(
      "invalid_migration_offset",
      `Offset ${command.offset} exceeds artifact size ${artifact.sizeBytes}`,
    );
  }
  const length = Math.min(
    command.maxBytes,
    artifact.sizeBytes - command.offset,
  );
  const content = Buffer.alloc(length);
  if (length > 0) {
    const handle = await fs.open(
      artifactStagePath(stagePath, artifact.id),
      "r",
    );
    try {
      await handle.read(content, 0, length, command.offset);
    } finally {
      await handle.close();
    }
  }
  const nextOffset = command.offset + length;
  return {
    contentBase64: content.toString("base64"),
    nextOffset,
    eof: nextOffset === artifact.sizeBytes,
  };
}

export async function completeEnvironmentMigrationSource(
  command: CommandOf<"environment.migration.source_complete">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "source",
  });
  await options.runtimeManager.forgetEnvironment(command.environmentId);
  await fs.rm(stagePath, { recursive: true, force: true });
  return {};
}

export async function abortEnvironmentMigrationSource(
  command: CommandOf<"environment.migration.source_abort">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  await fs.rm(
    migrationStagePath({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      migrationId: command.migrationId,
      side: "source",
    }),
    { recursive: true, force: true },
  );
  return {};
}

export async function beginEnvironmentMigrationTarget(
  command: CommandOf<"environment.migration.target_begin">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "target",
  });
  try {
    const existing = await readManifest(stagePath);
    if (!isDeepStrictEqual(existing, command.manifest)) {
      throw new ExpectedCommandDispatchError(
        "migration_manifest_conflict",
        `Migration ${command.migrationId} was already started with a different manifest`,
      );
    }
    return {};
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  await fs.rm(stagePath, { recursive: true, force: true });
  await fs.mkdir(path.join(stagePath, ARTIFACT_DIRECTORY), { recursive: true });
  await writeManifest(stagePath, command.manifest);
  await Promise.all(
    command.manifest.artifacts.map((artifact) =>
      fs.writeFile(artifactStagePath(stagePath, artifact.id), Buffer.alloc(0), {
        flag: "wx",
      }),
    ),
  );
  return {};
}

export async function writeEnvironmentMigrationTarget(
  command: CommandOf<"environment.migration.target_write">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"environment.migration.target_write">> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "target",
  });
  const manifest = await readManifest(stagePath);
  const artifact = manifest.artifacts.find(
    (entry) => entry.id === command.artifactId,
  );
  if (!artifact) {
    throw new ExpectedCommandDispatchError(
      "unknown_migration_artifact",
      `Unknown migration artifact ${command.artifactId}`,
    );
  }
  const content = Buffer.from(command.contentBase64, "base64");
  if (command.offset + content.byteLength > artifact.sizeBytes) {
    throw new ExpectedCommandDispatchError(
      "invalid_migration_offset",
      `Write exceeds artifact ${artifact.id}`,
    );
  }
  const filePath = artifactStagePath(stagePath, artifact.id);
  const stat = await fs.stat(filePath);
  if (stat.size < command.offset) {
    throw new ExpectedCommandDispatchError(
      "invalid_migration_offset",
      `Expected artifact offset ${stat.size}, received ${command.offset}`,
    );
  }
  const alreadyWrittenBytes = Math.min(
    content.byteLength,
    stat.size - command.offset,
  );
  if (alreadyWrittenBytes > 0) {
    const existing = Buffer.alloc(alreadyWrittenBytes);
    const handle = await fs.open(filePath, "r");
    try {
      await handle.read(existing, 0, alreadyWrittenBytes, command.offset);
    } finally {
      await handle.close();
    }
    if (!existing.equals(content.subarray(0, alreadyWrittenBytes))) {
      throw new ExpectedCommandDispatchError(
        "migration_chunk_conflict",
        `Previously written bytes differ for artifact ${artifact.id}`,
      );
    }
  }
  if (alreadyWrittenBytes < content.byteLength) {
    await fs.appendFile(filePath, content.subarray(alreadyWrittenBytes));
  }
  return { nextOffset: command.offset + content.byteLength };
}

function targetWorkspacePath(
  options: CommandDispatchOptions,
  command: { environmentId: string; migrationId: string },
  manifest: EnvironmentMigrationManifest,
): string {
  const workspaceSlug =
    manifest.workspaceName
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "workspace";
  return path.join(
    options.dataDir,
    "migrated-workspaces",
    `${workspaceSlug}-${migrationKey(command.environmentId, command.migrationId).slice(0, 12)}`,
  );
}

async function clearCheckout(finalWorkspacePath: string): Promise<void> {
  const entries = await fs.readdir(finalWorkspacePath);
  await Promise.all(
    entries
      .filter((entry) => entry !== ".git")
      .map((entry) =>
        fs.rm(path.join(finalWorkspacePath, entry), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

async function readSafeSymlinkTarget(args: {
  artifact: EnvironmentMigrationArtifact;
  stagePath: string;
  targetPath: string;
  workspacePath: string;
}): Promise<string> {
  const content = await fs.readFile(
    artifactStagePath(args.stagePath, args.artifact.id),
  );
  const linkTarget = content.toString("utf8");
  const resolvedTarget = path.resolve(
    path.dirname(args.targetPath),
    linkTarget,
  );
  if (
    content.byteLength > 4_096 ||
    !Buffer.from(linkTarget, "utf8").equals(content) ||
    !isPortableRelativeSymlinkTarget(linkTarget) ||
    !isPathWithinOrEqual(args.workspacePath, resolvedTarget)
  ) {
    throw new ExpectedCommandDispatchError(
      "unsafe_migration_symlink",
      `Unsafe workspace symlink target for ${args.artifact.relativePath}`,
    );
  }
  return linkTarget;
}

async function verifyTargetArtifacts(
  stagePath: string,
  manifest: EnvironmentMigrationManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const filePath = artifactStagePath(stagePath, artifact.id);
    const stat = await fs.stat(filePath);
    if (
      stat.size !== artifact.sizeBytes ||
      (await fileSha256(filePath)) !== artifact.sha256
    ) {
      throw new ExpectedCommandDispatchError(
        "migration_checksum_mismatch",
        `Artifact verification failed for ${artifact.relativePath}`,
      );
    }
  }
}

async function installProviderSessions(args: {
  manifest: EnvironmentMigrationManifest;
  options: CommandDispatchOptions;
  receipt: TargetReceipt;
  stagePath: string;
}): Promise<string[]> {
  const installed: string[] = [];
  const homePath = codexHome(args.options);
  try {
    for (const artifact of args.manifest.artifacts.filter(
      (entry) => entry.kind === "provider-session",
    )) {
      const targetPath = resolveRelativePath(homePath, artifact.relativePath);
      try {
        const existingHash = await fileSha256(targetPath);
        if (existingHash !== artifact.sha256) {
          throw new ExpectedCommandDispatchError(
            "provider_session_conflict",
            `Target already has a different provider session at ${artifact.relativePath}`,
          );
        }
        continue;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      args.receipt.installedProviderSessionPaths.push(targetPath);
      await writeTargetReceipt(args.stagePath, args.receipt);
      await fs.copyFile(
        artifactStagePath(args.stagePath, artifact.id),
        targetPath,
      );
      await fs.chmod(targetPath, artifact.mode);
      installed.push(targetPath);
    }
    return installed;
  } catch (error) {
    await Promise.all(
      installed.map((filePath) => fs.rm(filePath, { force: true })),
    );
    throw error;
  }
}

async function inspectMigratedWorkspace(
  workspacePath: string,
  options: CommandDispatchOptions,
): Promise<DiscoveredWorkspaceProperties> {
  const workspace = await options.runtimeManager.openWorkspace(workspacePath);
  const [branchName, discoveredDefaultBranch] = await Promise.all([
    workspace.getCurrentBranch(),
    workspace.isGitRepo ? workspace.getDefaultBranch() : Promise.resolve(null),
  ]);
  return {
    path: workspace.path,
    isGitRepo: workspace.isGitRepo,
    isWorktree: workspace.isWorktree,
    branchName,
    defaultBranch: workspace.isGitRepo
      ? (discoveredDefaultBranch ?? branchName)
      : null,
  };
}

export async function commitEnvironmentMigrationTarget(
  command: CommandOf<"environment.migration.target_commit">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"environment.migration.target_commit">> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "target",
  });
  const manifest = await readManifest(stagePath);
  await verifyTargetArtifacts(stagePath, manifest);
  const finalWorkspacePath = targetWorkspacePath(options, command, manifest);
  const workingWorkspacePath = path.join(stagePath, "restored-workspace");
  const existingReceipt = await readTargetReceipt(stagePath);
  if (existingReceipt?.completed) {
    return await inspectMigratedWorkspace(
      existingReceipt.finalWorkspacePath,
      options,
    );
  }
  if (existingReceipt) {
    try {
      await fs.access(existingReceipt.finalWorkspacePath);
      existingReceipt.completed = true;
      await writeTargetReceipt(stagePath, existingReceipt);
      return await inspectMigratedWorkspace(
        existingReceipt.finalWorkspacePath,
        options,
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    await Promise.all(
      existingReceipt.installedProviderSessionPaths.map((filePath) =>
        fs.rm(filePath, { force: true }),
      ),
    );
    try {
      await fs.rename(
        workingWorkspacePath,
        path.join(stagePath, `abandoned-restored-workspace-${Date.now()}`),
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  try {
    await fs.access(finalWorkspacePath);
    throw new ExpectedCommandDispatchError(
      "migration_target_exists",
      `Migration target already exists: ${finalWorkspacePath}`,
    );
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(finalWorkspacePath), { recursive: true });
  const receipt: TargetReceipt = {
    completed: false,
    finalWorkspacePath,
    installedProviderSessionPaths: [],
  };
  await writeTargetReceipt(stagePath, receipt);
  const gitBundle = manifest.artifacts.find(
    (entry) => entry.kind === "git-bundle",
  );
  if (manifest.isGitRepo && gitBundle) {
    await runGit(
      [
        "clone",
        artifactStagePath(stagePath, gitBundle.id),
        workingWorkspacePath,
      ],
      { cwd: stagePath, timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    await clearCheckout(workingWorkspacePath);
  } else {
    await fs.mkdir(workingWorkspacePath, { recursive: false });
    if (manifest.isGitRepo) {
      await runGit(["init"], { cwd: workingWorkspacePath });
    }
  }

  try {
    for (const artifact of manifest.artifacts.filter(
      (entry) => entry.kind === "workspace-file",
    )) {
      const targetPath = resolveRelativePath(
        workingWorkspacePath,
        artifact.relativePath,
      );
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await rejectSymlinkAncestors({
        relativePath: artifact.relativePath,
        workspacePath: workingWorkspacePath,
      });
      await fs.copyFile(artifactStagePath(stagePath, artifact.id), targetPath);
      await fs.chmod(targetPath, artifact.mode);
    }
    for (const artifact of manifest.artifacts.filter(
      (entry) => entry.kind === "workspace-symlink",
    )) {
      const targetPath = resolveRelativePath(
        workingWorkspacePath,
        artifact.relativePath,
      );
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await rejectSymlinkAncestors({
        relativePath: artifact.relativePath,
        workspacePath: workingWorkspacePath,
      });
      await fs.symlink(
        await readSafeSymlinkTarget({
          artifact,
          stagePath,
          targetPath,
          workspacePath: workingWorkspacePath,
        }),
        targetPath,
      );
    }
    await installProviderSessions({
      manifest,
      options,
      receipt,
      stagePath,
    });
    await fs.rename(workingWorkspacePath, finalWorkspacePath);
    receipt.completed = true;
    await writeTargetReceipt(stagePath, receipt);
    return await inspectMigratedWorkspace(finalWorkspacePath, options);
  } catch (error) {
    await Promise.all(
      receipt.installedProviderSessionPaths.map((filePath) =>
        fs.rm(filePath, { force: true }),
      ),
    );
    receipt.installedProviderSessionPaths = [];
    await writeTargetReceipt(stagePath, receipt);
    throw error;
  }
}

export async function abortEnvironmentMigrationTarget(
  command: CommandOf<"environment.migration.target_abort">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  const stagePath = migrationStagePath({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    migrationId: command.migrationId,
    side: "target",
  });
  try {
    const receipt = targetReceiptSchema.parse(
      JSON.parse(await fs.readFile(path.join(stagePath, RECEIPT_FILE), "utf8")),
    );
    await Promise.all(
      receipt.installedProviderSessionPaths.map((filePath) =>
        fs.rm(filePath, { force: true }),
      ),
    );
    await fs.rm(receipt.finalWorkspacePath, { recursive: true, force: true });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  await fs.rm(stagePath, { recursive: true, force: true });
  return {};
}

export async function completeEnvironmentMigrationTarget(
  command: CommandOf<"environment.migration.target_complete">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  await fs.rm(
    migrationStagePath({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      migrationId: command.migrationId,
      side: "target",
    }),
    { recursive: true, force: true },
  );
  return {};
}
