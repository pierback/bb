import { createHash } from "node:crypto";
import fs, { realpath } from "node:fs/promises";
import type {
  AgentRuntimeProviderProcessIncarnation,
  AgentRuntimeProviderSession,
  AgentRuntimeThreadConfigurationSnapshot,
} from "@bb/agent-runtime";
import {
  contextCapsuleRestatementSchema,
  contextCapsuleWorkspaceDigest,
  findContextCapsuleRestatementIssues,
  findContextCapsuleSensitiveMaterial,
  serializeContextCapsuleForHash,
  type ContextCapsule,
  type MutationReceipt,
  type RuntimePhaseLifecycleEvent,
  type SessionWorkspaceState,
} from "@bb/domain";
import { resolveContainedPath } from "@bb/process-utils";
import type {
  CommandDispatchOptions,
  CommandOf,
} from "../command-dispatch-support.js";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";
import type { RuntimeEntry } from "../runtime-manager.js";
import type { SessionRuntimeControlState } from "../session-runtime-broker.js";
import {
  inspectRuntimeRecipe,
  inspectWorkspaceState,
} from "../session-runtime-inspection.js";
import { requireResolvedWorkspaceForCommand } from "../workspace-resolution.js";

type BoundHandoffCommand = Pick<
  CommandOf<"session.handoff.fence_source">,
  | "bindingId"
  | "bootNonce"
  | "endpointFingerprint"
  | "environmentId"
  | "runtimeInstanceId"
  | "threadId"
  | "transitionId"
>;

interface LiveBoundRuntime {
  configuration: AgentRuntimeThreadConfigurationSnapshot;
  control: SessionRuntimeControlState;
  entry: RuntimeEntry;
  incarnation: AgentRuntimeProviderProcessIncarnation;
  providerSession: AgentRuntimeProviderSession;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireConfinedThreadStoragePath(
  rootPath: string,
  candidatePath: string,
): string {
  const resolved = resolveContainedPath({ rootPath, candidatePath });
  if (!resolved) {
    throw new ExpectedCommandDispatchError(
      "invalid_path",
      "Thread storage path escapes the storage root",
    );
  }
  return resolved;
}

function computeCapsuleContentHash(capsule: ContextCapsule): string {
  const { contentHash: _contentHash, ...payload } = capsule;
  return `sha256:${createHash("sha256")
    .update(serializeContextCapsuleForHash(payload))
    .digest("hex")}`;
}

function assertCapsuleSafeForProvider(args: {
  capsule: ContextCapsule;
  transitionId: string;
}): void {
  if (args.capsule.transitionId !== args.transitionId) {
    throw new ExpectedCommandDispatchError(
      "capsule_transition_mismatch",
      `Capsule belongs to handoff ${args.capsule.transitionId}, not ${args.transitionId}`,
    );
  }
  if (computeCapsuleContentHash(args.capsule) !== args.capsule.contentHash) {
    throw new ExpectedCommandDispatchError(
      "capsule_hash_mismatch",
      "Capsule content no longer matches its sealed content hash",
    );
  }
  const sensitiveKinds = findContextCapsuleSensitiveMaterial(args.capsule);
  if (sensitiveKinds.length > 0) {
    throw new ExpectedCommandDispatchError(
      "capsule_sensitive_material",
      `Capsule contains prohibited sensitive material categories: ${sensitiveKinds.join(", ")}`,
    );
  }
}

function workspaceMatchesCapsule(
  workspaceState: Awaited<ReturnType<typeof inspectWorkspaceState>>,
  capsule: ContextCapsule,
): boolean {
  return sameJson(
    contextCapsuleWorkspaceDigest({
      ...workspaceState,
      hostId: capsule.expectedWorkspaceState.hostId,
      id: capsule.expectedWorkspaceState.id,
    }),
    contextCapsuleWorkspaceDigest(capsule.expectedWorkspaceState),
  );
}

function workspaceMatchesExpected(
  workspaceState: Awaited<ReturnType<typeof inspectWorkspaceState>>,
  expected: Omit<SessionWorkspaceState, "hostId" | "id">,
): boolean {
  const identity = { hostId: "recovery-host", id: "recovery-workspace" };
  return sameJson(
    contextCapsuleWorkspaceDigest({ ...workspaceState, ...identity }),
    contextCapsuleWorkspaceDigest({ ...expected, ...identity }),
  );
}

function sameRuntimeIncarnation(
  left: AgentRuntimeProviderProcessIncarnation,
  right: AgentRuntimeProviderProcessIncarnation,
): boolean {
  return (
    left.bootNonce === right.bootNonce &&
    left.connectorId === right.connectorId &&
    left.endpointFingerprint === right.endpointFingerprint &&
    left.processKey === right.processKey &&
    left.providerId === right.providerId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.startedAt === right.startedAt
  );
}

async function requireLiveBoundRuntime(
  command: BoundHandoffCommand,
  options: CommandDispatchOptions,
): Promise<LiveBoundRuntime> {
  const control = options.sessionRuntimeBroker.get(command.bindingId);
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  if (
    !control ||
    control.environmentId !== command.environmentId ||
    control.threadId !== command.threadId ||
    !entry ||
    !entry.runtime.hasThread(command.threadId)
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      "Handoff command does not match a live bound runtime",
    );
  }
  const incarnation = entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const providerSession = entry.runtime.getProviderSession(command.threadId);
  const configuration = entry.runtime.getThreadConfigurationSnapshot(
    command.threadId,
  );
  if (!incarnation || !providerSession || !configuration) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      `Thread ${command.threadId} has incomplete live runtime evidence`,
    );
  }
  if (
    incarnation.runtimeInstanceId !== command.runtimeInstanceId ||
    incarnation.bootNonce !== command.bootNonce ||
    incarnation.endpointFingerprint !== command.endpointFingerprint ||
    control.incarnation.runtimeInstanceId !== incarnation.runtimeInstanceId ||
    control.incarnation.bootNonce !== incarnation.bootNonce ||
    control.incarnation.endpointFingerprint !==
      incarnation.endpointFingerprint ||
    providerSession.providerId !== incarnation.providerId ||
    configuration.providerId !== providerSession.providerId ||
    configuration.environmentId !== command.environmentId
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_mismatch",
      "Handoff command does not target the broker's exact live provider incarnation",
    );
  }
  return { configuration, control, entry, incarnation, providerSession };
}

async function requireIdleRuntime(
  live: LiveBoundRuntime,
  threadId: string,
): Promise<void> {
  if (live.entry.runtime.getActiveTurnId(threadId) !== null) {
    throw new ExpectedCommandDispatchError(
      "runtime_not_idle",
      `Thread ${threadId} still has an active provider turn`,
    );
  }
  if (live.entry.runtime.hasOpenBackgroundWorkForThread(threadId)) {
    throw new ExpectedCommandDispatchError(
      "runtime_has_background_work",
      `Thread ${threadId} has open background work`,
    );
  }
}

