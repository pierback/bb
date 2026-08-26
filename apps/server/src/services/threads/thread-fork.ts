import { getEnvironment, getThread } from "@bb/db";
import {
  PERSONAL_PROJECT_ID,
  type Environment,
  type PromptInput,
  type Thread,
  type ThreadTurnInitiator,
} from "@bb/domain";
import { supportsNativeFork } from "@bb/agent-providers";
import type {
  CreateThreadRequest,
  EnvironmentArgs,
  ForkThreadRequest,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveExistingThreadPermissionMode } from "./thread-execution-plan.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { createThreadFromRequest } from "./thread-create.js";

type ThreadForkDeps = LoggedPendingInteractionWorkSessionDeps;

type ThreadForkExecutionOverrides = Partial<
  Pick<
    CreateThreadRequest,
    "executionInputSources" | "model" | "reasoningLevel" | "serviceTier"
  >
>;

interface CreateThreadForkOptions {
  /** Idempotency identity for this source-derived thread creation. */
  creationOperation?: {
    fingerprint: string;
    id: string;
  };
  /** Per-turn execution choices supplied by a higher-level fork use case. */
  execution?: ThreadForkExecutionOverrides;
  /** Runtime authority when it differs from the fork's visible user message. */
  permissionInitiator?: ThreadTurnInitiator;
}

function requireForkSourceThread(
  deps: Pick<ThreadForkDeps, "db">,
  sourceThreadId: string,
): Thread {
  const sourceThread = getThread(deps.db, sourceThreadId);
  if (!sourceThread || sourceThread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Source thread not found");
  }
  if (sourceThread.archivedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "Cannot fork an archived source thread",
    );
  }
  return sourceThread;
}

function requireForkCapableProvider(sourceThread: Thread): void {
  if (!supportsNativeFork(sourceThread.providerId)) {
    throw new ApiError(
      400,
      "invalid_request",
      `Provider ${sourceThread.providerId} does not support thread forks`,
    );
  }
}

function requireSourceEnvironment(
  deps: Pick<ThreadForkDeps, "db">,
  sourceThread: Thread,
): Environment {
  const environment =
    sourceThread.environmentId === null
      ? null
      : getEnvironment(deps.db, sourceThread.environmentId);
  if (!environment || environment.status !== "ready" || !environment.path) {
    throw new ApiError(
      400,
      "invalid_request",
      "Source thread must have a ready environment to fork",
    );
  }
  return environment;
}

function resolveForkEnvironment(
  sourceEnvironment: Environment,
  args: {
    projectId: string;
    workspace: ForkThreadRequest["workspace"];
  },
): EnvironmentArgs {
  if (args.workspace === "reuse") {
    return { type: "reuse", environmentId: sourceEnvironment.id };
  }
  if (sourceEnvironment.workspaceProvisionType === "managed-worktree") {
    return {
      type: "host",
      workspace: {
        type: "managed-worktree",
        parentEnvironmentId: sourceEnvironment.id,
      },
    };
  }
  if (
    args.projectId === PERSONAL_PROJECT_ID ||
    sourceEnvironment.workspaceProvisionType === "personal"
  ) {
    return {
      type: "host",
      hostId: sourceEnvironment.hostId,
      workspace: { type: "personal" },
    };
  }
  const sourceBranchName = sourceEnvironment.branchName?.trim();
  return {
    type: "host",
    hostId: sourceEnvironment.hostId,
    workspace: {
      type: "managed-worktree",
      baseBranch: sourceBranchName
        ? { kind: "named", name: sourceBranchName }
        : { kind: "default" },
    },
  };
}

