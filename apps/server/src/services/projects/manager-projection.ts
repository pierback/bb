import {
  listEnvironments,
  listThreadsWithPendingInteractionStateForProjects,
} from "@bb/db";
import type { Environment, ThreadListEntry } from "@bb/domain";
import type {
  ProjectManagerProjectionDiff,
  ProjectManagerProjectionEnvironment,
  ProjectManagerProjectionPullRequest,
  ProjectManagerProjectionResponse,
  ProjectManagerProjectionSourceFreshness,
  ProjectResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { getEnvironmentPullRequest } from "../environments/pull-request.js";
import { getEnvironmentSourceFreshness } from "../environments/source-freshness.js";
import { getEnvironmentWorkspaceStatus } from "../environments/workspace-status.js";
import { toThreadListEntryResponses } from "../threads/thread-runtime-display.js";

function pendingThreadCount(threads: readonly ThreadListEntry[]): number {
  return threads.reduce(
    (count, thread) => count + (thread.hasPendingInteraction ? 1 : 0),
    0,
  );
}

function notReadyState(environment: Environment) {
  return {
    state: "not_ready" as const,
    environmentStatus: environment.status,
  };
}

function projectionReadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.body.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Operational state is temporarily unavailable";
}

function logProjectionReadFailure(
  deps: AppDeps,
  environment: Environment,
  dimension: "diff" | "pull_request" | "source_freshness",
  error: unknown,
): void {
  deps.logger.warn(
    { dimension, environmentId: environment.id, err: error },
    "Project manager projection read failed",
  );
}

async function readDiffState(
  deps: AppDeps,
  environment: Environment,
): Promise<ProjectManagerProjectionDiff> {
  if (environment.status !== "ready") {
    return notReadyState(environment);
  }
  try {
    return {
      state: "resolved",
      value: await getEnvironmentWorkspaceStatus(deps, environment),
    };
  } catch (error) {
    logProjectionReadFailure(deps, environment, "diff", error);
    return { state: "unavailable", message: projectionReadErrorMessage(error) };
  }
}

async function readPullRequestState(
  deps: AppDeps,
  environment: Environment,
): Promise<ProjectManagerProjectionPullRequest> {
  if (environment.status !== "ready") {
    return notReadyState(environment);
  }
  try {
    return {
      state: "resolved",
      value: await getEnvironmentPullRequest(deps, environment),
    };
  } catch (error) {
    logProjectionReadFailure(deps, environment, "pull_request", error);
    return { state: "unavailable", message: projectionReadErrorMessage(error) };
  }
}

async function readSourceFreshnessState(
  deps: AppDeps,
  environment: Environment,
): Promise<ProjectManagerProjectionSourceFreshness> {
  if (environment.status !== "ready") {
    return notReadyState(environment);
  }
  try {
    return {
      state: "resolved",
      value: await getEnvironmentSourceFreshness(deps, environment, {
        autoUpdate: false,
      }),
    };
  } catch (error) {
    logProjectionReadFailure(deps, environment, "source_freshness", error);
    return { state: "unavailable", message: projectionReadErrorMessage(error) };
  }
}

async function buildEnvironmentProjection(
  deps: AppDeps,
  environment: Environment,
  threads: ThreadListEntry[],
): Promise<ProjectManagerProjectionEnvironment> {
  const [diff, pullRequest, sourceFreshness] = await Promise.all([
    readDiffState(deps, environment),
    readPullRequestState(deps, environment),
    readSourceFreshnessState(deps, environment),
  ]);
  return {
    environment,
    threads,
    interaction: { pendingThreadCount: pendingThreadCount(threads) },
    diff,
    pullRequest,
    sourceFreshness,
  };
}

export async function getProjectManagerProjection(
  deps: AppDeps,
  project: ProjectResponse,
): Promise<ProjectManagerProjectionResponse> {
  const environments = listEnvironments(deps.db, project.id)
    .filter((environment) => environment.status !== "destroyed")
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  const environmentIds = new Set(
    environments.map((environment) => environment.id),
  );
  const threads = toThreadListEntryResponses(deps, {
    threads: listThreadsWithPendingInteractionStateForProjects(deps.db, {
      archived: false,
      projectIds: [project.id],
    }),
  });
  const threadsByEnvironmentId = new Map<string, ThreadListEntry[]>();
  const unassignedThreads: ThreadListEntry[] = [];
  for (const thread of threads) {
    if (
      thread.environmentId === null ||
      !environmentIds.has(thread.environmentId)
    ) {
      unassignedThreads.push(thread);
      continue;
    }
    const environmentThreads = threadsByEnvironmentId.get(thread.environmentId);
    if (environmentThreads) {
      environmentThreads.push(thread);
    } else {
      threadsByEnvironmentId.set(thread.environmentId, [thread]);
    }
  }

  return {
    project,
    generatedAt: Date.now(),
    environments: await Promise.all(
      environments.map((environment) =>
        buildEnvironmentProjection(
          deps,
          environment,
          threadsByEnvironmentId.get(environment.id) ?? [],
        ),
      ),
    ),
    unassignedThreads,
    interaction: { pendingThreadCount: pendingThreadCount(threads) },
  };
}