function requireProviderProcessId(
  entry: RuntimeEntry,
  threadId: string,
): number {
  const processId = entry.runtime.getProviderProcessId(threadId);
  if (processId === null) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      `Thread ${threadId} has no live provider process identity`,
    );
  }
  return processId;
}

async function captureRuntimeInspection(args: {
  configuration: AgentRuntimeThreadConfigurationSnapshot;
  entry: RuntimeEntry;
  incarnation: AgentRuntimeProviderProcessIncarnation;
  providerInstanceId: string;
  providerSession: AgentRuntimeProviderSession;
  threadId: string;
}) {
  const capturedAt = Date.now();
  const [runtimeRecipe, workspaceState] = await Promise.all([
    inspectRuntimeRecipe({
      configuration: args.configuration,
      entry: args.entry,
    }),
    inspectWorkspaceState({ capturedAt, entry: args.entry }),
  ]);
  const turnId = args.entry.runtime.getActiveTurnId(args.threadId);
  return {
    environmentId: args.configuration.environmentId,
    execution: {
      effectiveModel: {
        modelId: args.configuration.options.model,
        providerId: args.configuration.providerId,
      },
      reasoningLevel: args.configuration.options.reasoningLevel,
      serviceTier: args.configuration.options.serviceTier,
    },
    executionSafety: args.configuration.executionSafety,
    incarnation: args.incarnation,
    ownership: "owned_brokered" as const,
    phase: turnId === null ? ("idle" as const) : ("running" as const),
    providerId: args.providerSession.providerId,
    providerInstanceId: args.providerInstanceId,
    providerThreadId: args.providerSession.providerThreadId,
    runtimeRecipe,
    threadId: args.threadId,
    turnId,
    workspaceState,
  };
}

function rejectedReceipt(args: {
  diagnostic: string;
  requestedModel: CommandOf<"session.model_change">["requestedModel"];
}): MutationReceipt {
  return {
    acceptance: "not_accepted",
    diagnostic: args.diagnostic,
    effectiveAccount: null,
    effectiveModel: null,
    observedCursor: null,
    providerRequestId: null,
    providerTurnId: null,
    requestedModel: args.requestedModel,
  };
}

function observeDispatchSettlement(args: {
  bindingId: string;
  event: Extract<
    RuntimePhaseLifecycleEvent,
    "command_completed" | "command_outcome_unknown" | "command_rejected"
  >;
  options: CommandDispatchOptions;
}): void {
  const current = args.options.sessionRuntimeBroker.get(args.bindingId);
  if (!current || current.phase !== "dispatching") {
    return;
  }
  args.options.sessionRuntimeBroker.observeRuntimePhase({
    bindingId: args.bindingId,
    bootNonce: current.incarnation.bootNonce,
    endpointFingerprint: current.incarnation.endpointFingerprint,
    event: args.event,
    runtimeInstanceId: current.incarnation.runtimeInstanceId,
  });
}

export async function bindSessionRuntime(
  command: CommandOf<"session.runtime.bind">,
  options: CommandDispatchOptions,
) {
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  if (!entry || !entry.runtime.hasThread(command.threadId)) {
    throw new ExpectedCommandDispatchError(
      "unknown_thread_runtime",
      `No provider runtime is hosting thread ${command.threadId}`,
    );
  }
  const providerSession = entry.runtime.getProviderSession(command.threadId);
  const incarnation = entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const configuration = entry.runtime.getThreadConfigurationSnapshot(
    command.threadId,
  );
  if (!providerSession || !incarnation || !configuration) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      `Thread ${command.threadId} has no live provider incarnation`,
    );
  }
  if (configuration.executionSafety !== "standard") {
    throw new ExpectedCommandDispatchError(
      "handoff_control_required",
      `Thread ${command.threadId} is under a handoff execution-safety overlay`,
    );
  }
  if (
    incarnation.runtimeInstanceId !== command.expectedRuntimeInstanceId ||
    incarnation.bootNonce !== command.expectedBootNonce ||
    incarnation.endpointFingerprint !== command.expectedEndpointFingerprint
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_mismatch",
      `Thread ${command.threadId} moved to a different provider runtime after inspection`,
    );
  }
  if (
    providerSession.providerId !== command.expectedProviderId ||
    providerSession.providerThreadId !== command.expectedProviderThreadId
  ) {
    throw new ExpectedCommandDispatchError(
      "native_conversation_mismatch",
      `Thread ${command.threadId} is hosted by a different provider conversation`,
    );
  }
  const workspaceId = await realpath(entry.path);
  const runtimeProcessId = requireProviderProcessId(entry, command.threadId);
  const existing = options.sessionRuntimeBroker.get(command.bindingId);
  if (
    existing &&
    existing.controlEpoch === command.controlEpoch &&
    existing.environmentId === command.environmentId &&
    existing.executionSafety === "standard" &&
    existing.handoffCheckpoint === "not_applicable" &&
    existing.handoffRole === null &&
    existing.handoffTransitionId === null &&
    existing.mutationPolicy === command.mutationPolicy &&
    existing.ownership === "owned_brokered" &&
    existing.providerInstanceId === command.providerInstanceId &&
    existing.threadId === command.threadId &&
    existing.workspaceId === workspaceId &&
    existing.incarnation.bootNonce === incarnation.bootNonce &&
    existing.incarnation.connectorId === incarnation.connectorId &&
    existing.incarnation.endpointFingerprint ===
      incarnation.endpointFingerprint &&
    existing.incarnation.processKey === incarnation.processKey &&
    existing.incarnation.providerId === incarnation.providerId &&
    existing.incarnation.runtimeInstanceId === incarnation.runtimeInstanceId &&
    existing.incarnation.startedAt === incarnation.startedAt
  ) {
    return options.sessionRuntimeBroker.bindManagedRuntime({
      ...existing,
      providerThreadId: providerSession.providerThreadId,
      runtimeProcessId,
    });
  }
  if (entry.runtime.hasOpenBackgroundWorkForThread(command.threadId)) {
    throw new ExpectedCommandDispatchError(
      "runtime_has_background_work",
      `Thread ${command.threadId} has open background work and cannot be rebound`,
    );
  }

  const turnId = entry.runtime.getActiveTurnId(command.threadId);
  return options.sessionRuntimeBroker.bindManagedRuntime({
    bindingId: command.bindingId,
    controlEpoch: command.controlEpoch,
    environmentId: command.environmentId,
    executionSafety: configuration.executionSafety,
    handoffCheckpoint: "not_applicable",
    handoffRole: null,
    handoffTransitionId: null,
    incarnation,
    mutationPolicy: command.mutationPolicy,
    nativeCursor: null,
    ownership: "owned_brokered",
    phase: turnId === null ? "idle" : "running",
    providerInstanceId: command.providerInstanceId,
    providerThreadId: providerSession.providerThreadId,
    runtimeProcessId,
    threadId: command.threadId,
    turnId,
    workspaceId,
  });
}

