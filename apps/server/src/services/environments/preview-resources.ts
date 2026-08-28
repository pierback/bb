import {
  createEnvironmentPreviewResourceId,
  getStoredEnvironmentPreviewResources,
  replaceStoredEnvironmentPreviewResources,
} from "@bb/db";
import {
  EnvironmentPreviewResourceTransitionError,
  environmentPreviewResourcesStateSchema,
  transitionEnvironmentPreviewResources,
  type EnvironmentPreviewResourceCommand,
} from "@bb/domain";
import type {
  CreateEnvironmentPreviewResourceRequest,
  EnvironmentPreviewResourcesResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";

function readPreviewResources(
  deps: AppDeps,
  environmentId: string,
): EnvironmentPreviewResourcesResponse {
  requireEnvironment(deps.db, environmentId);
  const stored = getStoredEnvironmentPreviewResources(deps.db, environmentId);
  if (!stored) {
    return {
      previewResources: [],
      revision: 0,
      selectedPreviewResourceId: null,
    };
  }
  return environmentPreviewResourcesStateSchema.parse({
    previewResources: JSON.parse(stored.previewResourcesJson),
    revision: stored.revision,
    selectedPreviewResourceId: stored.selectedPreviewResourceId,
  });
}

function throwTransitionError(
  error: EnvironmentPreviewResourceTransitionError,
): never {
  switch (error.code) {
    case "resource_not_found":
      throw new ApiError(404, "preview_resource_not_found", error.message);
    case "duplicate_resource":
    case "resource_limit_reached":
      throw new ApiError(409, error.code, error.message);
  }
}

function mutatePreviewResources(
  deps: AppDeps,
  args: {
    command: EnvironmentPreviewResourceCommand;
    environmentId: string;
    expectedRevision: number;
  },
): EnvironmentPreviewResourcesResponse {
  const current = readPreviewResources(deps, args.environmentId);
  if (current.revision !== args.expectedRevision) {
    throw new ApiError(
      409,
      "environment_preview_resources_conflict",
      "Environment preview resources changed on another client",
      { details: { currentRevision: current.revision } },
    );
  }

  let next: EnvironmentPreviewResourcesResponse;
  try {
    next = transitionEnvironmentPreviewResources(current, args.command);
  } catch (error) {
    if (error instanceof EnvironmentPreviewResourceTransitionError) {
      throwTransitionError(error);
    }
    throw error;
  }
  if (next.revision === current.revision) return current;

  const result = replaceStoredEnvironmentPreviewResources(deps.db, {
    environmentId: args.environmentId,
    expectedRevision: current.revision,
    previewResourcesJson: JSON.stringify(next.previewResources),
    selectedPreviewResourceId: next.selectedPreviewResourceId,
  });
  if (result.outcome === "conflict") {
    throw new ApiError(
      409,
      "environment_preview_resources_conflict",
      "Environment preview resources changed on another client",
      { details: { currentRevision: result.revision } },
    );
  }
  deps.hub.notifyEnvironment(args.environmentId, ["preview-resources-changed"]);
  return { ...next, revision: result.revision };
}

export function listEnvironmentPreviewResources(
  deps: AppDeps,
  environmentId: string,
): EnvironmentPreviewResourcesResponse {
  return readPreviewResources(deps, environmentId);
}

export function createEnvironmentPreviewResource(
  deps: AppDeps,
  environmentId: string,
  request: CreateEnvironmentPreviewResourceRequest,
): EnvironmentPreviewResourcesResponse {
  const now = Date.now();
  return mutatePreviewResources(deps, {
    command: {
      resource: {
        createdAt: now,
        id: createEnvironmentPreviewResourceId(),
        kind: request.kind,
        label: request.label,
        updatedAt: now,
        url: request.url,
      },
      type: "add",
    },
    environmentId,
    expectedRevision: request.expectedRevision,
  });
}

export function deleteEnvironmentPreviewResource(
  deps: AppDeps,
  args: {
    environmentId: string;
    expectedRevision: number;
    resourceId: string;
  },
): EnvironmentPreviewResourcesResponse {
  return mutatePreviewResources(deps, {
    command: { resourceId: args.resourceId, type: "remove" },
    environmentId: args.environmentId,
    expectedRevision: args.expectedRevision,
  });
}

export function selectEnvironmentPreviewResource(
  deps: AppDeps,
  args: {
    environmentId: string;
    expectedRevision: number;
    selectedPreviewResourceId: string | null;
  },
): EnvironmentPreviewResourcesResponse {
  return mutatePreviewResources(deps, {
    command: {
      resourceId: args.selectedPreviewResourceId,
      type: "select",
    },
    environmentId: args.environmentId,
    expectedRevision: args.expectedRevision,
  });
}