export async function createThreadForkFromRequest(
  deps: ThreadForkDeps,
  request: ForkThreadRequest,
  options: CreateThreadForkOptions = {},
) {
  const sourceThread = requireForkSourceThread(deps, request.sourceThreadId);
  requireForkCapableProvider(sourceThread);
  const sourceEnvironment = requireSourceEnvironment(deps, sourceThread);
  // A fork continues the source conversation, so it defaults to the source's
  // recorded execution options rather than provider defaults.
  const sourceExecution = getLastExecutionOptions(deps, sourceThread.id);
  const visibleInput = request.input ?? [];
  const agentContextSeed = request.agentContextSeed ?? [];
  const input: PromptInput[] = [...agentContextSeed, ...visibleInput];
  const isSeedOnlyIdleFork =
    visibleInput.length === 0 && agentContextSeed.length > 0;
  const hasModelOverride = options.execution?.model !== undefined;
  const hasReasoningLevelOverride =
    options.execution?.reasoningLevel !== undefined;
  const hasServiceTierOverride = options.execution?.serviceTier !== undefined;
  const hasPermissionModeOverride = request.permissionMode !== undefined;
  const model = options.execution?.model ?? sourceExecution?.model;
  const reasoningLevel =
    options.execution?.reasoningLevel ?? sourceExecution?.reasoningLevel;
  const serviceTier =
    options.execution?.serviceTier ?? sourceExecution?.serviceTier;
  const permissionMode =
    request.permissionMode ??
    resolveExistingThreadPermissionMode(deps, sourceThread.id);
  const suppliedExecutionInputSources =
    options.execution?.executionInputSources;
  const executionInputSources =
    options.execution === undefined
      ? undefined
      : {
          providerId: "client-preference" as const,
          ...(model === undefined
            ? {}
            : {
                model:
                  (hasModelOverride
                    ? suppliedExecutionInputSources?.model
                    : undefined) ??
                  (hasModelOverride ? "explicit" : "client-preference"),
              }),
          ...(reasoningLevel === undefined
            ? {}
            : {
                reasoningLevel:
                  (hasReasoningLevelOverride
                    ? suppliedExecutionInputSources?.reasoningLevel
                    : undefined) ??
                  (hasReasoningLevelOverride
                    ? "explicit"
                    : "client-preference"),
              }),
          ...(serviceTier === undefined
            ? {}
            : {
                serviceTier:
                  (hasServiceTierOverride
                    ? suppliedExecutionInputSources?.serviceTier
                    : undefined) ??
                  (hasServiceTierOverride ? "explicit" : "client-preference"),
              }),
          permissionMode:
            (hasPermissionModeOverride
              ? suppliedExecutionInputSources?.permissionMode
              : undefined) ??
            (hasPermissionModeOverride ? "explicit" : "client-preference"),
        };

  return createThreadFromRequest(
    deps,
    {
      environment: resolveForkEnvironment(sourceEnvironment, {
        projectId: sourceThread.projectId,
        workspace: request.workspace,
      }),
      input,
      origin: request.origin,
      ...(request.originPluginId === undefined
        ? {}
        : { originPluginId: request.originPluginId }),
      originKind: "fork",
      permissionMode,
      ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(executionInputSources === undefined ? {} : { executionInputSources }),
      projectId: sourceThread.projectId,
      providerId: sourceThread.providerId,
      ...(request.sourceSeqEnd === undefined
        ? {}
        : { sourceSeqEnd: request.sourceSeqEnd }),
      sourceThreadId: sourceThread.id,
      startedOnBehalfOf: isSeedOnlyIdleFork
        ? { initiator: "agent", senderThreadId: sourceThread.id }
        : null,
      ...(request.title === undefined ? {} : { title: request.title }),
      visibility: request.visibility,
    },
    {
      ...(options.creationOperation === undefined
        ? {}
        : { creationOperation: options.creationOperation }),
      forkSourceEnvironmentId: sourceEnvironment.id,
      ...(options.permissionInitiator === undefined
        ? {}
        : { permissionInitiator: options.permissionInitiator }),
      ...(isSeedOnlyIdleFork ? { providerInput: [] } : {}),
    },
  );
}