function recoveryConfigurationMatches(args: {
  command: CommandOf<"session.runtime.recover">;
  configuration: AgentRuntimeThreadConfigurationSnapshot;
  executionSafety: "handoff_restatement" | "standard";
}): boolean {
  const { command, configuration } = args;
  return (
    configuration.environmentId === command.environmentId &&
    configuration.executionSafety === args.executionSafety &&
    configuration.instructionMode === command.instructionMode &&
    configuration.instructions === command.instructions &&
    configuration.projectId === command.projectId &&
    configuration.providerId === command.providerId &&
    sameJson(configuration.options, command.options) &&
    sameJson(configuration.dynamicTools, command.dynamicTools) &&
    sameJson(configuration.disallowedTools, command.disallowedTools ?? [])
  );
}

/**
 * Reattaches an idle binding after daemon/provider-process loss. The broker
 * proves the old PID dead before resume and commits the new incarnation plus
 * epoch only after configuration, recipe, workspace, and provider identity
 * all match the server-owned recovery request.
 */
export async function recoverSessionRuntime(
  command: CommandOf<"session.runtime.recover">,
  options: CommandDispatchOptions,
) {
  const control = options.sessionRuntimeBroker.get(command.bindingId);
  if (
    !control ||
    control.environmentId !== command.environmentId ||
    control.threadId !== command.threadId ||
    control.providerInstanceId !== command.providerInstanceId ||
    options.sessionRuntimeBroker.getProviderThreadId(command.bindingId) !==
      command.expectedProviderThreadId
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      `Recovery request does not match binding ${command.bindingId}`,
    );
  }
  const replay =
    options.sessionRuntimeBroker.getManagedRuntimeRecoveryReplay(command);
  if (
    !replay &&
    (control.controlEpoch !== command.expectedControlEpoch ||
      control.incarnation.bootNonce !== command.expectedBootNonce ||
      control.incarnation.endpointFingerprint !==
        command.expectedEndpointFingerprint ||
      control.incarnation.runtimeInstanceId !==
        command.expectedRuntimeInstanceId)
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_mismatch",
      `Recovery request is stale for binding ${command.bindingId}`,
    );
  }

  const entry = await requireResolvedWorkspaceForCommand({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    injectedSkillSources: command.injectedSkillSources,
    runtimeManager: options.runtimeManager,
    targetThreadId: command.threadId,
    workspaceContext: command.workspaceContext,
  });
  const workspaceId = await realpath(entry.path);
  if (workspaceId !== control.workspaceId) {
    throw new ExpectedCommandDispatchError(
      "workspace_control_conflict",
      `Recovery workspace does not match binding ${command.bindingId}`,
    );
  }

  const targetControl = replay ?? control;
  const inspectCandidate = async () => {
    const providerSession = entry.runtime.getProviderSession(command.threadId);
    const incarnation = entry.runtime.getProviderRuntimeIncarnation(
      command.threadId,
    );
    const configuration = entry.runtime.getThreadConfigurationSnapshot(
      command.threadId,
    );
    if (!providerSession || !incarnation || !configuration) {
      throw new ExpectedCommandDispatchError(
        "runtime_incarnation_unavailable",
        `Recovered thread ${command.threadId} has incomplete runtime evidence`,
      );
    }
    if (
      providerSession.providerId !== command.providerId ||
      providerSession.providerThreadId !== command.expectedProviderThreadId ||
      incarnation.providerId !== command.providerId ||
      !recoveryConfigurationMatches({
        command,
        configuration,
        executionSafety: targetControl.executionSafety,
      }) ||
      entry.runtime.getActiveTurnId(command.threadId) !== null ||
      entry.runtime.hasOpenBackgroundWorkForThread(command.threadId)
    ) {
      throw new ExpectedCommandDispatchError(
        "runtime_recovery_mismatch",
        `Recovered thread ${command.threadId} is not an exact idle configuration match`,
      );
    }
    const [runtimeRecipe, workspaceState] = await Promise.all([
      inspectRuntimeRecipe({ configuration, entry }),
      inspectWorkspaceState({ capturedAt: Date.now(), entry }),
    ]);
    if (
      !sameJson(runtimeRecipe, command.expectedRuntimeRecipe) ||
      !workspaceMatchesExpected(workspaceState, command.expectedWorkspaceState)
    ) {
      throw new ExpectedCommandDispatchError(
        "runtime_recovery_mismatch",
        "Recovered runtime recipe or workspace checkpoint differs from the durable binding",
      );
    }
    return { configuration, incarnation, providerSession, workspaceState };
  };

  const runWithCreatedRuntimeCleanup = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (entry.runtime.hasThread(command.threadId)) {
        try {
          await entry.runtime.stopThread({ threadId: command.threadId });
          await options.eventSink.flush();
        } catch {
          throw new ExpectedCommandDispatchError(
            "runtime_recovery_cleanup_failed",
            `Thread ${command.threadId} could not be stopped after recovery failed`,
          );
        }
      }
      throw error;
    }
  };

  if (entry.runtime.hasThread(command.threadId)) {
    const existing = await inspectCandidate();
    if (
      sameRuntimeIncarnation(existing.incarnation, targetControl.incarnation)
    ) {
      return {
        control: targetControl,
        inspection: await captureRuntimeInspection({
          ...existing,
          entry,
          providerInstanceId: command.providerInstanceId,
          threadId: command.threadId,
        }),
      };
    }
    if (replay) {
      throw new ExpectedCommandDispatchError(
        "runtime_incarnation_mismatch",
        "Recovered binding moved again before the server recorded its incarnation",
      );
    }
  } else if (replay) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      "Recovered binding lost its replacement runtime before server reconciliation",
    );
  }

  const permit =
    options.sessionRuntimeBroker.prepareManagedRuntimeRecovery(command);
  const completeRecovery = async () => {
    const recovered = await inspectCandidate();
    const inspection = await captureRuntimeInspection({
      configuration: recovered.configuration,
      entry,
      incarnation: recovered.incarnation,
      providerInstanceId: command.providerInstanceId,
      providerSession: recovered.providerSession,
      threadId: command.threadId,
    });
    const runtimeProcessId = requireProviderProcessId(entry, command.threadId);
    const recoveredControl =
      options.sessionRuntimeBroker.completeManagedRuntimeRecovery({
        incarnation: recovered.incarnation,
        permit,
        providerThreadId: recovered.providerSession.providerThreadId,
        runtimeProcessId,
      });
    return { control: recoveredControl, inspection };
  };
  if (entry.runtime.hasThread(command.threadId)) {
    return completeRecovery();
  }
  return runWithCreatedRuntimeCleanup(async () => {
    await entry.runtime.resumeThread({
      ...(command.acpLaunchSpec !== undefined
        ? { acpLaunchSpec: command.acpLaunchSpec }
        : {}),
      environmentId: command.environmentId,
      executionSafety: control.executionSafety,
      threadId: command.threadId,
      projectId: command.projectId,
      providerId: command.providerId,
      providerThreadId: command.expectedProviderThreadId,
      options: command.options,
      instructions: command.instructions,
      dynamicTools: command.dynamicTools,
      disallowedTools: command.disallowedTools,
      instructionMode: command.instructionMode,
    });
    return completeRecovery();
  });
}

