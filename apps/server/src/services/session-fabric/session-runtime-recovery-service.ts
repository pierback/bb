import {
  getActiveSessionModelEpoch,
  getSessionExecutionBindingContext,
  getSessionThreadExecutionAuthority,
  recoverSessionExecutionBinding,
  SessionFabricPersistenceError,
  type SessionExecutionBindingContext,
} from "@bb/db";
import {
  contextCapsuleWorkspaceDigest,
  type ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type {
  HostDaemonOnlineRpcCommand,
  HostDaemonSessionRuntimeControlState,
} from "@bb/host-daemon-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { buildSessionRuntimeRecoveryCommand } from "../threads/thread-commands.js";
import { throwSessionFabricPersistenceApiError } from "./session-fabric-service.js";

type SessionRuntimeRecoveryDeps = LoggedWorkSessionDeps;

export type CompleteBindingContext = SessionExecutionBindingContext & {
  environment: NonNullable<SessionExecutionBindingContext["environment"]>;
  runtimeInstance: NonNullable<
    SessionExecutionBindingContext["runtimeInstance"]
  >;
  thread: NonNullable<SessionExecutionBindingContext["thread"]>;
};

function hasCompleteBindingTopology(
  context: SessionExecutionBindingContext,
): context is CompleteBindingContext {
  return Boolean(
    context.environment && context.runtimeInstance && context.thread,
  );
}

const RUNTIME_RECOVERY_CANDIDATE_ERROR_CODES = new Set([
  "runtime_incarnation_mismatch",
  "runtime_incarnation_unavailable",
  "unknown_thread_runtime",
]);

function persist<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
}

export function requireCompleteBindingContext(
  deps: Pick<AppDeps, "db">,
  bindingId: string,
): CompleteBindingContext {
  const context = persist(() =>
    getSessionExecutionBindingContext(deps.db, bindingId),
  );
  if (!context) {
    throw new ApiError(
      404,
      "binding_not_found",
      `Session Fabric binding not found: ${bindingId}`,
    );
  }
  if (!hasCompleteBindingTopology(context)) {
    throw new ApiError(
      409,
      "invalid_binding_topology",
      `Binding ${bindingId} has no controllable runtime topology`,
      false,
    );
  }
  return context;
}

export function sameSessionRuntimeIncarnation(
  control: HostDaemonSessionRuntimeControlState,
  context: CompleteBindingContext,
): boolean {
  const runtime = context.runtimeInstance;
  return (
    control.incarnation.bootNonce === runtime.bootNonce &&
    control.incarnation.connectorId === runtime.connectorId &&
    control.incarnation.endpointFingerprint === runtime.endpointFingerprint &&
    control.incarnation.processKey === runtime.processKey &&
    control.incarnation.providerId === runtime.providerId &&
    control.incarnation.runtimeInstanceId === runtime.id &&
    control.incarnation.startedAt === runtime.startedAt
  );
}

function isRuntimeRecoveryCandidateError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    RUNTIME_RECOVERY_CANDIDATE_ERROR_CODES.has(error.body.code)
  );
}

function runtimeRecoveryExecution(
  deps: Pick<AppDeps, "db">,
  context: CompleteBindingContext,
): ResolvedThreadExecutionOptions {
  const modelEpoch = getActiveSessionModelEpoch(deps.db, context.binding.id);
  if (!modelEpoch?.effectiveModel) {
    throw new ApiError(
      409,
      "invalid_model_epoch",
      `Binding ${context.binding.id} has no active execution epoch for recovery`,
      false,
    );
  }
  return {
    model: modelEpoch.effectiveModel.modelId,
    permissionMode: context.runtimeRecipe.permissionMode,
    reasoningLevel: modelEpoch.reasoningLevel,
    serviceTier: modelEpoch.serviceTier,
    source: "client/turn/start",
  };
}

