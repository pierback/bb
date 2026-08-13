import type { WorkspaceProvisionType } from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";

export interface ChildThreadEnvironmentSource {
  environmentId: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

/**
 * Resolves the execution environment for a thread spawned from another thread
 * (a fork or a side chat). Shared by both builders so the two flows stay in
 * lockstep:
 *
 * - A managed source gets a fresh nested managed worktree. The server snapshots
 *   the parent's current commit and provisions from that immutable SHA.
 * - Personal and unmanaged sources are reused because they are not valid
 *   managed-worktree parents.
 */
export function resolveChildThreadEnvironment(
  sourceEnvironment: ChildThreadEnvironmentSource,
): EnvironmentArgs {
  if (sourceEnvironment.workspaceProvisionType === "managed-worktree") {
    return {
      type: "host",
      workspace: {
        type: "managed-worktree",
        parentEnvironmentId: sourceEnvironment.environmentId,
      },
    };
  }

  return {
    type: "reuse",
    environmentId: sourceEnvironment.environmentId,
  };
}