export async function inspectSessionRuntime(
  command: CommandOf<"session.runtime.inspect">,
  options: CommandDispatchOptions,
) {
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  if (!entry || !entry.runtime.hasThread(command.threadId)) {
    throw new ExpectedCommandDispatchError(
      "unknown_thread_runtime",
      `No provider runtime is hosting thread ${command.threadId}`,
    );
  }
  const providerSession = entry.runtime.getProviderSession(command.threadId);
  const incarnation = entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const configuration = entry.runtime.getThreadConfigurationSnapshot(
    command.threadId,
  );
  if (!providerSession || !incarnation || !configuration) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      `Thread ${command.threadId} has incomplete live runtime evidence`,
    );
  }
  if (
    providerSession.providerId !== command.expectedProviderId ||
    providerSession.providerThreadId !== command.expectedProviderThreadId ||
    configuration.providerId !== command.expectedProviderId ||
    configuration.environmentId !== command.environmentId
  ) {
    throw new ExpectedCommandDispatchError(
      "native_conversation_mismatch",
      `Thread ${command.threadId} is hosted by a different provider conversation`,
    );
  }
  if (entry.runtime.hasOpenBackgroundWorkForThread(command.threadId)) {
    throw new ExpectedCommandDispatchError(
      "runtime_has_background_work",
      `Thread ${command.threadId} has open background work and cannot be inspected for adoption`,
    );
  }

  return captureRuntimeInspection({
    configuration,
    entry,
    incarnation,
    providerInstanceId: command.providerInstanceId,
    providerSession,
    threadId: command.threadId,
  });
}

export async function setSessionRuntimeMutationPolicy(
  command: CommandOf<"session.runtime.set_mutation_policy">,
  options: CommandDispatchOptions,
) {
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  const liveIncarnation = entry?.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const current = options.sessionRuntimeBroker.get(command.bindingId);
  if (
    !entry ||
    !liveIncarnation ||
    !current ||
    current.environmentId !== command.environmentId ||
    current.threadId !== command.threadId ||
    liveIncarnation.runtimeInstanceId !== command.runtimeInstanceId ||
    liveIncarnation.bootNonce !== command.bootNonce ||
    liveIncarnation.endpointFingerprint !== command.endpointFingerprint
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_unavailable",
      "mutation-policy command does not match the live bound runtime",
    );
  }
  return options.sessionRuntimeBroker.setMutationPolicy(command);
}

export async function fenceSessionHandoffSource(
  command: CommandOf<"session.handoff.fence_source">,
  options: CommandDispatchOptions,
) {
  const live = await requireLiveBoundRuntime(command, options);
  await requireIdleRuntime(live, command.threadId);
  if (
    live.control.phase !== "idle" ||
    live.control.turnId !== null ||
    live.configuration.executionSafety !== "standard"
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_not_idle",
      `Binding ${command.bindingId} is not an idle standard source runtime`,
    );
  }
  return options.sessionRuntimeBroker.fenceHandoffSource(command);
}

export async function inspectSessionHandoffSource(
  command: CommandOf<"session.handoff.inspect_source">,
  options: CommandDispatchOptions,
) {
  const live = await requireLiveBoundRuntime(command, options);
  await requireIdleRuntime(live, command.threadId);
  const control =
    options.sessionRuntimeBroker.assertHandoffSourceFenced(command);
  if (live.configuration.executionSafety !== "standard") {
    throw new ExpectedCommandDispatchError(
      "source_execution_safety_mismatch",
      `Source thread ${command.threadId} is not using standard execution safety`,
    );
  }
  const settlement = live.entry.runtime.getThreadSettlementState(
    command.threadId,
  );
  const inspection = await captureRuntimeInspection({
    configuration: live.configuration,
    entry: live.entry,
    incarnation: live.incarnation,
    providerInstanceId: live.control.providerInstanceId,
    providerSession: live.providerSession,
    threadId: command.threadId,
  });
  return {
    control,
    inspection: {
      ...inspection,
      workspaceState: {
        ...inspection.workspaceState,
        externalSideEffectStatus: settlement.externalSideEffectStatus,
      },
    },
    settlement,
  };
}

export async function inspectSessionHandoffDestinationWorkspace(
  command: CommandOf<"session.handoff.inspect_destination_workspace">,
  options: CommandDispatchOptions,
) {
  const entry = await requireResolvedWorkspaceForCommand({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    runtimeManager: options.runtimeManager,
    workspaceContext: command.workspaceContext,
  });
  return inspectWorkspaceState({ capturedAt: Date.now(), entry });
}

export async function restoreSessionHandoffSource(
  command: CommandOf<"session.handoff.restore_source">,
  options: CommandDispatchOptions,
) {
  const live = await requireLiveBoundRuntime(command, options);
  await requireIdleRuntime(live, command.threadId);
  if (
    live.control.phase !== "idle" ||
    live.control.turnId !== null ||
    live.configuration.executionSafety !== "standard"
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_not_idle",
      `Binding ${command.bindingId} is not an idle standard source runtime`,
    );
  }
  return options.sessionRuntimeBroker.restoreHandoffSource(command);
}

type HandoffTerminationCommand =
  | CommandOf<"session.handoff.discard_destination">
  | CommandOf<"session.handoff.retire_source">;

