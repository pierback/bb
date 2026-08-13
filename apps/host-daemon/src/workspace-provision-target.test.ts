import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATED_MANAGED_COMMON_GIT_DIRECTORY,
  MIGRATED_MANAGED_WORKTREE_DIRECTORY,
  MIGRATED_WORKSPACES_DIRECTORY,
  MIGRATED_WORKSPACES_VERSION_DIRECTORY,
  migratedManagedCommonGitDirForWorkspace,
  reconnectProvisionArgs,
} from "./workspace-provision-target.js";

describe("workspace provision target", () => {
  const dataDir = path.resolve("/bb-test-data");
  const migrationRoot = path.join(
    dataDir,
    MIGRATED_WORKSPACES_DIRECTORY,
    MIGRATED_WORKSPACES_VERSION_DIRECTORY,
    "project-a1b2c3",
  );
  const workspacePath = path.join(
    migrationRoot,
    MIGRATED_MANAGED_WORKTREE_DIRECTORY,
  );
  const commonGitDir = path.join(
    migrationRoot,
    MIGRATED_MANAGED_COMMON_GIT_DIRECTORY,
  );

  it("reconnects the exact migrated layout with its owned common Git directory", () => {
    expect(
      reconnectProvisionArgs({
        dataDir,
        environmentId: "env_migrated",
        workspacePath,
        workspaceProvisionType: "managed-worktree",
      }),
    ).toEqual({
      workspaceProvisionType: "reconnect-managed-worktree",
      path: workspacePath,
      ownedCommonGitDir: commonGitDir,
    });
  });

  it("does not claim ownership of managed worktrees outside the exact layout", () => {
    const lookalikePaths = [
      path.join(dataDir, MIGRATED_WORKSPACES_DIRECTORY, "project-a1b2c3"),
      path.join(
        dataDir,
        MIGRATED_WORKSPACES_DIRECTORY,
        "v1",
        "project-a1b2c3",
        "workspace",
      ),
      path.join(migrationRoot, "other-workspace"),
      path.join(dataDir, "other-root", "project-a1b2c3", "workspace"),
      path.join(
        dataDir,
        MIGRATED_WORKSPACES_DIRECTORY,
        "nested",
        "project-a1b2c3",
        "workspace",
      ),
    ];

    for (const candidate of lookalikePaths) {
      expect(
        migratedManagedCommonGitDirForWorkspace({
          dataDir,
          workspacePath: candidate,
        }),
      ).toBeNull();
    }
  });
});
