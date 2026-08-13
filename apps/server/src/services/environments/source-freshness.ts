import { listLiveThreadsInEnvironment } from "@bb/db";
import type { Environment } from "@bb/domain";
import type {
  HostDaemonOnlineRpcResult,
  WorkspaceResolutionFailure,
} from "@bb/host-daemon-contract";
import type {
  EnvironmentSourceFreshnessBlocker,
  EnvironmentSourceFreshnessResponse,
  EnvironmentSourceUpdateResponse,
} from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { runLiveCommandAndWait } from "../hosts/live-command-wait.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireWorkspaceCommandTarget } from "./workspace-command-target.js";

type SourceFreshnessHostResult =
  HostDaemonOnlineRpcResult<"workspace.source_freshness">;
type AvailableSourceFreshnessHostResult = Extract<
  SourceFreshnessHostResult,
  { outcome: "available" }
>;

const RUNNING_THREAD_STATUSES = new Set(["starting", "active", "stopping"]);

function resolveEnvironmentSourceBranch(
  environment: Environment,
): string | null {
  return environment.baseBranch ?? environment.defaultBranch;
}

function resolveNotApplicable(
  environment: Environment,
): Extract<
  EnvironmentSourceFreshnessResponse,
  { outcome: "not_applicable" }
> | null {
  if (!environment.isGitRepo) {
    return {
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Source freshness is not available for non-git environments",
    };
  }
  if (
    !environment.managed ||
    !environment.isWorktree ||
    environment.workspaceProvisionType !== "managed-worktree"
  ) {
    return {
      outcome: "not_applicable",
      reason: "non_managed_environment",
      message: "Source freshness is only available for managed worktrees",
    };
  }
  if (!resolveEnvironmentSourceBranch(environment)) {
    return {
      outcome: "not_applicable",
      reason: "missing_source_branch",
      message: "The managed worktree has no recorded source branch",
    };
  }
  return null;
}

async function readSourceFreshness(
  deps: LoggedWorkSessionDeps,
  environment: Environment,
  sourceBranch: string,
): Promise<SourceFreshnessHostResult> {
  const target = requireWorkspaceCommandTarget(environment);
  return callHostRetryableOnlineRpc(deps, {
    hostId: target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "workspace.source_freshness",
      environmentId: target.environmentId,
      workspaceContext: target.workspaceContext,
      sourceBranch,
    },
  });
}

function hasRunningThread(
  deps: LoggedWorkSessionDeps,
  environmentId: string,
): boolean {
  return listLiveThreadsInEnvironment(deps.db, { environmentId }).some(
    (thread) => RUNNING_THREAD_STATUSES.has(thread.status),
  );
}

function sourceUpdateBlockers(
  deps: LoggedWorkSessionDeps,
  environmentId: string,
  result: AvailableSourceFreshnessHostResult,
): EnvironmentSourceFreshnessBlocker[] {
  const blockers: EnvironmentSourceFreshnessBlocker[] = [];
  if (!result.environmentQuiescent || hasRunningThread(deps, environmentId)) {
    blockers.push("active_threads");
  }
  if (result.sourceFreshness.hasUncommittedChanges) {
    blockers.push("uncommitted_changes");
  }
  if (result.sourceFreshness.gitOperation.kind !== "none") {
    blockers.push("git_operation");
  }
  return blockers;
}

function availableResponse(args: {
  result: AvailableSourceFreshnessHostResult;
  blockers: EnvironmentSourceFreshnessBlocker[];
  autoUpdated: boolean;
}): EnvironmentSourceFreshnessResponse {
  const requiresUpdate =
    args.result.sourceFreshness.state === "behind" ||
    args.result.sourceFreshness.state === "diverged";
  return {
    outcome: "available",
    sourceFreshness: args.result.sourceFreshness,
    autoUpdated: args.autoUpdated,
    updateAction: requiresUpdate
      ? {
          kind: "manual",
          enabled: args.blockers.length === 0,
          blockers: args.blockers,
        }
      : { kind: "none" },
  };
}

function unavailableResponse(
  failure: WorkspaceResolutionFailure,
): EnvironmentSourceFreshnessResponse {
  return { outcome: "unavailable", failure };
}

function isSourceUpdateRace(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    [
      "source_update_active_threads",
      "source_update_dirty",
      "source_update_git_operation",
    ].includes(error.body.code)
  );
}

export async function getEnvironmentSourceFreshness(
  deps: LoggedWorkSessionDeps,
  environment: Environment,
  options: { autoUpdate: boolean },
): Promise<EnvironmentSourceFreshnessResponse> {
  const notApplicable = resolveNotApplicable(environment);
  if (notApplicable) {
    return notApplicable;
  }
  const sourceBranch = resolveEnvironmentSourceBranch(environment);
  if (!sourceBranch) {
    throw new Error("Applicable source freshness requires a source branch");
  }

  let observed = await readSourceFreshness(deps, environment, sourceBranch);
  if (observed.outcome === "unavailable") {
    return unavailableResponse(observed.failure);
  }
  let blockers = sourceUpdateBlockers(deps, environment.id, observed);

  if (
    options.autoUpdate &&
    observed.sourceFreshness.state === "behind" &&
    blockers.length === 0
  ) {
    const target = requireWorkspaceCommandTarget(environment);
    try {
      const update = await runLiveCommandAndWait(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "workspace.source_update",
          environmentId: target.environmentId,
          workspaceContext: target.workspaceContext,
          sourceBranch,
          mode: "automatic",
        },
      });
      observed = {
        outcome: "available",
        sourceFreshness: update.after,
        environmentQuiescent: true,
      };
      return availableResponse({
        result: observed,
        blockers: [],
        autoUpdated: update.updated,
      });
    } catch (error) {
      if (!isSourceUpdateRace(error)) {
        throw error;
      }
      observed = await readSourceFreshness(deps, environment, sourceBranch);
      if (observed.outcome === "unavailable") {
        return unavailableResponse(observed.failure);
      }
      blockers = sourceUpdateBlockers(deps, environment.id, observed);
    }
  }

  return availableResponse({
    result: observed,
    blockers,
    autoUpdated: false,
  });
}

export async function updateEnvironmentSource(
  deps: LoggedWorkSessionDeps,
  environment: Environment,
): Promise<EnvironmentSourceUpdateResponse> {
  const notApplicable = resolveNotApplicable(environment);
  if (notApplicable) {
    throw new ApiError(
      409,
      "source_update_not_applicable",
      notApplicable.message,
    );
  }
  const sourceBranch = resolveEnvironmentSourceBranch(environment);
  if (!sourceBranch) {
    throw new Error("Applicable source update requires a source branch");
  }

  const observed = await readSourceFreshness(deps, environment, sourceBranch);
  if (observed.outcome === "unavailable") {
    throw new ApiError(409, "workspace_unavailable", observed.failure.message);
  }
  const blockers = sourceUpdateBlockers(deps, environment.id, observed);
  if (blockers.length > 0) {
    throw new ApiError(
      409,
      "source_update_blocked",
      `Source update is blocked by: ${blockers.join(", ")}`,
    );
  }

  const target = requireWorkspaceCommandTarget(environment);
  try {
    const update = await runLiveCommandAndWait(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.source_update",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        sourceBranch,
        mode: "manual",
      },
    });
    return {
      sourceFreshness: update.after,
      updated: update.updated,
      strategy: update.strategy,
    };
  } catch (error) {
    if (
      isSourceUpdateRace(error) ||
      (error instanceof ApiError &&
        error.body.code === "source_update_conflict")
    ) {
      throw new ApiError(409, error.body.code, error.body.message);
    }
    throw error;
  }
}