async function terminateSessionHandoffRuntime(
  command: HandoffTerminationCommand,
  options: CommandDispatchOptions,
) {
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  let liveIncarnation: AgentRuntimeProviderProcessIncarnation | null = null;
  if (entry?.runtime.hasThread(command.threadId)) {
    liveIncarnation = entry.runtime.getProviderRuntimeIncarnation(
      command.threadId,
    );
    if (!liveIncarnation) {
      throw new ExpectedCommandDispatchError(
        "runtime_incarnation_unavailable",
        `Thread ${command.threadId} has no live incarnation for handoff termination`,
      );
    }
  }
  const terminalControl =
    command.type === "session.handoff.retire_source"
      ? options.sessionRuntimeBroker.retireHandoffSource({
          bindingId: command.bindingId,
          environmentId: command.environmentId,
          evidence: {
            mode: "exact",
            expectedBootNonce: command.bootNonce,
            expectedControlEpoch: command.expectedControlEpoch,
            expectedEndpointFingerprint: command.endpointFingerprint,
            expectedRuntimeInstanceId: command.runtimeInstanceId,
          },
          liveIncarnation,
          threadId: command.threadId,
          transitionId: command.transitionId,
        })
      : options.sessionRuntimeBroker.discardHandoffDestination({
          bindingId: command.bindingId,
          environmentId: command.environmentId,
          evidence:
            command.evidenceMode === "exact"
              ? {
                  mode: "exact",
                  expectedBootNonce: command.bootNonce,
                  expectedControlEpoch: command.expectedControlEpoch,
                  expectedEndpointFingerprint: command.endpointFingerprint,
                  expectedRuntimeInstanceId: command.runtimeInstanceId,
                }
              : { mode: "transition" },
          liveIncarnation,
          threadId: command.threadId,
          transitionId: command.transitionId,
        });
  if (entry?.runtime.hasThread(command.threadId)) {
    await entry.runtime.stopThread({ threadId: command.threadId });
    await options.eventSink.flush();
  }
  return terminalControl;
}

export async function discardSessionHandoffDestination(
  command: CommandOf<"session.handoff.discard_destination">,
  options: CommandDispatchOptions,
) {
  return terminateSessionHandoffRuntime(command, options);
}

export async function retireSessionHandoffSource(
  command: CommandOf<"session.handoff.retire_source">,
  options: CommandDispatchOptions,
) {
  return terminateSessionHandoffRuntime(command, options);
}

function stageConfigurationMatches(args: {
  command: CommandOf<"session.handoff.stage_destination">;
  configuration: AgentRuntimeThreadConfigurationSnapshot;
}): boolean {
  const { command, configuration } = args;
  return (
    configuration.environmentId === command.environmentId &&
    configuration.executionSafety === "handoff_restatement" &&
    configuration.instructionMode === command.instructionMode &&
    configuration.instructions === command.instructions &&
    configuration.projectId === command.projectId &&
    configuration.providerId === command.providerId &&
    sameJson(configuration.options, command.options) &&
    sameJson(configuration.dynamicTools, command.dynamicTools) &&
    sameJson(configuration.disallowedTools, command.disallowedTools ?? [])
  );
}

function stageControlMatches(args: {
  command: CommandOf<"session.handoff.stage_destination">;
  control: SessionRuntimeControlState;
  workspaceId: string;
}): boolean {
  const { command, control, workspaceId } = args;
  return (
    control.bindingId === command.bindingId &&
    control.controlEpoch >= command.controlEpoch &&
    control.environmentId === command.environmentId &&
    control.executionSafety === "handoff_restatement" &&
    control.handoffCheckpoint === "destination_staged" &&
    control.handoffRole === "destination" &&
    control.handoffTransitionId === command.transitionId &&
    control.mutationPolicy === "staged_read_only" &&
    control.nativeCursor === null &&
    control.ownership === "owned_brokered" &&
    control.phase === "idle" &&
    control.providerInstanceId === command.providerInstanceId &&
    control.threadId === command.threadId &&
    control.turnId === null &&
    control.workspaceId === workspaceId &&
    control.incarnation.providerId === command.providerId
  );
}

