import path from "node:path";
import type { WorkspaceProvisionType } from "@bb/domain";
import type { WorkspaceContext } from "@bb/host-daemon-contract";
import type { ProvisionWorkspaceArgs } from "@bb/host-workspace";

export const MIGRATED_WORKSPACES_DIRECTORY = "migrated-workspaces";
export const MIGRATED_WORKSPACES_VERSION_DIRECTORY = "v2";
export const MIGRATED_MANAGED_WORKTREE_DIRECTORY = "workspace";
export const MIGRATED_MANAGED_COMMON_GIT_DIRECTORY = ".bb-managed-source.git";

interface ReconnectProvisionArgs {
  dataDir?: string;
  environmentId: string;
  personalWorkspaceRoot?: string;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

interface WorkspaceContextProvisionArgs {
  dataDir?: string;
  environmentId: string;
  personalWorkspaceRoot?: string;
  workspaceContext: WorkspaceContext;
}

export function reconnectProvisionArgs(
  args: ReconnectProvisionArgs,
): ProvisionWorkspaceArgs {
  switch (args.workspaceProvisionType) {
    case "unmanaged":
      return {
        workspaceProvisionType: "unmanaged",
        path: args.workspacePath,
      };
    case "managed-worktree": {
      const ownedCommonGitDir = args.dataDir
        ? migratedManagedCommonGitDirForWorkspace({
            dataDir: args.dataDir,
            workspacePath: args.workspacePath,
          })
        : null;
      return {
        workspaceProvisionType: "reconnect-managed-worktree",
        path: args.workspacePath,
        ...(ownedCommonGitDir ? { ownedCommonGitDir } : {}),
      };
    }
    case "personal":
      if (!args.personalWorkspaceRoot) {
        throw new Error(
          "Personal workspace root is required to reconnect a personal workspace",
        );
      }
      return {
        workspaceProvisionType: "personal",
        environmentId: args.environmentId,
        personalWorkspaceRoot: args.personalWorkspaceRoot,
        targetPath: args.workspacePath,
      };
  }
}

export function reconnectProvisionArgsFromWorkspaceContext(
  args: WorkspaceContextProvisionArgs,
): ProvisionWorkspaceArgs {
  return reconnectProvisionArgs({
    ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
    environmentId: args.environmentId,
    ...(args.personalWorkspaceRoot !== undefined
      ? { personalWorkspaceRoot: args.personalWorkspaceRoot }
      : {}),
    workspacePath: args.workspaceContext.workspacePath,
    workspaceProvisionType: args.workspaceContext.workspaceProvisionType,
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