function assertUnchangedRecoveryEvidence(args: {
  context: CompleteBindingContext;
  executionSafety: "handoff_restatement" | "standard";
  result: Awaited<
    ReturnType<
      typeof callHostRetryableOnlineRpc<
        Extract<HostDaemonOnlineRpcCommand, { type: "session.runtime.recover" }>
      >
    >
  >;
}): void {
  const { context, result } = args;
  const expectedWorkspace = contextCapsuleWorkspaceDigest(
    context.workspaceState,
  );
  const actualWorkspace = contextCapsuleWorkspaceDigest({
    ...result.inspection.workspaceState,
    hostId: context.workspaceState.hostId,
    id: context.workspaceState.id,
  });
  if (
    result.control.bindingId !== context.binding.id ||
    result.control.controlEpoch !== context.binding.controlEpoch ||
    result.control.environmentId !== context.environment.id ||
    result.control.executionSafety !== args.executionSafety ||
    result.control.mutationPolicy !== context.binding.mutationPolicy ||
    result.control.nativeCursor !== context.binding.nativeCursor ||
    result.control.ownership !== context.binding.ownership ||
    result.control.phase !== "idle" ||
    result.control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    result.control.threadId !== context.thread.id ||
    result.control.turnId !== null ||
    result.control.workspaceId !== context.workspaceState.rootPath ||
    !sameSessionRuntimeIncarnation(result.control, context) ||
    result.inspection.executionSafety !== args.executionSafety ||
    result.inspection.providerThreadId !==
      context.nativeConversation.nativeConversationId ||
    JSON.stringify(actualWorkspace) !== JSON.stringify(expectedWorkspace)
  ) {
    throw new ApiError(
      502,
      "invalid_runtime_recovery_evidence",
      `Host recovery evidence does not match binding ${context.binding.id}`,
      false,
    );
  }
}

export async function recoverBindingRuntime(
  deps: SessionRuntimeRecoveryDeps,
  context: CompleteBindingContext,
  executionSafety: "handoff_restatement" | "standard",
): Promise<CompleteBindingContext> {
  const {
    createdAt: _recipeCreatedAt,
    id: _recipeId,
    ...runtimeRecipe
  } = context.runtimeRecipe;
  const {
    hostId: _workspaceHostId,
    id: _workspaceId,
    ...workspaceState
  } = context.workspaceState;
  const command = await buildSessionRuntimeRecoveryCommand(deps, {
    bindingId: context.binding.id,
    environment: context.environment,
    execution: runtimeRecoveryExecution(deps, context),
    executionSafety,
    expectedBootNonce: context.runtimeInstance.bootNonce,
    expectedControlEpoch: context.binding.controlEpoch,
    expectedEndpointFingerprint: context.runtimeInstance.endpointFingerprint,
    expectedProviderThreadId: context.nativeConversation.nativeConversationId,
    expectedRuntimeInstanceId: context.runtimeInstance.id,
    expectedRuntimeRecipe: runtimeRecipe,
    expectedWorkspaceState: workspaceState,
    providerInstanceId: context.nativeConversation.providerInstanceId,
    thread: context.thread,
  });
  if (command.options.permissionMode !== context.runtimeRecipe.permissionMode) {
    throw new ApiError(
      409,
      "runtime_recovery_permission_conflict",
      `Host permission policy resolved ${command.options.permissionMode}, not the bound ${context.runtimeRecipe.permissionMode}`,
      false,
    );
  }
  const result = await callHostRetryableOnlineRpc(deps, {
    command,
    hostId: context.nativeConversation.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (
    result.control.controlEpoch === context.binding.controlEpoch &&
    sameSessionRuntimeIncarnation(result.control, context)
  ) {
    assertUnchangedRecoveryEvidence({ context, executionSafety, result });
    return context;
  }
  const recovered = persist(() =>
    recoverSessionExecutionBinding(deps.db, {
      bindingId: context.binding.id,
      control: result.control,
      expectedControlEpoch: context.binding.controlEpoch,
      expectedRuntimeInstanceId: context.runtimeInstance.id,
      inspection: result.inspection,
    }),
  );
  if (!hasCompleteBindingTopology(recovered)) {
    throw new ApiError(
      409,
      "invalid_binding_topology",
      `Recovered binding ${context.binding.id} lost its controllable topology`,
      false,
    );
  }
  return recovered;
}

export async function callBindingRpcWithRecovery<T>(args: {
  call: (context: CompleteBindingContext) => Promise<T>;
  context: CompleteBindingContext;
  deps: SessionRuntimeRecoveryDeps;
  executionSafety: "handoff_restatement" | "standard";
}): Promise<{ context: CompleteBindingContext; result: T }> {
  try {
    return { context: args.context, result: await args.call(args.context) };
  } catch (error) {
    if (!isRuntimeRecoveryCandidateError(error)) throw error;
    const context = await recoverBindingRuntime(
      args.deps,
      args.context,
      args.executionSafety,
    );
    return { context, result: await args.call(context) };
  }
}

export async function ensureSessionFabricThreadRuntimeReady(
  deps: SessionRuntimeRecoveryDeps,
  threadId: string,
): Promise<CompleteBindingContext | null> {
  const authority = persist(() =>
    getSessionThreadExecutionAuthority(deps.db, threadId),
  );
  if (!authority) return null;
  return recoverBindingRuntime(
    deps,
    requireCompleteBindingContext(deps, authority.bindingId),
    "standard",
  );
}
