import type {
  EnvironmentSourceFreshness,
  EnvironmentSourceUpdateResult,
  ProvisioningTranscriptEntry,
  WorkspaceStatus,
} from "@bb/domain";
import { pathExists } from "@bb/process-utils";
import path from "node:path";
import type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  DiffFilesArgs,
  DiffFilesResult,
  DiffPatchArgs,
  DiffPatchEntry,
  PullRequestActionOptions,
  SourceUpdateOptions,
  StatusOptions,
} from "./workspace.js";
import { Workspace } from "./workspace.js";
import type {
  GitHostCliOptions,
  GitHostPullRequestLookup,
} from "./git-host.js";
import {
  detectGitRepo,
  detectLinkedWorktree,
  readDefaultBranch,
  WorkspaceError,
  type GitProcessOptions,
} from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

interface ProvisionBase {
  onProgress?: ProvisionProgressCallback;
  shellPath?: string;
  signal?: AbortSignal;
}

interface UnmanagedWorkspaceOpts extends ProvisionBase {
  path: string;
}

export type ProvisionWorkspaceArgs = UnmanagedWorkspaceOpts;

interface ValidatePersonalWorkspaceTargetPathArgs {
  environmentId: string;
  personalWorkspaceRoot: string;
  targetPath: string;
}

const WORKSPACE_BRANCH_GIT_TIMEOUT_MS = 15_000;

function isRelativeChildPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

export function getPersonalWorkspaceRoot(dataDir: string): string {
  return path.resolve(dataDir, "personal-workspaces");
}

export function validatePersonalWorkspaceTargetPath(
  args: ValidatePersonalWorkspaceTargetPathArgs,
): string {
  if (
    path.basename(args.environmentId) !== args.environmentId ||
    args.environmentId === "." ||
    args.environmentId === ".."
  ) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace environmentId must be a single path segment",
    );
  }

  const root = path.resolve(args.personalWorkspaceRoot);
  const expectedTargetPath = path.resolve(root, args.environmentId);
  if (!isRelativeChildPath(path.relative(root, expectedTargetPath))) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace target path must be under the personal workspace root",
    );
  }

  const targetPath = path.resolve(args.targetPath);
  if (targetPath !== expectedTargetPath) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace target path must match the environment id",
    );
  }

  return targetPath;
}

export interface HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  getDefaultBranch(): Promise<string | null>;
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getSourceFreshness(sourceBranch: string): Promise<EnvironmentSourceFreshness>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult>;
  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]>;
  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup>;
  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void>;

  commit(options: CommitOptions): Promise<CommitResult>;
  updateFromSource(
    options: SourceUpdateOptions,
  ): Promise<EnvironmentSourceUpdateResult>;
}

class ProvisionedHostWorkspace implements HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  private readonly ws: Workspace;
  private readonly gitProcessOptions: GitProcessOptions;

  constructor(opts: {
    path: string;
    isGitRepo: boolean;
    isWorktree: boolean;
    shellPath?: string;
  }) {
    this.path = opts.path;
    this.isGitRepo = opts.isGitRepo;
    this.isWorktree = opts.isWorktree;
    this.gitProcessOptions = {
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
    };
    this.ws = new Workspace(opts.path, this.gitProcessOptions);
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  async getDefaultBranch(): Promise<string | null> {
    if (!this.isGitRepo) {
      return null;
    }
    return (
      (await readDefaultBranch(this.path, {
        timeoutMs: WORKSPACE_BRANCH_GIT_TIMEOUT_MS,
        ...this.gitProcessOptions,
      })) ?? null
    );
  }

  getHeadSha(): Promise<string | null> {
    return this.ws.getHeadSha();
  }

  getLocalStateFingerprint(): Promise<string> {
    return this.ws.getLocalStateFingerprint();
  }

  getSharedGitRefsFingerprint(): Promise<string> {
    return this.ws.getSharedGitRefsFingerprint();
  }

  getAdditionalWorkspaceWriteRoots(): Promise<string[]> {
    if (!this.isGitRepo || !this.isWorktree) {
      return Promise.resolve([]);
    }
    return resolveAdditionalWorkspaceWriteRoots(
      this.path,
      this.gitProcessOptions,
    );
  }

  getStatus(options?: StatusOptions): Promise<WorkspaceStatus> {
    return this.ws.getStatus(options);
  }

  getSourceFreshness(
    sourceBranch: string,
  ): Promise<EnvironmentSourceFreshness> {
    return this.ws.getSourceFreshness(sourceBranch);
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    return this.ws.diffFiles(args);
  }

  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    return this.ws.diffPatch(args);
  }

  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup> {
    return this.ws.getPullRequest(options);
  }

  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void> {
    return this.ws.runPullRequestAction(action, options);
  }

  commit(options: CommitOptions): Promise<CommitResult> {
    return this.ws.commit(options);
  }

  updateFromSource(
    options: SourceUpdateOptions,
  ): Promise<EnvironmentSourceUpdateResult> {
    return this.ws.updateFromSource(options);
  }
}

export function provisionWorkspace(
  opts: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  return provisionUnmanaged(opts);
}

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError(
      "path_not_found",
      `Unmanaged workspace path does not exist: ${opts.path}`,
    );
  }
  const isGitRepo = await detectGitRepo(opts.path, {
    ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
  });
  const gitProcessOptions =
    opts.shellPath === undefined ? {} : { shellPath: opts.shellPath };
  const isWorktree = isGitRepo
    ? await detectLinkedWorktree(opts.path, gitProcessOptions)
    : false;

  return new ProvisionedHostWorkspace({
    path: opts.path,
    isGitRepo,
    isWorktree,
    shellPath: opts.shellPath,
  });
}
