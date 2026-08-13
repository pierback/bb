import {
  getStoredEnvironmentThreadTabs,
  listEnvironmentThreadTabEligibleIds,
  replaceStoredEnvironmentThreadTabs,
} from "@bb/db";
import {
  environmentThreadTabIdsSchema,
  publicApiRoutes,
  typedRoutes,
  type EnvironmentThreadTabsResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { requireEnvironment } from "../services/lib/entity-lookup.js";
import type { AppDeps } from "../types.js";

function readEnvironmentThreadTabs(
  deps: AppDeps,
  environmentId: string,
): EnvironmentThreadTabsResponse {
  const stored = getStoredEnvironmentThreadTabs(deps.db, environmentId);
  if (!stored) return { revision: 0, threadIds: [] };

  const threadIds = environmentThreadTabIdsSchema.parse(
    JSON.parse(stored.threadIdsJson),
  );
  const eligibleIds = new Set(
    listEnvironmentThreadTabEligibleIds(deps.db, {
      environmentId,
      threadIds,
    }),
  );
  return {
    revision: stored.revision,
    threadIds: threadIds.filter((threadId) => eligibleIds.has(threadId)),
  };
}

function assertEligibleThreadTabs(
  deps: AppDeps,
  environmentId: string,
  threadIds: readonly string[],
): void {
  const eligibleIds = listEnvironmentThreadTabEligibleIds(deps.db, {
    environmentId,
    threadIds,
  });
  if (eligibleIds.length !== threadIds.length) {
    throw new ApiError(
      400,
      "invalid_request",
      "Every tab must be a visible, non-deleted thread in this environment",
    );
  }
}

export function registerEnvironmentThreadTabRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.environments;

  get(routes.threadTabs, (context) => {
    const environment = requireEnvironment(deps.db, context.req.param("id"));
    return context.json(readEnvironmentThreadTabs(deps, environment.id));
  });

  put(routes.updateThreadTabs, (context, payload) => {
    const environment = requireEnvironment(deps.db, context.req.param("id"));
    assertEligibleThreadTabs(deps, environment.id, payload.threadIds);
    const result = replaceStoredEnvironmentThreadTabs(deps.db, {
      environmentId: environment.id,
      expectedRevision: payload.expectedRevision,
      threadIdsJson: JSON.stringify(payload.threadIds),
    });
    if (result.outcome === "conflict") {
      throw new ApiError(
        409,
        "environment_thread_tabs_conflict",
        "Worktree thread tabs changed on another client",
        { details: { currentRevision: result.revision } },
      );
    }
    deps.hub.notifyEnvironment(environment.id, ["thread-tabs-changed"]);
    return context.json({
      revision: result.revision,
      threadIds: payload.threadIds,
    });
  });
}