export async function stageSessionHandoffDestination(
  command: CommandOf<"session.handoff.stage_destination">,
  options: CommandDispatchOptions,
) {
  const confinedStoragePath = requireConfinedThreadStoragePath(
    options.threadStorageRootPath,
    command.threadStoragePath,
  );
  await fs.mkdir(confinedStoragePath, { recursive: true });
  const entry = await requireResolvedWorkspaceForCommand({
    dataDir: options.dataDir,
    environmentId: command.environmentId,
    injectedSkillSources: command.injectedSkillSources,
    runtimeManager: options.runtimeManager,
    targetThreadId: command.threadId,
    workspaceContext: command.workspaceContext,
  });
  const workspaceId = await realpath(entry.path);
  const existingControl = options.sessionRuntimeBroker.get(command.bindingId);
  if (
    workspaceId !== command.expectedWorkspaceState.rootPath ||
    (existingControl &&
      !stageControlMatches({ command, control: existingControl, workspaceId }))
  ) {
    throw new ExpectedCommandDispatchError(
      "destination_stage_mismatch",
      `Destination binding ${command.bindingId} does not match the requested workspace and isolated control`,
    );
  }

  const inspectCandidate = async () => {
    const providerSession = entry.runtime.getProviderSession(command.threadId);
    const incarnation = entry.runtime.getProviderRuntimeIncarnation(
      command.threadId,
    );
    const configuration = entry.runtime.getThreadConfigurationSnapshot(
      command.threadId,
    );
    if (!providerSession || !incarnation || !configuration) {
      throw new ExpectedCommandDispatchError(
        "runtime_incarnation_unavailable",
        `Destination thread ${command.threadId} has incomplete runtime evidence`,
      );
    }
    const configuredWorkspacePath = await realpath(configuration.workspacePath);
    if (
      providerSession.providerId !== command.providerId ||
      incarnation.providerId !== command.providerId ||
      !stageConfigurationMatches({ command, configuration }) ||
      configuredWorkspacePath !== workspaceId ||
      entry.runtime.getActiveTurnId(command.threadId) !== null ||
      entry.runtime.hasOpenBackgroundWorkForThread(command.threadId)
    ) {
      throw new ExpectedCommandDispatchError(
        "destination_stage_mismatch",
        `Destination thread ${command.threadId} is not an exact idle isolated runtime match`,
      );
    }
    const [runtimeRecipe, workspaceState] = await Promise.all([
      inspectRuntimeRecipe({ configuration, entry }),
      inspectWorkspaceState({ capturedAt: Date.now(), entry }),
    ]);
    if (
      !workspaceMatchesExpected(workspaceState, command.expectedWorkspaceState)
    ) {
      throw new ExpectedCommandDispatchError(
        "destination_workspace_mismatch",
        "Destination workspace differs from the sealed handoff checkpoint",
      );
    }
    return {
      configuration,
      incarnation,
      providerSession,
      runtimeProcessId: requireProviderProcessId(entry, command.threadId),
      runtimeRecipe,
      workspaceState,
    };
  };

  const runWithCreatedRuntimeCleanup = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (entry.runtime.hasThread(command.threadId)) {
        try {
          await entry.runtime.stopThread({ threadId: command.threadId });
          await options.eventSink.flush();
        } catch {
          throw new ExpectedCommandDispatchError(
            "destination_stage_cleanup_failed",
            `Destination thread ${command.threadId} could not be stopped after its stage failed`,
          );
        }
      }
      throw error;
    }
  };

  let candidate: Awaited<ReturnType<typeof inspectCandidate>>;
  let control: SessionRuntimeControlState;
  if (!existingControl) {
    const inspectAndBind = async () => {
      const inspectedCandidate = await inspectCandidate();
      return {
        candidate: inspectedCandidate,
        control: options.sessionRuntimeBroker.bindManagedRuntime({
          bindingId: command.bindingId,
          controlEpoch: command.controlEpoch,
          environmentId: command.environmentId,
          executionSafety: "handoff_restatement",
          handoffCheckpoint: "destination_staged",
          handoffRole: "destination",
          handoffTransitionId: command.transitionId,
          incarnation: inspectedCandidate.incarnation,
          mutationPolicy: "staged_read_only",
          nativeCursor: null,
          ownership: "owned_brokered",
          phase: "idle",
          providerInstanceId: command.providerInstanceId,
          providerThreadId: inspectedCandidate.providerSession.providerThreadId,
          runtimeProcessId: inspectedCandidate.runtimeProcessId,
          threadId: command.threadId,
          turnId: null,
          workspaceId,
        }),
      };
    };
    if (entry.runtime.hasThread(command.threadId)) {
      ({ candidate, control } = await inspectAndBind());
    } else {
      ({ candidate, control } = await runWithCreatedRuntimeCleanup(async () => {
        await entry.runtime.startThread({
          ...(command.acpLaunchSpec !== undefined
            ? { acpLaunchSpec: command.acpLaunchSpec }
            : {}),
          environmentId: command.environmentId,
          executionSafety: "handoff_restatement",
          threadId: command.threadId,
          projectId: command.projectId,
          providerId: command.providerId,
          options: command.options,
          instructions: command.instructions,
          dynamicTools: command.dynamicTools,
          disallowedTools: command.disallowedTools,
          instructionMode: command.instructionMode,
        });
        return inspectAndBind();
      }));
    }
  } else {
    const expectedProviderThreadId =
      options.sessionRuntimeBroker.getProviderThreadId(command.bindingId);
    if (!expectedProviderThreadId) {
      throw new ExpectedCommandDispatchError(
        "runtime_incarnation_unavailable",
        `Destination binding ${command.bindingId} has no durable provider conversation identity`,
      );
    }
    if (entry.runtime.hasThread(command.threadId)) {
      candidate = await inspectCandidate();
      if (
        sameRuntimeIncarnation(
          candidate.incarnation,
          existingControl.incarnation,
        )
      ) {
        if (
          candidate.providerSession.providerThreadId !==
          expectedProviderThreadId
        ) {
          throw new ExpectedCommandDispatchError(
            "native_conversation_mismatch",
            `Destination binding ${command.bindingId} moved to a different provider conversation`,
          );
        }
        control = existingControl;
      } else {
        const permit =
          options.sessionRuntimeBroker.prepareManagedRuntimeRecovery({
            bindingId: command.bindingId,
            expectedBootNonce: existingControl.incarnation.bootNonce,
            expectedControlEpoch: existingControl.controlEpoch,
            expectedEndpointFingerprint:
              existingControl.incarnation.endpointFingerprint,
            expectedRuntimeInstanceId:
              existingControl.incarnation.runtimeInstanceId,
          });
        if (
          candidate.providerSession.providerThreadId !==
          expectedProviderThreadId
        ) {
          throw new ExpectedCommandDispatchError(
            "native_conversation_mismatch",
            `Recovered destination ${command.bindingId} does not resume its staged provider conversation`,
          );
        }
        control = options.sessionRuntimeBroker.completeManagedRuntimeRecovery({
          incarnation: candidate.incarnation,
          permit,
          providerThreadId: candidate.providerSession.providerThreadId,
          runtimeProcessId: candidate.runtimeProcessId,
        });
      }
    } else {
      const permit = options.sessionRuntimeBroker.prepareManagedRuntimeRecovery(
        {
          bindingId: command.bindingId,
          expectedBootNonce: existingControl.incarnation.bootNonce,
          expectedControlEpoch: existingControl.controlEpoch,
          expectedEndpointFingerprint:
            existingControl.incarnation.endpointFingerprint,
          expectedRuntimeInstanceId:
            existingControl.incarnation.runtimeInstanceId,
        },
      );
      ({ candidate, control } = await runWithCreatedRuntimeCleanup(async () => {
        await entry.runtime.resumeThread({
          ...(command.acpLaunchSpec !== undefined
            ? { acpLaunchSpec: command.acpLaunchSpec }
            : {}),
          environmentId: command.environmentId,
          executionSafety: "handoff_restatement",
          threadId: command.threadId,
          projectId: command.projectId,
          providerId: command.providerId,
          providerThreadId: expectedProviderThreadId,
          options: command.options,
          instructions: command.instructions,
          dynamicTools: command.dynamicTools,
          disallowedTools: command.disallowedTools,
          instructionMode: command.instructionMode,
        });
        const recoveredCandidate = await inspectCandidate();
        if (
          recoveredCandidate.providerSession.providerThreadId !==
          expectedProviderThreadId
        ) {
          throw new ExpectedCommandDispatchError(
            "native_conversation_mismatch",
            `Recovered destination ${command.bindingId} does not resume its staged provider conversation`,
          );
        }
        return {
          candidate: recoveredCandidate,
          control: options.sessionRuntimeBroker.completeManagedRuntimeRecovery({
            incarnation: recoveredCandidate.incarnation,
            permit,
            providerThreadId:
              recoveredCandidate.providerSession.providerThreadId,
            runtimeProcessId: recoveredCandidate.runtimeProcessId,
          }),
        };
      }));
    }
  }
  return {
    control,
    inspection: {
      environmentId: command.environmentId,
      execution: {
        effectiveModel: {
          modelId: candidate.configuration.options.model,
          providerId: candidate.configuration.providerId,
        },
        reasoningLevel: candidate.configuration.options.reasoningLevel,
        serviceTier: candidate.configuration.options.serviceTier,
      },
      executionSafety: candidate.configuration.executionSafety,
      incarnation: candidate.incarnation,
      ownership: "owned_brokered" as const,
      phase: "idle" as const,
      providerId: candidate.providerSession.providerId,
      providerInstanceId: command.providerInstanceId,
      providerThreadId: candidate.providerSession.providerThreadId,
      runtimeRecipe: candidate.runtimeRecipe,
      threadId: command.threadId,
      turnId: null,
      workspaceState: candidate.workspaceState,
    },
  };
}

