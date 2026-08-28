import { createHash } from "node:crypto";
import {
  abortSessionHandoff,
  advanceSessionHandoff,
  authorizeSessionHandoffDestination,
  captureSessionHandoffWorkspaceSnapshot,
  confirmSessionHandoffUserReview,
  createSessionHandoffTransition,
  createSessionWorkspaceStateId,
  enableSessionHandoffDestinationMutation,
  fenceSessionHandoffSourceIngress,
  getEnvironment,
  getSessionHandoffAudit,
  getThread,
  listPendingInteractionsByThread,
  listQueuedThreadMessages,
  recordSessionWorkspaceState,
  retireSessionHandoffSource,
  sealSessionContextCapsule,
  SessionFabricPersistenceError,
  stageSessionHandoffDestination,
  swapSessionHandoffActiveBinding,
  verifySessionHandoffDestinationRestatement,
} from "@bb/db";
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  encodeClientTurnRequestIdAlphabetIndexes,
} from "@bb/domain";
import type {
  ContextCapsule,
  HandoffAuthorizationEvidence,
  HandoffTransition,
  PermissionMode,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type { HostDaemonSessionRuntimeControlState } from "@bb/host-daemon-contract";
import type {
  SessionFabricHandoffAbortResponse,
  SessionFabricHandoffActivateRequest,
  SessionFabricHandoffActivateResponse,
  SessionFabricHandoffAuditResponse,
  SessionFabricHandoffPrepareRequest,
  SessionFabricHandoffPrepareResponse,
} from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import { buildSessionHandoffStageCommand } from "../threads/thread-commands.js";
import { resolveExistingThreadPermissionMode } from "../threads/thread-execution-plan.js";
import {
  callBindingRpcWithRecovery,
  requireCompleteBindingContext,
  sameSessionRuntimeIncarnation as sameIncarnation,
  type CompleteBindingContext,
} from "./session-runtime-recovery-service.js";
import { buildSessionHandoffRestatementInput } from "./session-handoff-restatement.js";
import { throwSessionFabricPersistenceApiError } from "./session-fabric-service.js";

const HANDOFF_AUTHORIZATION_POLICY_VERSION = 1;
const HANDOFF_RESTATEMENT_TIMEOUT_MS = 15 * 60 * 1_000;

const PREPARED_OR_LATER_PHASES = new Set<HandoffTransition["phase"]>([
  "capsule_built",
  "user_reviewed",
  "billing_and_permission_authorized",
  "destination_staging_read_only",
  "destination_staged_read_only",
  "destination_restating",
  "destination_restated_and_verified",
  "active_binding_swapped",
  "destination_enabling",
  "destination_mutation_enabled",
  "source_retired_or_detached",
]);

function handoffDigestBytes(purpose: string, transitionId: string): Buffer {
  return createHash("sha256")
    .update(`session-fabric-${purpose}-v1\0${transitionId}`)
    .digest();
}

function destinationBindingIdForHandoff(transitionId: string): string {
  const suffix = [...handoffDigestBytes("destination-binding", transitionId)]
    .slice(0, 10)
    .map((byte) =>
      CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(
        byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length,
      ),
    )
    .join("");
  return `seb_${suffix}`;
}

function restatementRequestIdForHandoff(transitionId: string) {
  return encodeClientTurnRequestIdAlphabetIndexes({
    indexes: [...handoffDigestBytes("restatement-request", transitionId)]
      .slice(0, 10)
      .map((byte) => byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length),
  });
}

const ABORTABLE_PHASES = new Set<HandoffTransition["phase"]>([
  "requested",
  "target_preflight",
  "source_ingress_frozen",
  "source_quiescing",
  "source_reconciling",
  "workspace_snapshot_captured",
  "capsule_built",
  "user_reviewed",
  "billing_and_permission_authorized",
  "destination_staging_read_only",
  "destination_staged_read_only",
  "destination_restating",
  "destination_restated_and_verified",
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

function requireDestinationCapability(
  providerRegistry: ProviderRegistryService,
  providerId: string,
) {
  const provider = providerRegistry.get(providerId);
  if (provider === null) {
    throw new ApiError(
      409,
      "handoff_destination_unsupported",
      `Provider ${providerId} has no verified isolated handoff restatement path`,
      false,
    );
  }
  if (
    provider.serverCapabilities.handoffRestatementSafety !== "isolated_no_tools"
  ) {
    throw new ApiError(
      409,
      "handoff_destination_unsupported",
      `Provider ${providerId} cannot prove isolated no-tools restatement`,
      false,
    );
  }
  return provider;
}

function requireSupportedPermissionMode(
  providerRegistry: ProviderRegistryService,
  providerId: string,
  permissionMode: PermissionMode,
): void {
  const provider = requireDestinationCapability(providerRegistry, providerId);
  if (!provider.info.capabilities.permissionModes.includes(permissionMode)) {
    throw new ApiError(
      409,
      "handoff_permission_mode_unsupported",
      `Provider ${providerId} does not support permission mode ${permissionMode}`,
      false,
    );
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function handoffRequestHash(
  sourceBindingId: string,
  request: SessionFabricHandoffPrepareRequest,
): string {
  const payload = JSON.stringify(
    canonicalJson({
      capsule: request.capsule,
      destinationEnvironmentId: request.destinationEnvironmentId,
      destinationHostId: request.destinationHostId,
      destinationModel: request.destinationModel,
      destinationProviderInstanceId: request.destinationProviderInstanceId,
      destinationReasoningLevel: request.destinationReasoningLevel,
      destinationServiceTier: request.destinationServiceTier,
      destinationThreadId: request.destinationThreadId,
      destinationWorkspaceDisposition: request.destinationWorkspaceDisposition,
      sourceBindingId,
      version: "session-handoff-prepare-v2",
    }),
  );
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function assertSourceFenceControl(args: {
  context: CompleteBindingContext;
  control: HostDaemonSessionRuntimeControlState;
  expectedControlEpoch: number;
  transitionId: string;
}): void {
  const { context, control } = args;
  if (
    control.bindingId !== context.binding.id ||
    control.controlEpoch !== args.expectedControlEpoch + 1 ||
    control.environmentId !== context.environment.id ||
    control.executionSafety !== "standard" ||
    control.handoffCheckpoint !== "source_fenced" ||
    control.handoffRole !== "source" ||
    control.handoffTransitionId !== args.transitionId ||
    control.mutationPolicy !== "staged_read_only" ||
    control.nativeCursor !== context.binding.nativeCursor ||
    control.ownership !== context.binding.ownership ||
    control.phase !== "idle" ||
    control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    control.threadId !== context.thread.id ||
    control.turnId !== null ||
    control.workspaceId !== context.workspaceState.rootPath ||
    !sameIncarnation(control, context)
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_source_fence_evidence",
      "Host source-fence evidence does not match the exact active runtime",
      false,
    );
  }
}

function assertSourceRestoreControl(args: {
  context: CompleteBindingContext;
  control: HostDaemonSessionRuntimeControlState;
  expectedControlEpoch: number;
}): void {
  const { context, control } = args;
  if (
    control.bindingId !== context.binding.id ||
    control.controlEpoch !== args.expectedControlEpoch + 1 ||
    control.environmentId !== context.environment.id ||
    control.executionSafety !== "standard" ||
    control.handoffCheckpoint !== "not_applicable" ||
    control.handoffRole !== null ||
    control.handoffTransitionId !== null ||
    control.mutationPolicy !== "enabled" ||
    control.nativeCursor !== context.binding.nativeCursor ||
    control.ownership !== context.binding.ownership ||
    control.phase !== "idle" ||
    control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    control.threadId !== context.thread.id ||
    control.turnId !== null ||
    control.workspaceId !== context.workspaceState.rootPath ||
    !sameIncarnation(control, context)
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_source_restore_evidence",
      "Host source-restore evidence does not match the fenced runtime",
      false,
    );
  }
}

function assertSourceSettlementControl(args: {
  context: CompleteBindingContext;
  control: HostDaemonSessionRuntimeControlState;
  transitionId: string;
}): void {
  const { context, control } = args;
  if (
    control.bindingId !== context.binding.id ||
    control.controlEpoch !== context.binding.controlEpoch ||
    control.environmentId !== context.environment.id ||
    control.executionSafety !== "standard" ||
    control.handoffCheckpoint !== "source_fenced" ||
    control.handoffRole !== "source" ||
    control.handoffTransitionId !== args.transitionId ||
    control.mutationPolicy !== "staged_read_only" ||
    control.nativeCursor !== context.binding.nativeCursor ||
    control.ownership !== context.binding.ownership ||
    control.phase !== "idle" ||
    control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    control.threadId !== context.thread.id ||
    control.turnId !== null ||
    control.workspaceId !== context.workspaceState.rootPath ||
    !sameIncarnation(control, context)
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_source_settlement_control",
      "Host settlement evidence does not match the exact fenced source runtime",
      false,
    );
  }
}

function assertDestinationControl(args: {
  checkpoint: "destination_staged" | "destination_restated";
  context: CompleteBindingContext;
  control: HostDaemonSessionRuntimeControlState;
  executionSafety: "standard" | "handoff_restatement";
  expectedControlEpoch: number;
  mutationPolicy: "enabled" | "staged_read_only";
  transitionId: string;
}): void {
  const { context, control } = args;
  if (
    control.bindingId !== context.binding.id ||
    control.controlEpoch !== args.expectedControlEpoch + 1 ||
    control.environmentId !== context.environment.id ||
    control.executionSafety !== args.executionSafety ||
    control.handoffCheckpoint !== args.checkpoint ||
    control.handoffRole !== "destination" ||
    control.handoffTransitionId !== args.transitionId ||
    control.mutationPolicy !== args.mutationPolicy ||
    control.nativeCursor !== context.binding.nativeCursor ||
    control.ownership !== context.binding.ownership ||
    control.phase !== "idle" ||
    control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    control.threadId !== context.thread.id ||
    control.turnId !== null ||
    control.workspaceId !== context.workspaceState.rootPath ||
    !sameIncarnation(control, context)
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_destination_control_evidence",
      "Host destination control evidence does not match the staged runtime",
      false,
    );
  }
}

function assertHandoffTerminalControl(args: {
  context: CompleteBindingContext;
  control: HostDaemonSessionRuntimeControlState;
  expectedControlEpoch: number;
  executionSafety: "handoff_restatement" | "standard";
  role: "destination" | "source";
  transitionId: string;
}): void {
  const { context, control } = args;
  if (
    control.bindingId !== context.binding.id ||
    control.controlEpoch !== args.expectedControlEpoch + 1 ||
    control.environmentId !== context.environment.id ||
    control.executionSafety !== args.executionSafety ||
    control.handoffRole !== args.role ||
    control.handoffTransitionId !== args.transitionId ||
    control.mutationPolicy !== "staged_read_only" ||
    control.nativeCursor !== context.binding.nativeCursor ||
    control.ownership !== context.binding.ownership ||
    control.phase !== "terminal" ||
    control.providerInstanceId !==
      context.nativeConversation.providerInstanceId ||
    control.threadId !== context.thread.id ||
    control.turnId !== null ||
    control.workspaceId !== context.workspaceState.rootPath ||
    (args.role === "source" && control.handoffCheckpoint !== "source_fenced") ||
    (args.role === "destination" &&
      control.handoffCheckpoint !== "destination_staged" &&
      control.handoffCheckpoint !== "destination_restated") ||
    !sameIncarnation(control, context)
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_terminal_evidence",
      `Host terminal evidence does not match the exact ${args.role} binding`,
      false,
    );
  }
}

async function discardPersistedDestination(
  deps: AppDeps,
  transition: HandoffTransition,
): Promise<{
  bindingId: string;
  expectedControlEpoch: number;
  terminalControlEpoch: number;
}> {
  if (!transition.destinationBindingId) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Handoff has no persisted destination to discard",
      false,
    );
  }
  let destination = requireCompleteBindingContext(
    deps,
    transition.destinationBindingId,
  );
  const rpc = await callBindingRpcWithRecovery({
    call: (context) =>
      callHostRetryableOnlineRpc(deps, {
        command: {
          type: "session.handoff.discard_destination",
          bindingId: context.binding.id,
          bootNonce: context.runtimeInstance.bootNonce,
          endpointFingerprint: context.runtimeInstance.endpointFingerprint,
          environmentId: context.environment.id,
          evidenceMode: "exact",
          expectedControlEpoch: context.binding.controlEpoch,
          runtimeInstanceId: context.runtimeInstance.id,
          threadId: context.thread.id,
          transitionId: transition.id,
        },
        hostId: context.nativeConversation.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    context: destination,
    deps,
    executionSafety: "handoff_restatement",
  });
  destination = rpc.context;
  const expectedControlEpoch = destination.binding.controlEpoch;
  assertHandoffTerminalControl({
    context: destination,
    control: rpc.result,
    expectedControlEpoch,
    executionSafety: "handoff_restatement",
    role: "destination",
    transitionId: transition.id,
  });
  return {
    bindingId: destination.binding.id,
    expectedControlEpoch,
    terminalControlEpoch: rpc.result.controlEpoch,
  };
}

async function discardUnpersistedDestination(
  deps: AppDeps,
  transition: HandoffTransition,
): Promise<void> {
  const bindingId = destinationBindingIdForHandoff(transition.id);
  try {
    const control = await callHostRetryableOnlineRpc(deps, {
      command: {
        type: "session.handoff.discard_destination",
        bindingId,
        environmentId: transition.destinationEnvironmentId,
        evidenceMode: "transition",
        threadId: transition.destinationThreadId,
        transitionId: transition.id,
      },
      hostId: transition.destinationHostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (
      control.bindingId !== bindingId ||
      control.controlEpoch < 1 ||
      control.environmentId !== transition.destinationEnvironmentId ||
      control.executionSafety !== "handoff_restatement" ||
      control.handoffRole !== "destination" ||
      control.handoffTransitionId !== transition.id ||
      control.mutationPolicy !== "staged_read_only" ||
      control.phase !== "terminal" ||
      control.providerInstanceId !== transition.destinationProviderInstanceId ||
      control.threadId !== transition.destinationThreadId ||
      control.turnId !== null
    ) {
      throw new ApiError(
        502,
        "invalid_handoff_terminal_evidence",
        "Host did not return the transition-scoped destination tombstone",
        false,
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "binding_not_hosted") {
      return;
    }
    throw error;
  }
}

async function retireHandoffSourceRuntime(
  deps: AppDeps,
  transition: HandoffTransition,
): Promise<{
  expectedControlEpoch: number;
  terminalControlEpoch: number;
}> {
  let source = requireCompleteBindingContext(deps, transition.sourceBindingId);
  const rpc = await callBindingRpcWithRecovery({
    call: (context) =>
      callHostRetryableOnlineRpc(deps, {
        command: {
          type: "session.handoff.retire_source",
          bindingId: context.binding.id,
          bootNonce: context.runtimeInstance.bootNonce,
          endpointFingerprint: context.runtimeInstance.endpointFingerprint,
          environmentId: context.environment.id,
          expectedControlEpoch: context.binding.controlEpoch,
          runtimeInstanceId: context.runtimeInstance.id,
          threadId: context.thread.id,
          transitionId: transition.id,
        },
        hostId: context.nativeConversation.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    context: source,
    deps,
    executionSafety: "standard",
  });
  source = rpc.context;
  const expectedControlEpoch = source.binding.controlEpoch;
  assertHandoffTerminalControl({
    context: source,
    control: rpc.result,
    expectedControlEpoch,
    executionSafety: "standard",
    role: "source",
    transitionId: transition.id,
  });
  return {
    expectedControlEpoch,
    terminalControlEpoch: rpc.result.controlEpoch,
  };
}

function getHandoffAuditOrThrow(
  deps: Pick<AppDeps, "db">,
  transitionId: string,
) {
  const audit = getSessionHandoffAudit(deps.db, transitionId);
  if (!audit) {
    throw new ApiError(
      404,
      "handoff_not_found",
      `Session Fabric handoff not found: ${transitionId}`,
    );
  }
  return audit;
}

function toPrepareResponse(
  deps: Pick<AppDeps, "db">,
  transitionId: string,
): SessionFabricHandoffPrepareResponse {
  const audit = getHandoffAuditOrThrow(deps, transitionId);
  if (!audit.capsule) {
    throw new ApiError(
      409,
      "handoff_capsule_unavailable",
      `Handoff ${transitionId} has no sealed capsule`,
      false,
    );
  }
  return { capsule: audit.capsule.capsule, transition: audit.transition };
}

async function recordExpectedDestinationWorkspace(
  deps: AppDeps,
  transition: HandoffTransition,
  sourceWorkspaceStateId: string,
): Promise<string> {
  if (transition.destinationWorkspaceDisposition === "source_worktree") {
    return sourceWorkspaceStateId;
  }

  const destinationEnvironment = getEnvironment(
    deps.db,
    transition.destinationEnvironmentId,
  );
  if (!destinationEnvironment) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Reserved destination environment is no longer available",
      false,
    );
  }
  const target = requireWorkspaceCommandTarget(destinationEnvironment);
  if (target.hostId !== transition.destinationHostId) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Reserved destination environment moved to a different execution host",
      false,
    );
  }

  const workspaceState = await callHostRetryableOnlineRpc(deps, {
    command: {
      type: "session.handoff.inspect_destination_workspace",
      environmentId: target.environmentId,
      workspaceContext: target.workspaceContext,
    },
    hostId: target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return persist(
    () =>
      recordSessionWorkspaceState(deps.db, {
        ...workspaceState,
        hostId: target.hostId,
        id: createSessionWorkspaceStateId(),
      }).id,
  );
}

async function reconcileHandoffSource(
  deps: AppDeps,
  transition: HandoffTransition,
): Promise<HandoffTransition> {
  let source = requireCompleteBindingContext(deps, transition.sourceBindingId);
  const rpc = await callBindingRpcWithRecovery({
    call: (context) =>
      callHostRetryableOnlineRpc(deps, {
        command: {
          type: "session.handoff.inspect_source",
          bindingId: context.binding.id,
          bootNonce: context.runtimeInstance.bootNonce,
          endpointFingerprint: context.runtimeInstance.endpointFingerprint,
          environmentId: context.environment.id,
          expectedControlEpoch: context.binding.controlEpoch,
          runtimeInstanceId: context.runtimeInstance.id,
          threadId: context.thread.id,
          transitionId: transition.id,
        },
        hostId: context.nativeConversation.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    context: source,
    deps,
    executionSafety: "standard",
  });
  source = rpc.context;
  const inspection = rpc.result;
  assertSourceSettlementControl({
    context: source,
    control: inspection.control,
    transitionId: transition.id,
  });
  const runtimeInspection = inspection.inspection;
  if (
    runtimeInspection.environmentId !== source.environment.id ||
    runtimeInspection.executionSafety !== "standard" ||
    runtimeInspection.incarnation.bootNonce !==
      source.runtimeInstance.bootNonce ||
    runtimeInspection.incarnation.connectorId !==
      source.runtimeInstance.connectorId ||
    runtimeInspection.incarnation.endpointFingerprint !==
      source.runtimeInstance.endpointFingerprint ||
    runtimeInspection.incarnation.processKey !==
      source.runtimeInstance.processKey ||
    runtimeInspection.incarnation.providerId !==
      source.runtimeInstance.providerId ||
    runtimeInspection.incarnation.runtimeInstanceId !==
      source.runtimeInstance.id ||
    runtimeInspection.incarnation.startedAt !==
      source.runtimeInstance.startedAt ||
    runtimeInspection.ownership !== source.binding.ownership ||
    runtimeInspection.phase !== "idle" ||
    runtimeInspection.providerId !== source.nativeConversation.providerId ||
    runtimeInspection.providerInstanceId !==
      source.nativeConversation.providerInstanceId ||
    runtimeInspection.providerThreadId !==
      source.nativeConversation.nativeConversationId ||
    runtimeInspection.threadId !== source.thread.id ||
    runtimeInspection.turnId !== null ||
    runtimeInspection.workspaceState.rootPath !==
      source.workspaceState.rootPath ||
    runtimeInspection.workspaceState.worktreeId !==
      source.workspaceState.worktreeId ||
    runtimeInspection.workspaceState.externalSideEffectStatus !==
      inspection.settlement.externalSideEffectStatus
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_source_inspection",
      "Host reconciliation evidence does not match the fenced source runtime",
      false,
    );
  }

  const workspace = persist(() =>
    recordSessionWorkspaceState(deps.db, {
      ...runtimeInspection.workspaceState,
      hostId: source.nativeConversation.hostId,
      id: createSessionWorkspaceStateId(),
    }),
  );
  const activeBackgroundResourceCount = workspace.backgroundResources.filter(
    (resource) => resource.status === "active",
  ).length;
  const unknownBackgroundResourceCount = workspace.backgroundResources.filter(
    (resource) => resource.status === "unknown",
  ).length;
  const unresolvedInteractionCount = listPendingInteractionsByThread(deps.db, {
    limit: 10_000,
    statuses: ["pending", "resolving"],
    threadId: source.thread.id,
  }).length;
  const acceptedQueueCount = listQueuedThreadMessages(
    deps.db,
    source.thread.id,
  ).length;
  const expectedWorkspaceStateId = await recordExpectedDestinationWorkspace(
    deps,
    transition,
    workspace.id,
  );

  return persist(() =>
    captureSessionHandoffWorkspaceSnapshot(deps.db, {
      expectedWorkspaceStateId,
      settlement: {
        acceptedQueueCount,
        ...inspection.settlement,
        activeBackgroundResourceCount:
          inspection.settlement.activeBackgroundResourceCount +
          activeBackgroundResourceCount,
        unknownBackgroundResourceCount:
          inspection.settlement.unknownBackgroundResourceCount +
          unknownBackgroundResourceCount,
        unresolvedInteractionCount,
      },
      sourceWorkspaceStateId: workspace.id,
      transitionId: transition.id,
    }),
  );
}

export async function prepareSessionFabricHandoff(
  deps: AppDeps,
  sourceBindingId: string,
  request: SessionFabricHandoffPrepareRequest,
): Promise<SessionFabricHandoffPrepareResponse> {
  requireDestinationCapability(
    deps.providerRegistry,
    request.destinationModel.providerId,
  );
  let transition = persist(() =>
    createSessionHandoffTransition(deps.db, {
      destinationEnvironmentId: request.destinationEnvironmentId,
      destinationHostId: request.destinationHostId,
      destinationModel: request.destinationModel,
      destinationProviderInstanceId: request.destinationProviderInstanceId,
      destinationReasoningLevel: request.destinationReasoningLevel,
      destinationServiceTier: request.destinationServiceTier,
      destinationThreadId: request.destinationThreadId,
      destinationWorkspaceDisposition: request.destinationWorkspaceDisposition,
      idempotencyKey: request.idempotencyKey,
      requestHash: handoffRequestHash(sourceBindingId, request),
      sourceBindingId,
    }),
  );

  for (let step = 0; step < 8; step += 1) {
    if (PREPARED_OR_LATER_PHASES.has(transition.phase)) {
      return toPrepareResponse(deps, transition.id);
    }
    if (transition.phase === "aborted") {
      throw new ApiError(
        409,
        "handoff_aborted",
        `Handoff ${transition.id} was aborted`,
        false,
      );
    }
    if (transition.phase === "requested") {
      transition = persist(() =>
        advanceSessionHandoff(deps.db, {
          event: "start_target_preflight",
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "target_preflight") {
      let source = requireCompleteBindingContext(
        deps,
        transition.sourceBindingId,
      );
      if (
        source.binding.mutationPolicy !== "enabled" ||
        source.binding.phase !== "idle" ||
        source.binding.providerTurnId !== null ||
        source.thread.status !== "idle"
      ) {
        throw new ApiError(
          409,
          "handoff_source_not_idle",
          "Cross-provider handoff requires the active source to be idle and mutation-enabled",
          false,
        );
      }
      const rpc = await callBindingRpcWithRecovery({
        call: (context) =>
          callHostRetryableOnlineRpc(deps, {
            command: {
              type: "session.handoff.fence_source",
              bindingId: context.binding.id,
              bootNonce: context.runtimeInstance.bootNonce,
              endpointFingerprint: context.runtimeInstance.endpointFingerprint,
              environmentId: context.environment.id,
              expectedControlEpoch: context.binding.controlEpoch,
              runtimeInstanceId: context.runtimeInstance.id,
              threadId: context.thread.id,
              transitionId: transition.id,
            },
            hostId: context.nativeConversation.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
          }),
        context: source,
        deps,
        executionSafety: "standard",
      });
      source = rpc.context;
      const control = rpc.result;
      assertSourceFenceControl({
        context: source,
        control,
        expectedControlEpoch: source.binding.controlEpoch,
        transitionId: transition.id,
      });
      transition = persist(() =>
        fenceSessionHandoffSourceIngress(deps.db, {
          expectedControlEpoch: source.binding.controlEpoch,
          fencedControlEpoch: control.controlEpoch,
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "source_ingress_frozen") {
      transition = persist(() =>
        advanceSessionHandoff(deps.db, {
          event: "begin_source_quiesce",
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "source_quiescing") {
      transition = persist(() =>
        advanceSessionHandoff(deps.db, {
          event: "begin_source_reconcile",
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "source_reconciling") {
      transition = await reconcileHandoffSource(deps, transition);
      continue;
    }
    if (transition.phase === "workspace_snapshot_captured") {
      persist(() =>
        sealSessionContextCapsule(deps.db, {
          capsule: request.capsule,
          transitionId: transition.id,
        }),
      );
      return toPrepareResponse(deps, transition.id);
    }
    break;
  }
  throw new ApiError(
    500,
    "handoff_prepare_did_not_converge",
    `Handoff ${transition.id} did not reach a prepared phase`,
  );
}

function assertActivationEvidenceMatches(
  deps: Pick<AppDeps, "db">,
  transition: HandoffTransition,
  request: SessionFabricHandoffActivateRequest,
  authorization: DestinationAuthorization,
): ContextCapsule {
  const audit = getHandoffAuditOrThrow(deps, transition.id);
  const capsule = audit.capsule?.capsule;
  if (!capsule || capsule.contentHash !== request.capsuleContentHash) {
    throw new ApiError(
      409,
      "capsule_hash_mismatch",
      "Activation must name the exact sealed context capsule",
      false,
    );
  }
  if (
    audit.review &&
    (audit.review.capsuleContentHash !== request.capsuleContentHash ||
      audit.review.reviewerId !== request.reviewerId)
  ) {
    throw new ApiError(
      409,
      "handoff_review_conflict",
      "Activation review evidence differs from the durable handoff review",
      false,
    );
  }
  if (
    audit.authorization &&
    (audit.authorization.billingAuthorizationId !==
      authorization.billingAuthorizationId ||
      audit.authorization.billingRouteId !== authorization.billingRouteId ||
      audit.authorization.capsuleContentHash !== request.capsuleContentHash ||
      audit.authorization.permissionMode !== authorization.permissionMode ||
      audit.authorization.policyVersion !== authorization.policyVersion ||
      audit.authorization.destinationProviderInstanceId !==
        authorization.destinationProviderInstanceId ||
      audit.authorization.destinationModel.providerId !==
        authorization.destinationModel.providerId ||
      audit.authorization.destinationModel.modelId !==
        authorization.destinationModel.modelId)
  ) {
    throw new ApiError(
      409,
      "handoff_authorization_conflict",
      "Activation authorization differs from the durable destination authorization",
      false,
    );
  }
  return capsule;
}

type DestinationAuthorization = Omit<
  HandoffAuthorizationEvidence,
  "authorizedAt" | "capsuleContentHash" | "id" | "transitionId"
>;

function deriveDestinationAuthorization(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  transition: HandoffTransition,
): DestinationAuthorization {
  const permissionMode = resolveExistingThreadPermissionMode(
    deps,
    transition.destinationThreadId,
  );
  requireSupportedPermissionMode(
    deps.providerRegistry,
    transition.destinationProviderId,
    permissionMode,
  );
  return {
    billingAuthorizationId: null,
    billingRouteId: `current-provider-instance:${transition.destinationProviderInstanceId}`,
    destinationModel: transition.destinationModel,
    destinationProviderInstanceId: transition.destinationProviderInstanceId,
    permissionMode,
    policyVersion: HANDOFF_AUTHORIZATION_POLICY_VERSION,
  };
}

function destinationExecution(
  transition: HandoffTransition,
  permissionMode: PermissionMode,
): ResolvedThreadExecutionOptions {
  return {
    model: transition.destinationModel.modelId,
    permissionMode,
    reasoningLevel: transition.destinationReasoningLevel,
    serviceTier: transition.destinationServiceTier,
    source: "client/thread/start",
  };
}

async function stageDestination(
  deps: AppDeps,
  transition: HandoffTransition,
  capsule: ContextCapsule,
  permissionMode: PermissionMode,
): Promise<HandoffTransition> {
  const destinationBindingId = destinationBindingIdForHandoff(transition.id);
  const destinationThread = getThread(deps.db, transition.destinationThreadId);
  const destinationEnvironment = getEnvironment(
    deps.db,
    transition.destinationEnvironmentId,
  );
  if (!destinationThread || !destinationEnvironment) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Reserved destination thread or environment is no longer available",
      false,
    );
  }
  const {
    hostId: _expectedWorkspaceHostId,
    id: _expectedWorkspaceId,
    ...expectedWorkspaceState
  } = capsule.expectedWorkspaceState;
  const command = await buildSessionHandoffStageCommand(deps, {
    bindingId: destinationBindingId,
    environment: destinationEnvironment,
    expectedWorkspaceState,
    execution: destinationExecution(transition, permissionMode),
    providerInstanceId: transition.destinationProviderInstanceId,
    thread: destinationThread,
    transitionId: transition.id,
  });
  if (command.options.permissionMode !== permissionMode) {
    throw new ApiError(
      409,
      "handoff_permission_ceiling_conflict",
      `Host permission policy resolved ${command.options.permissionMode}, not the server-authorized ${permissionMode}`,
      false,
    );
  }

  if (transition.phase === "billing_and_permission_authorized") {
    persist(() =>
      advanceSessionHandoff(deps.db, {
        event: "begin_destination_stage",
        transitionId: transition.id,
      }),
    );
  } else if (transition.phase !== "destination_staging_read_only") {
    throw new ApiError(
      409,
      "handoff_illegal_transition",
      `Destination stage cannot be replayed from ${transition.phase}`,
      false,
    );
  }
  const result = await callHostRetryableOnlineRpc(deps, {
    command,
    hostId: transition.destinationHostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (
    result.control.executionSafety !== "handoff_restatement" ||
    result.control.handoffCheckpoint !== "destination_staged" ||
    result.control.handoffRole !== "destination" ||
    result.control.handoffTransitionId !== transition.id ||
    result.inspection.executionSafety !== "handoff_restatement"
  ) {
    throw new ApiError(
      502,
      "invalid_handoff_destination_stage_evidence",
      "Host did not prove an isolated staged destination",
      false,
    );
  }
  return persist(() =>
    stageSessionHandoffDestination(deps.db, {
      control: {
        ...result.control,
        executionSafety: "handoff_restatement",
        handoffCheckpoint: "destination_staged",
        handoffRole: "destination",
        handoffTransitionId: transition.id,
      },
      destinationBindingId,
      effectiveAccount: null,
      effectiveModel: transition.destinationModel,
      inspection: {
        ...result.inspection,
        executionSafety: "handoff_restatement",
        workspaceState: {
          ...result.inspection.workspaceState,
          externalSideEffectStatus:
            capsule.expectedWorkspaceState.externalSideEffectStatus,
        },
      },
      transitionId: transition.id,
    }),
  );
}

async function restateDestination(
  deps: AppDeps,
  transition: HandoffTransition,
  capsule: ContextCapsule,
): Promise<{ transition: HandoffTransition; workspaceStateId: string }> {
  if (!transition.destinationBindingId) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Handoff has no staged destination binding",
      false,
    );
  }
  let destination = requireCompleteBindingContext(
    deps,
    transition.destinationBindingId,
  );
  if (transition.phase === "destination_staged_read_only") {
    persist(() =>
      advanceSessionHandoff(deps.db, {
        event: "begin_destination_restatement",
        transitionId: transition.id,
      }),
    );
  } else if (transition.phase !== "destination_restating") {
    throw new ApiError(
      409,
      "handoff_illegal_transition",
      `Destination restatement cannot be replayed from ${transition.phase}`,
      false,
    );
  }
  const rpc = await callBindingRpcWithRecovery({
    call: (context) =>
      callHostRetryableOnlineRpc(deps, {
        command: {
          type: "session.handoff.restate_destination",
          bindingId: context.binding.id,
          bootNonce: context.runtimeInstance.bootNonce,
          capsule,
          endpointFingerprint: context.runtimeInstance.endpointFingerprint,
          environmentId: context.environment.id,
          expectedControlEpoch: context.binding.controlEpoch,
          input: buildSessionHandoffRestatementInput(capsule),
          requestId: restatementRequestIdForHandoff(transition.id),
          runtimeInstanceId: context.runtimeInstance.id,
          threadId: context.thread.id,
          timeoutMs: HANDOFF_RESTATEMENT_TIMEOUT_MS,
          transitionId: transition.id,
        },
        hostId: transition.destinationHostId,
        timeoutMs: HANDOFF_RESTATEMENT_TIMEOUT_MS,
      }),
    context: destination,
    deps,
    executionSafety: "handoff_restatement",
  });
  destination = rpc.context;
  const result = rpc.result;
  const expectedControlEpoch = destination.binding.controlEpoch;
  assertDestinationControl({
    checkpoint: "destination_restated",
    context: destination,
    control: result.control,
    executionSafety: "handoff_restatement",
    expectedControlEpoch,
    mutationPolicy: "staged_read_only",
    transitionId: transition.id,
  });
  const workspace = persist(() =>
    recordSessionWorkspaceState(deps.db, {
      ...result.workspaceState,
      externalSideEffectStatus:
        capsule.expectedWorkspaceState.externalSideEffectStatus,
      hostId: transition.destinationHostId,
      id: createSessionWorkspaceStateId(),
    }),
  );
  const verified = persist(() =>
    verifySessionHandoffDestinationRestatement(deps.db, {
      expectedControlEpoch,
      observedWorkspaceStateId: workspace.id,
      restatedControlEpoch: result.control.controlEpoch,
      restatement: result.restatement,
      transitionId: transition.id,
    }),
  );
  return { transition: verified, workspaceStateId: workspace.id };
}

async function enableDestination(
  deps: AppDeps,
  transition: HandoffTransition,
): Promise<HandoffTransition> {
  if (!transition.destinationBindingId) {
    throw new ApiError(
      409,
      "invalid_handoff_topology",
      "Handoff has no destination binding to enable",
      false,
    );
  }
  let destination = requireCompleteBindingContext(
    deps,
    transition.destinationBindingId,
  );
  if (transition.phase === "active_binding_swapped") {
    persist(() =>
      advanceSessionHandoff(deps.db, {
        event: "begin_destination_enablement",
        transitionId: transition.id,
      }),
    );
  } else if (transition.phase !== "destination_enabling") {
    throw new ApiError(
      409,
      "handoff_illegal_transition",
      `Destination enablement cannot be replayed from ${transition.phase}`,
      false,
    );
  }
  const rpc = await callBindingRpcWithRecovery({
    call: (context) =>
      callHostRetryableOnlineRpc(deps, {
        command: {
          type: "session.handoff.enable_destination",
          bindingId: context.binding.id,
          bootNonce: context.runtimeInstance.bootNonce,
          endpointFingerprint: context.runtimeInstance.endpointFingerprint,
          environmentId: context.environment.id,
          expectedControlEpoch: context.binding.controlEpoch,
          runtimeInstanceId: context.runtimeInstance.id,
          threadId: context.thread.id,
          transitionId: transition.id,
        },
        hostId: transition.destinationHostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    context: destination,
    deps,
    executionSafety: "handoff_restatement",
  });
  destination = rpc.context;
  const result = rpc.result;
  const expectedControlEpoch = destination.binding.controlEpoch;
  if (result.acceptance !== "accepted" || !result.control) {
    throw new ApiError(
      502,
      result.acceptance === "outcome_unknown"
        ? "handoff_destination_enablement_outcome_unknown"
        : "handoff_destination_enablement_rejected",
      result.diagnostic ?? "Destination provider did not accept enablement",
      false,
    );
  }
  assertDestinationControl({
    checkpoint: "destination_restated",
    context: destination,
    control: result.control,
    executionSafety: "standard",
    expectedControlEpoch,
    mutationPolicy: "enabled",
    transitionId: transition.id,
  });
  const enabledControlEpoch = result.control.controlEpoch;
  return persist(() =>
    enableSessionHandoffDestinationMutation(deps.db, {
      enabledControlEpoch,
      expectedControlEpoch,
      observedWorkspaceStateId: destination.workspaceState.id,
      transitionId: transition.id,
    }),
  );
}

export async function activateSessionFabricHandoff(
  deps: AppDeps,
  transitionId: string,
  request: SessionFabricHandoffActivateRequest,
): Promise<SessionFabricHandoffActivateResponse> {
  let transition = getHandoffAuditOrThrow(deps, transitionId).transition;
  const authorization = deriveDestinationAuthorization(deps, transition);
  const capsule = assertActivationEvidenceMatches(
    deps,
    transition,
    request,
    authorization,
  );
  if (transition.phase === "aborted") {
    throw new ApiError(
      409,
      "handoff_aborted",
      `Handoff ${transition.id} was aborted`,
      false,
    );
  }

  for (let step = 0; step < 10; step += 1) {
    if (transition.phase === "source_retired_or_detached") {
      if (!transition.destinationBindingId) {
        throw new ApiError(
          500,
          "invalid_handoff_topology",
          "Completed handoff has no destination binding",
        );
      }
      return {
        destinationBindingId: transition.destinationBindingId,
        transition,
      };
    }
    if (transition.phase === "capsule_built") {
      transition = persist(() =>
        confirmSessionHandoffUserReview(deps.db, {
          capsuleContentHash: request.capsuleContentHash,
          reviewerId: request.reviewerId,
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "user_reviewed") {
      persist(() =>
        authorizeSessionHandoffDestination(deps.db, {
          ...authorization,
          transitionId: transition.id,
        }),
      );
      transition = getHandoffAuditOrThrow(deps, transition.id).transition;
      continue;
    }
    if (
      transition.phase === "billing_and_permission_authorized" ||
      transition.phase === "destination_staging_read_only"
    ) {
      transition = await stageDestination(
        deps,
        transition,
        capsule,
        authorization.permissionMode,
      );
      continue;
    }
    if (
      transition.phase === "destination_staged_read_only" ||
      transition.phase === "destination_restating"
    ) {
      const restated = await restateDestination(deps, transition, capsule);
      transition = persist(() =>
        swapSessionHandoffActiveBinding(deps.db, {
          observedWorkspaceStateId: restated.workspaceStateId,
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (transition.phase === "destination_restated_and_verified") {
      const audit = getHandoffAuditOrThrow(deps, transition.id);
      if (!audit.restatement) {
        throw new ApiError(
          500,
          "invalid_handoff_topology",
          "Verified handoff has no restatement evidence",
        );
      }
      const observedWorkspaceStateId =
        audit.restatement.observedWorkspaceStateId;
      transition = persist(() =>
        swapSessionHandoffActiveBinding(deps.db, {
          observedWorkspaceStateId,
          transitionId: transition.id,
        }),
      );
      continue;
    }
    if (
      transition.phase === "active_binding_swapped" ||
      transition.phase === "destination_enabling"
    ) {
      transition = await enableDestination(deps, transition);
      continue;
    }
    if (transition.phase === "destination_mutation_enabled") {
      const sourceRetirement = await retireHandoffSourceRuntime(
        deps,
        transition,
      );
      transition = persist(() =>
        retireSessionHandoffSource(deps.db, {
          sourceRetirement,
          transitionId: transition.id,
        }),
      );
      continue;
    }
    throw new ApiError(
      409,
      "handoff_not_ready_for_activation",
      `Handoff ${transition.id} cannot activate from ${transition.phase}`,
      false,
    );
  }
  throw new ApiError(
    500,
    "handoff_activation_did_not_converge",
    `Handoff ${transition.id} did not reach completion`,
  );
}

export async function abortSessionFabricHandoff(
  deps: AppDeps,
  transitionId: string,
): Promise<SessionFabricHandoffAbortResponse> {
  const transition = getHandoffAuditOrThrow(deps, transitionId).transition;
  if (transition.phase === "aborted") return { transition };
  if (!ABORTABLE_PHASES.has(transition.phase)) {
    throw new ApiError(
      409,
      "handoff_abort_forbidden",
      `Handoff ${transition.id} cannot abort after ${transition.phase}`,
      false,
    );
  }

  let destinationDiscard:
    | {
        bindingId: string;
        expectedControlEpoch: number;
        terminalControlEpoch: number;
      }
    | undefined;
  if (transition.destinationBindingId) {
    destinationDiscard = await discardPersistedDestination(deps, transition);
  } else if (transition.phase === "destination_staging_read_only") {
    await discardUnpersistedDestination(deps, transition);
  }

  let sourceRestore:
    | { enabledControlEpoch: number; expectedControlEpoch: number }
    | undefined;
  if (transition.sourceControlDisposition === "fenced") {
    let source = requireCompleteBindingContext(
      deps,
      transition.sourceBindingId,
    );
    const rpc = await callBindingRpcWithRecovery({
      call: (context) =>
        callHostRetryableOnlineRpc(deps, {
          command: {
            type: "session.handoff.restore_source",
            bindingId: context.binding.id,
            bootNonce: context.runtimeInstance.bootNonce,
            endpointFingerprint: context.runtimeInstance.endpointFingerprint,
            environmentId: context.environment.id,
            expectedControlEpoch: context.binding.controlEpoch,
            runtimeInstanceId: context.runtimeInstance.id,
            threadId: context.thread.id,
            transitionId: transition.id,
          },
          hostId: context.nativeConversation.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
        }),
      context: source,
      deps,
      executionSafety: "standard",
    });
    source = rpc.context;
    const control = rpc.result;
    const expectedControlEpoch = source.binding.controlEpoch;
    assertSourceRestoreControl({
      context: source,
      control,
      expectedControlEpoch,
    });
    sourceRestore = {
      enabledControlEpoch: control.controlEpoch,
      expectedControlEpoch,
    };
  }
  return {
    transition: persist(() =>
      abortSessionHandoff(deps.db, {
        ...(destinationDiscard ? { destinationDiscard } : {}),
        ...(sourceRestore ? { sourceRestore } : {}),
        transitionId: transition.id,
      }),
    ),
  };
}

export function getSessionFabricHandoffAudit(
  deps: Pick<AppDeps, "db">,
  transitionId: string,
): SessionFabricHandoffAuditResponse {
  const audit = getHandoffAuditOrThrow(deps, transitionId);
  return {
    authorization: audit.authorization,
    capsule: audit.capsule?.capsule ?? null,
    events: audit.events,
    restatement: audit.restatement,
    review: audit.review,
    settlement: audit.settlement,
    transition: audit.transition,
  };
}
