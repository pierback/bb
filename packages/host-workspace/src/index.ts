export {
  getPersonalWorkspaceRoot,
  openWorkspace,
  provisionWorkspace,
  validatePersonalWorkspaceTargetPath,
} from "./provision.js";
export type {
  HostWorkspace,
  PersonalWorkspaceOpts,
  ProvisionWorkspaceArgs,
  UnmanagedCheckoutOpts,
  UnmanagedWorkspaceOpts,
  ManagedWorkspaceBaseOpts,
  ManagedWorktreeOpts,
  ReconnectManagedWorktreeOpts,
} from "./provision.js";

export type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  FetchOptions,
  SourceUpdateOptions,
  PullRequestActionOptions,
  SquashMergeOptions,
  SquashMergeResult,
  StatusOptions,
} from "./workspace.js";

export {
  WorkspaceError,
  detectGitRepo,
  fetchRemoteBranches,
  fetchRemoteTrackingBranch,
  resolveRemoteTrackingBranch,
  getCheckoutRef,
  getCurrentBranch,
  getWorkspaceGitOperation,
  getGitCommonDir,
  gitBlobSize,
  hasUncommittedChanges,
  listBranches,
  listRemoteBranches,
  readDefaultBranch,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
} from "./git.js";
export type {
  DefaultBranchRefs,
  FetchRemoteBranchesResult,
  FetchRemoteTrackingBranchOptions,
  RemoteTrackingBranchTarget,
  ReadGitBlobResult,
} from "./git.js";

export {
  getPullRequestForCurrentBranch,
  parseGitHostPullRequest,
  type GitHostPullRequestLookup,
} from "./git-host.js";
