import { recordEnvironmentCurrentBranch } from "@bb/db/internal-environment-lifecycle";
import type { Environment } from "@bb/domain";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import type { EnvironmentStatusResponse } from "@bb/server-contract";
import {
  COMMAND_TIMEOUT_MS,
  WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_BYTES,
  WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES,
} from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  requireWorkspaceCommandTarget,
  type WorkspaceCommandTarget,
} from "./workspace-command-target.js";

type WorkspaceStatusResult = HostDaemonOnlineRpcResult<"workspace.status">;

interface CallEnvironmentWorkspaceStatusArgs {
  environment: Pick<Environment, "id">;
  target: WorkspaceCommandTarget;
  mergeBaseBranch?: string;
}

function normalizeObservedDefaultBranch(defaultBranch: string): string | null {
  return defaultBranch.length > 0 ? defaultBranch : null;
}

export async function callEnvironmentWorkspaceStatus(
  deps: WorkSessionDeps,
  args: CallEnvironmentWorkspaceStatusArgs,
): Promise<WorkspaceStatusResult> {
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "workspace.status",
      environmentId: args.target.environmentId,
      workspaceContext: args.target.workspaceContext,
      maxUntrackedLineStatFiles: WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES,
      maxUntrackedLineStatBytes: WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_BYTES,
      ...(args.mergeBaseBranch
        ? { mergeBaseBranch: args.mergeBaseBranch }
        : {}),
    },
  });

  if (result.outcome === "available") {
    recordEnvironmentCurrentBranch(deps.db, deps.hub, args.environment.id, {
      branchName: result.workspaceStatus.branch.currentBranch,
      defaultBranch: normalizeObservedDefaultBranch(
        result.workspaceStatus.branch.defaultBranch,
      ),
    });
  }

  return result;
}

export async function getEnvironmentWorkspaceStatus(
  deps: WorkSessionDeps,
  environment: Environment,
  options: { mergeBaseBranch?: string } = {},
): Promise<EnvironmentStatusResponse> {
  if (!environment.isGitRepo) {
    return {
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Workspace status is not available for non-git environments",
    };
  }
  const result = await callEnvironmentWorkspaceStatus(deps, {
    environment,
    target: requireWorkspaceCommandTarget(environment),
    ...(options.mergeBaseBranch
      ? { mergeBaseBranch: options.mergeBaseBranch }
      : {}),
  });
  return result.outcome === "available"
    ? { outcome: "available", workspace: result.workspaceStatus }
    : { outcome: "unavailable", failure: result.failure };
}
