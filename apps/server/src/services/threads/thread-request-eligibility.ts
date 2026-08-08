import { getProjectSourceByHost } from "@bb/db";
import {
  type Environment,
  type LocalPathProjectSource,
  PERSONAL_PROJECT_ID,
} from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";
import {
  assertUsableHostId,
  requireConnectedPrimaryHostId,
} from "../hosts/primary-host.js";

type ThreadRequestEnvironment = EnvironmentArgs;
type ThreadRequestEnvironmentDeps = Pick<AppDeps, "config" | "db" | "hub">;
type HostThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "host" }
>;
type WorkspaceBackedHostWorkspace = Exclude<
  HostThreadRequestEnvironment["workspace"],
  { type: "personal" }
>;
type NestedManagedHostWorkspace = Extract<
  WorkspaceBackedHostWorkspace,
  { type: "managed-worktree"; parentEnvironmentId: string }
>;
type ReuseThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "reuse" }
>;
export interface ResolveStableThreadRequestEnvironmentArgs {
  environment: ThreadRequestEnvironment;
  projectId: string;
}

export interface ResolvedHostThreadRequestEnvironment {
  hostId: string;
  localSource: LocalPathProjectSource | null;
  parentEnvironment: Environment | null;
  type: "host";
  unmanagedPath: string | null;
  workspace: WorkspaceBackedHostWorkspace;
}

export interface ResolvedReuseThreadRequestEnvironment {
  environment: Environment;
  type: "reuse";
}

export interface ResolvedPersonalThreadRequestEnvironment {
  hostId: string | null;
  type: "personal";
}

export type ResolvedStableThreadRequestEnvironment =
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment
  | ResolvedReuseThreadRequestEnvironment;

function requireHostEnvironmentId(
  environment: HostThreadRequestEnvironment,
): string {
  if (environment.hostId !== undefined) {
    return environment.hostId;
  }
  throw new ApiError(
    400,
    "invalid_request",
    "hostId is required for workspace-backed thread creation",
  );
}

function assertPersonalWorkspaceProjectCompatibility(projectId: string): void {
  if (projectId !== PERSONAL_PROJECT_ID) {
    throw new ApiError(
      400,
      "invalid_request",
      "Personal workspaces are only supported for the personal project",
    );
  }
}

function assertReuseWorkspaceProjectCompatibility(
  projectId: string,
  environment: Environment,
): void {
  const projectIsPersonal = projectId === PERSONAL_PROJECT_ID;
  const environmentIsPersonal =
    environment.workspaceProvisionType === "personal";
  if (projectIsPersonal && !environmentIsPersonal) {
    throw new ApiError(
      409,
      "invalid_request",
      "Personal project threads must reuse a personal workspace",
    );
  }
  if (!projectIsPersonal && environmentIsPersonal) {
    throw new ApiError(
      409,
      "invalid_request",
      "Standard project threads cannot reuse personal workspaces",
    );
  }
}

function isNestedManagedHostWorkspace(
  workspace: WorkspaceBackedHostWorkspace,
): workspace is NestedManagedHostWorkspace {
  return (
    workspace.type === "managed-worktree" && "parentEnvironmentId" in workspace
  );
}

function resolveNestedManagedHostEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: HostThreadRequestEnvironment,
  workspace: NestedManagedHostWorkspace,
  projectId: string,
): ResolvedHostThreadRequestEnvironment {
  const parentEnvironment = requireEnvironment(
    deps.db,
    workspace.parentEnvironmentId,
  );
  if (parentEnvironment.projectId !== projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Parent environment belongs to a different project",
    );
  }
  if (parentEnvironment.status !== "ready") {
    throwEnvironmentNotReady(parentEnvironment);
  }
  if (
    !parentEnvironment.managed ||
    parentEnvironment.workspaceProvisionType !== "managed-worktree" ||
    !parentEnvironment.isGitRepo ||
    !parentEnvironment.isWorktree ||
    parentEnvironment.path === null
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Parent environment must be a ready managed Git worktree",
    );
  }
  if (
    environment.hostId !== undefined &&
    environment.hostId !== parentEnvironment.hostId
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Nested managed environments must use their parent environment's host",
    );
  }

  assertUsableHostId(deps, { hostId: parentEnvironment.hostId });
  return {
    hostId: parentEnvironment.hostId,
    localSource: null,
    parentEnvironment,
    type: "host",
    unmanagedPath: null,
    workspace,
  };
}

function resolveHostThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: HostThreadRequestEnvironment,
  projectId: string,
):
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment {
  if (environment.workspace.type === "personal") {
    assertPersonalWorkspaceProjectCompatibility(projectId);
    const hostId = environment.hostId ?? requireConnectedPrimaryHostId(deps);
    assertUsableHostId(deps, { hostId });
    return {
      hostId,
      type: "personal",
    };
  }

  if (isNestedManagedHostWorkspace(environment.workspace)) {
    return resolveNestedManagedHostEnvironment(
      deps,
      environment,
      environment.workspace,
      projectId,
    );
  }

  const hostId = requireHostEnvironmentId(environment);
  assertUsableHostId(deps, { hostId });

  if (
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path !== null
  ) {
    return {
      hostId,
      localSource: null,
      parentEnvironment: null,
      type: "host",
      unmanagedPath: environment.workspace.path,
      workspace: environment.workspace,
    };
  }

  const localSource = getProjectSourceByHost(deps.db, projectId, hostId);
  if (!localSource || localSource.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }

  return {
    hostId,
    localSource,
    parentEnvironment: null,
    type: "host",
    unmanagedPath:
      environment.workspace.type === "unmanaged" ? localSource.path : null,
    workspace: environment.workspace,
  };
}

function resolveReuseThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: ReuseThreadRequestEnvironment,
  projectId: string,
): ResolvedReuseThreadRequestEnvironment {
  const reusedEnvironment = requireEnvironment(
    deps.db,
    environment.environmentId,
  );
  if (reusedEnvironment.projectId !== projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different project",
    );
  }
  assertReuseWorkspaceProjectCompatibility(projectId, reusedEnvironment);
  assertUsableHostId(deps, { hostId: reusedEnvironment.hostId });
  return {
    environment: reusedEnvironment,
    type: "reuse",
  };
}

export function resolveStableThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  args: ResolveStableThreadRequestEnvironmentArgs,
): ResolvedStableThreadRequestEnvironment {
  switch (args.environment.type) {
    case "host":
      return resolveHostThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
      );
    case "reuse":
      return resolveReuseThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
      );
    default: {
      const exhaustiveCheck: never = args.environment;
      throw new Error(
        `Unsupported thread request environment: ${exhaustiveCheck}`,
      );
    }
  }
}
