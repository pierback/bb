import type { WorkspaceContext } from "@bb/host-daemon-contract";
import type { ProvisionWorkspaceArgs } from "@bb/host-workspace";
import path from "node:path";

export const MIGRATED_WORKSPACES_DIRECTORY = "migrated-workspaces";
export const MIGRATED_WORKSPACES_VERSION_DIRECTORY = "v2";
export const MIGRATED_MANAGED_WORKTREE_DIRECTORY = "workspace";
export const MIGRATED_MANAGED_COMMON_GIT_DIRECTORY = ".bb-managed-source.git";

interface ReconnectProvisionArgs {
  workspacePath: string;
}

interface WorkspaceContextProvisionArgs {
  workspaceContext: WorkspaceContext;
}

export function reconnectProvisionArgs(
  args: ReconnectProvisionArgs,
): ProvisionWorkspaceArgs {
  return {
    path: args.workspacePath,
  };
}

export function reconnectProvisionArgsFromWorkspaceContext(
  args: WorkspaceContextProvisionArgs,
): ProvisionWorkspaceArgs {
  return reconnectProvisionArgs({
    workspacePath: args.workspaceContext.workspacePath,
  });
}

export function migratedManagedCommonGitDirForWorkspace(args: {
  dataDir: string;
  workspacePath: string;
}): string | null {
  const migratedWorkspacesRoot = path.resolve(
    args.dataDir,
    MIGRATED_WORKSPACES_DIRECTORY,
    MIGRATED_WORKSPACES_VERSION_DIRECTORY,
  );
  const workspacePath = path.resolve(args.workspacePath);
  const migrationRoot = path.dirname(workspacePath);
  if (
    path.basename(workspacePath) !== MIGRATED_MANAGED_WORKTREE_DIRECTORY ||
    path.dirname(migrationRoot) !== migratedWorkspacesRoot
  ) {
    return null;
  }
  return path.join(migrationRoot, MIGRATED_MANAGED_COMMON_GIT_DIRECTORY);
}