export async function restateSessionHandoffDestination(
  command: CommandOf<"session.handoff.restate_destination">,
  options: CommandDispatchOptions,
) {
  assertCapsuleSafeForProvider({
    capsule: command.capsule,
    transitionId: command.transitionId,
  });
  const replay = options.sessionRuntimeBroker.getHandoffDestinationRestatement({
    ...command,
    capsuleContentHash: command.capsule.contentHash,
  });
  if (replay) {
    return {
      control: replay.control,
      restatement: replay.receipt.restatement,
      turnId: replay.receipt.turnId,
      workspaceState: replay.receipt.workspaceState,
    };
  }
  const live = await requireLiveBoundRuntime(command, options);
  if (live.control.phase === "outcome_unknown") {
    await requireIdleRuntime(live, command.threadId);
    const retryWorkspaceState = await inspectWorkspaceState({
      capturedAt: Date.now(),
      entry: live.entry,
    });
    if (!workspaceMatchesCapsule(retryWorkspaceState, command.capsule)) {
      throw new ExpectedCommandDispatchError(
        "destination_workspace_mismatch",
        "Destination workspace changed after an ambiguous isolated restatement",
      );
    }
    options.sessionRuntimeBroker.prepareHandoffDestinationRestatementRetry(
      command,
    );
  }
  options.sessionRuntimeBroker.assertHandoffDestinationStaged(command);
  await requireIdleRuntime(live, command.threadId);
  if (live.configuration.executionSafety !== "handoff_restatement") {
    throw new ExpectedCommandDispatchError(
      "destination_isolation_missing",
      `Destination thread ${command.threadId} is not isolated for restatement`,
    );
  }

  options.sessionRuntimeBroker.observeRuntimePhase({
    bindingId: command.bindingId,
    bootNonce: live.incarnation.bootNonce,
    endpointFingerprint: live.incarnation.endpointFingerprint,
    event: "begin_dispatch",
    runtimeInstanceId: live.incarnation.runtimeInstanceId,
  });

  let completion;
  try {
    completion = await live.entry.runtime.runTurnAndWaitForCompletion({
      threadId: command.threadId,
      input: command.input,
      clientRequestId: command.requestId,
      options: live.configuration.options,
      ...(live.configuration.instructions !== null
        ? { instructions: live.configuration.instructions }
        : {}),
      timeoutMs: command.timeoutMs,
    });
  } catch (error) {
    observeDispatchSettlement({
      bindingId: command.bindingId,
      event: "command_outcome_unknown",
      options,
    });
    throw new ExpectedCommandDispatchError(
      "destination_restatement_outcome_unknown",
      error instanceof Error
        ? `Destination restatement outcome is unknown: ${error.message}`
        : "Destination restatement outcome is unknown",
    );
  }

  if (completion.status !== "completed") {
    observeDispatchSettlement({
      bindingId: command.bindingId,
      event: "command_rejected",
      options,
    });
    throw new ExpectedCommandDispatchError(
      "destination_restatement_failed",
      completion.errorMessage ??
        `Destination restatement ended with status ${completion.status}`,
    );
  }
  observeDispatchSettlement({
    bindingId: command.bindingId,
    event: "command_completed",
    options,
  });
  options.sessionRuntimeBroker.assertHandoffDestinationStaged(command);

  let restatement: ReturnType<typeof contextCapsuleRestatementSchema.parse>;
  try {
    restatement = contextCapsuleRestatementSchema.parse(
      JSON.parse(completion.assistantText.trim()),
    );
  } catch {
    throw new ExpectedCommandDispatchError(
      "destination_restatement_invalid",
      "Destination returned something other than the exact restatement JSON object",
    );
  }
  const issues = findContextCapsuleRestatementIssues(
    command.capsule,
    restatement,
  );
  if (issues.length > 0) {
    throw new ExpectedCommandDispatchError(
      "destination_restatement_mismatch",
      `Destination restatement failed verification: ${issues.join(", ")}`,
    );
  }

  const refreshedIncarnation = live.entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  if (
    !refreshedIncarnation ||
    refreshedIncarnation.runtimeInstanceId !==
      live.incarnation.runtimeInstanceId ||
    refreshedIncarnation.bootNonce !== live.incarnation.bootNonce ||
    refreshedIncarnation.endpointFingerprint !==
      live.incarnation.endpointFingerprint ||
    live.entry.runtime.getActiveTurnId(command.threadId) !== null ||
    live.entry.runtime.hasOpenBackgroundWorkForThread(command.threadId)
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_mismatch",
      "Destination runtime changed or remained active after restatement",
    );
  }
  const workspaceState = await inspectWorkspaceState({
    capturedAt: Date.now(),
    entry: live.entry,
  });
  if (!workspaceMatchesCapsule(workspaceState, command.capsule)) {
    throw new ExpectedCommandDispatchError(
      "destination_workspace_mismatch",
      "Destination workspace digest changed during isolated restatement",
    );
  }
  const control = options.sessionRuntimeBroker.markHandoffDestinationRestated({
    ...command,
    receipt: {
      capsuleContentHash: command.capsule.contentHash,
      requestId: command.requestId,
      restatement,
      transitionId: command.transitionId,
      turnId: completion.turnId,
      workspaceState,
    },
  });
  return {
    control,
    restatement,
    turnId: completion.turnId,
    workspaceState,
  };
}

export async function enableSessionHandoffDestination(
  command: CommandOf<"session.handoff.enable_destination">,
  options: CommandDispatchOptions,
) {
  const live = await requireLiveBoundRuntime(command, options);
  if (
    live.control.controlEpoch === command.expectedControlEpoch + 1 &&
    live.control.executionSafety === "standard" &&
    live.control.handoffCheckpoint === "destination_restated" &&
    live.control.handoffRole === "destination" &&
    live.control.handoffTransitionId === command.transitionId &&
    live.control.mutationPolicy === "enabled" &&
    live.configuration.executionSafety === "standard"
  ) {
    return {
      acceptance: "accepted" as const,
      control: live.control,
      diagnostic: null,
      providerRequestId: null,
      providerThreadId: live.providerSession.providerThreadId,
    };
  }

  if (live.control.phase === "outcome_unknown") {
    await requireIdleRuntime(live, command.threadId);
    options.sessionRuntimeBroker.prepareHandoffDestinationEnableRetry(command);
  }

  options.sessionRuntimeBroker.assertHandoffDestinationRestated(command);
  await requireIdleRuntime(live, command.threadId);
  if (live.configuration.executionSafety !== "handoff_restatement") {
    throw new ExpectedCommandDispatchError(
      "destination_isolation_missing",
      `Destination thread ${command.threadId} is not under the restatement overlay`,
    );
  }
  options.sessionRuntimeBroker.observeRuntimePhase({
    bindingId: command.bindingId,
    bootNonce: live.incarnation.bootNonce,
    endpointFingerprint: live.incarnation.endpointFingerprint,
    event: "begin_dispatch",
    runtimeInstanceId: live.incarnation.runtimeInstanceId,
  });

  let outcome;
  try {
    outcome = await live.entry.runtime.reconfigureThread({
      executionSafety: "standard",
      threadId: command.threadId,
      options: live.configuration.options,
      ...(live.configuration.instructions !== null
        ? { instructions: live.configuration.instructions }
        : {}),
    });
  } catch (error) {
    observeDispatchSettlement({
      bindingId: command.bindingId,
      event: "command_outcome_unknown",
      options,
    });
    return {
      acceptance: "outcome_unknown" as const,
      control: null,
      diagnostic:
        error instanceof Error
          ? error.message
          : "provider reconfiguration outcome is unknown",
      providerRequestId: null,
      providerThreadId: live.providerSession.providerThreadId,
    };
  }

  observeDispatchSettlement({
    bindingId: command.bindingId,
    event:
      outcome.acceptance === "accepted"
        ? "command_completed"
        : outcome.acceptance === "outcome_unknown"
          ? "command_outcome_unknown"
          : "command_rejected",
    options,
  });
  if (outcome.acceptance !== "accepted") {
    return {
      acceptance: outcome.acceptance,
      control: null,
      diagnostic:
        outcome.diagnostic ??
        (outcome.acceptance === "outcome_unknown"
          ? "provider reconfiguration outcome is unknown"
          : "provider rejected removal of the restatement overlay"),
      providerRequestId: outcome.providerRequestId,
      providerThreadId: outcome.providerThreadId,
    };
  }

  const refreshedIncarnation = live.entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const refreshedConfiguration =
    live.entry.runtime.getThreadConfigurationSnapshot(command.threadId);
  if (
    !refreshedIncarnation ||
    !refreshedConfiguration ||
    refreshedConfiguration.executionSafety !== "standard" ||
    refreshedIncarnation.runtimeInstanceId !==
      live.incarnation.runtimeInstanceId ||
    refreshedIncarnation.bootNonce !== live.incarnation.bootNonce ||
    refreshedIncarnation.endpointFingerprint !==
      live.incarnation.endpointFingerprint
  ) {
    throw new ExpectedCommandDispatchError(
      "runtime_incarnation_mismatch",
      "Provider acknowledged reconfiguration but the live destination evidence changed",
    );
  }
  const control =
    options.sessionRuntimeBroker.enableHandoffDestination(command);
  return {
    acceptance: "accepted" as const,
    control,
    diagnostic: null,
    providerRequestId: outcome.providerRequestId,
    providerThreadId: outcome.providerThreadId,
  };
}

export async function changeSessionModel(
  command: CommandOf<"session.model_change">,
  options: CommandDispatchOptions,
): Promise<MutationReceipt> {
  const entry = await options.runtimeManager.getOrAwait(command.environmentId);
  if (!entry || !entry.runtime.hasThread(command.threadId)) {
    return rejectedReceipt({
      diagnostic: `No provider runtime is hosting thread ${command.threadId}`,
      requestedModel: command.requestedModel,
    });
  }
  const providerSession = entry.runtime.getProviderSession(command.threadId);
  if (
    !providerSession ||
    providerSession.providerId !== command.requestedModel.providerId
  ) {
    return rejectedReceipt({
      diagnostic: "requested model provider does not host this thread",
      requestedModel: command.requestedModel,
    });
  }
  const currentOptions = entry.runtime.getThreadExecutionOptions(
    command.threadId,
  );
  if (!currentOptions) {
    return rejectedReceipt({
      diagnostic: "hosted thread has no current runtime configuration",
      requestedModel: command.requestedModel,
    });
  }

  const liveIncarnation = entry.runtime.getProviderRuntimeIncarnation(
    command.threadId,
  );
  const authorization = options.sessionRuntimeBroker.authorizeMutation({
    billingAuthorization: command.billingAuthorization,
    billingRoute: command.billingRoute,
    bindingId: command.bindingId,
    guard: command.guard,
    liveIncarnation,
    nowMs: Date.now(),
    permissionMode: currentOptions.permissionMode,
    requestedModel: command.requestedModel,
    requiresBillingAuthorization: command.requiresBillingAuthorization,
  });
  if (!authorization.ok || !liveIncarnation) {
    return rejectedReceipt({
      diagnostic: authorization.ok
        ? "live runtime incarnation disappeared before dispatch"
        : `${authorization.reason}: ${authorization.detail}`,
      requestedModel: command.requestedModel,
    });
  }

  options.sessionRuntimeBroker.observeRuntimePhase({
    bindingId: command.bindingId,
    bootNonce: liveIncarnation.bootNonce,
    endpointFingerprint: liveIncarnation.endpointFingerprint,
    event: "begin_dispatch",
    runtimeInstanceId: liveIncarnation.runtimeInstanceId,
  });

  const outcome = await entry.runtime.reconfigureThread({
    threadId: command.threadId,
    options: {
      ...currentOptions,
      model: command.requestedModel.modelId,
      reasoningLevel: command.reasoningLevel,
      serviceTier: command.serviceTier,
    },
  });
  const current = options.sessionRuntimeBroker.get(command.bindingId);
  const observedCursor = current?.nativeCursor ?? null;

  if (outcome.acceptance === "accepted") {
    observeDispatchSettlement({
      bindingId: command.bindingId,
      event: "command_completed",
      options,
    });
    return {
      acceptance: "accepted",
      diagnostic: null,
      effectiveAccount: command.billingRoute
        ? {
            accountFingerprint: command.billingRoute.accountFingerprint,
            accountLabel: command.billingRoute.accountLabel,
            providerInstanceId: command.billingRoute.providerInstanceId,
          }
        : null,
      effectiveModel: command.requestedModel,
      observedCursor,
      providerRequestId: outcome.providerRequestId,
      providerTurnId: null,
      requestedModel: command.requestedModel,
    };
  }

  observeDispatchSettlement({
    bindingId: command.bindingId,
    event:
      outcome.acceptance === "outcome_unknown"
        ? "command_outcome_unknown"
        : "command_rejected",
    options,
  });
  return {
    acceptance: outcome.acceptance,
    diagnostic:
      outcome.diagnostic ??
      (outcome.acceptance === "outcome_unknown"
        ? "provider outcome could not be proven"
        : "provider rejected model reconfiguration"),
    effectiveAccount: null,
    effectiveModel: null,
    observedCursor,
    providerRequestId: outcome.providerRequestId,
    providerTurnId: null,
    requestedModel: command.requestedModel,
  };
}

export async function scanDiscoveredSessions(
  command: CommandOf<"session.discovery.scan">,
  options: CommandDispatchOptions,
) {
  return options.sessionDiscoveryCatalog.scan({
    includeUnmapped: command.includeUnmapped,
    limitPerProvider: command.limitPerProvider,
    projectRootPaths: command.projectRootPaths,
    providerCursors: command.providerCursors,
  });
}
