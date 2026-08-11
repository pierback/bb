import type {
  AgentRuntimeExecutionSafety,
  AgentRuntimeProviderProcessIncarnation,
} from "@bb/agent-runtime";
import {
  evaluateMutationGuard,
  evaluateRuntimePhaseLifecycle,
  runtimeOwnershipAllowsMutation,
  runtimePhaseAllowsMutation,
  type BillingAuthorization,
  type BillingRoute,
  type ClientTurnRequestId,
  type ContextCapsuleRestatement,
  type MutationGuard,
  type MutationGuardEvaluation,
  type MutationGuardRejectionReason,
  type PermissionMode,
  type RuntimeMutationPolicy,
  type RuntimeOwnership,
  type RuntimePhase,
  type RuntimePhaseLifecycleEvent,
  type SessionModelRef,
  type SessionWorkspaceState,
} from "@bb/domain";
import {
  SessionRuntimeBrokerStateStorePersistenceError,
  type SessionRuntimeBrokerStateStore,
} from "./session-runtime-broker-state-store.js";
import {
  systemRuntimeProcessProbe,
  type RuntimeProcessProbe,
} from "./session-runtime-process-probe.js";

export interface SessionRuntimeBrokerOptions {
  processProbe?: RuntimeProcessProbe;
  stateStore?: SessionRuntimeBrokerStateStore;
}

const TURN_REQUIRED_PHASES: ReadonlySet<RuntimePhase> = new Set([
  "running",
  "awaiting_interaction",
  "retrying",
  "compacting",
]);

const BROKER_BLOCKING_PHASES: ReadonlySet<RuntimePhase> = new Set([
  "dispatching",
  "quiescing",
  "reconciling",
  "outcome_unknown",
]);

export const sessionRuntimeBrokerErrorCodeValues = [
  "binding_already_exists",
  "binding_not_hosted",
  "control_epoch_mismatch",
  "control_epoch_not_next",
  "execution_safety_read_only",
  "handoff_control_required",
  "handoff_role_mismatch",
  "handoff_transition_mismatch",
  "illegal_phase_transition",
  "mutation_policy_read_only",
  "mutation_policy_mismatch",
  "runtime_incarnation_mismatch",
  "runtime_ownership_read_only",
  "runtime_phase_read_only",
  "runtime_process_alive",
  "runtime_process_identity_unknown",
  "runtime_recovery_unsafe",
  "runtime_replacement_unsafe",
  "thread_binding_ambiguous",
  "turn_required",
  "workspace_mutation_conflict",
] as const;
export type SessionRuntimeBrokerErrorCode =
  (typeof sessionRuntimeBrokerErrorCodeValues)[number];

export class SessionRuntimeBrokerError extends Error {
  constructor(
    readonly code: SessionRuntimeBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionRuntimeBrokerError";
  }
}

export interface SessionRuntimeControlState {
  readonly bindingId: string;
  readonly controlEpoch: number;
  readonly environmentId: string;
  readonly executionSafety: AgentRuntimeExecutionSafety;
  readonly handoffCheckpoint: SessionRuntimeHandoffCheckpoint;
  readonly handoffRole: SessionRuntimeHandoffRole | null;
  readonly handoffTransitionId: string | null;
  readonly incarnation: AgentRuntimeProviderProcessIncarnation;
  readonly mutationPolicy: RuntimeMutationPolicy;
  readonly nativeCursor: string | null;
  readonly ownership: RuntimeOwnership;
  readonly phase: RuntimePhase;
  readonly providerInstanceId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly workspaceId: string;
}

export interface SessionRuntimeHandoffRestatementReceipt {
  readonly capsuleContentHash: string;
  readonly requestId: ClientTurnRequestId;
  readonly restatement: ContextCapsuleRestatement;
  readonly transitionId: string;
  readonly turnId: string;
  readonly workspaceState: Omit<SessionWorkspaceState, "hostId" | "id">;
}

export type SessionRuntimeHandoffRole = "destination" | "source";
export type SessionRuntimeHandoffCheckpoint =
  | "not_applicable"
  | "source_fenced"
  | "destination_staged"
  | "destination_restated";

export type BindManagedRuntimeArgs = Omit<
  SessionRuntimeControlState,
  | "executionSafety"
  | "handoffCheckpoint"
  | "handoffRole"
  | "handoffTransitionId"
> & {
  executionSafety?: AgentRuntimeExecutionSafety;
  handoffCheckpoint?: SessionRuntimeHandoffCheckpoint;
  handoffRole?: SessionRuntimeHandoffRole | null;
  handoffTransitionId?: string | null;
  providerThreadId?: string | null;
  runtimeProcessId?: number | null;
};

export interface SessionRuntimeRecoveryPermit {
  readonly bindingId: string;
  readonly control: SessionRuntimeControlState;
  readonly previousRuntimeProcessId: number;
}

type HandoffRuntimeTerminationEvidence =
  | {
      mode: "exact";
      expectedBootNonce: string;
      expectedControlEpoch: number;
      expectedEndpointFingerprint: string;
      expectedRuntimeInstanceId: string;
    }
  | { mode: "transition" };

interface SessionRuntimeRecoveryReceipt {
  readonly previousControlEpoch: number;
  readonly previousIncarnation: AgentRuntimeProviderProcessIncarnation;
}

export interface ObserveRuntimePhaseArgs {
  bindingId: string;
  bootNonce: string;
  endpointFingerprint: string;
  event: Exclude<RuntimePhaseLifecycleEvent, "runtime_lost">;
  nativeCursor?: string | null;
  runtimeInstanceId: string;
  turnId?: string | null;
}

export interface AuthorizeRuntimeMutationArgs {
  billingAuthorization: BillingAuthorization | null;
  billingRoute: BillingRoute | null;
  bindingId: string;
  guard: MutationGuard;
  liveIncarnation: AgentRuntimeProviderProcessIncarnation | null;
  nowMs: number;
  permissionMode: PermissionMode;
  requestedModel: SessionModelRef;
  requiresBillingAuthorization: boolean;
}

export interface AssertThreadMutationAllowedArgs {
  environmentId: string;
  liveIncarnation?: AgentRuntimeProviderProcessIncarnation | null;
  threadId: string;
}

export const sessionRuntimeBrokerRejectionReasonValues = [
  "binding_not_hosted",
  "live_runtime_missing",
  "mutation_policy_read_only",
  "runtime_record_mismatch",
  "workspace_control_conflict",
] as const;
export type SessionRuntimeBrokerLocalRejectionReason =
  (typeof sessionRuntimeBrokerRejectionReasonValues)[number];
export type SessionRuntimeBrokerRejectionReason =
  | MutationGuardRejectionReason
  | SessionRuntimeBrokerLocalRejectionReason;
export type SessionRuntimeBrokerAuthorization =
  | MutationGuardEvaluation
  | {
      ok: false;
      reason: SessionRuntimeBrokerLocalRejectionReason;
      detail: string;
    };

function sameIncarnation(
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

function sameControlState(
  left: SessionRuntimeControlState,
  right: SessionRuntimeControlState,
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.controlEpoch === right.controlEpoch &&
    left.environmentId === right.environmentId &&
    left.executionSafety === right.executionSafety &&
    left.handoffCheckpoint === right.handoffCheckpoint &&
    left.handoffRole === right.handoffRole &&
    left.handoffTransitionId === right.handoffTransitionId &&
    sameIncarnation(left.incarnation, right.incarnation) &&
    left.mutationPolicy === right.mutationPolicy &&
    left.nativeCursor === right.nativeCursor &&
    left.ownership === right.ownership &&
    left.phase === right.phase &&
    left.providerInstanceId === right.providerInstanceId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.workspaceId === right.workspaceId
  );
}

function freezeControlState(
  state: SessionRuntimeControlState,
): SessionRuntimeControlState {
  return Object.freeze({ ...state });
}

function bindingMayMutateWorkspace(state: SessionRuntimeControlState): boolean {
  if (
    state.mutationPolicy === "staged_read_only" ||
    state.executionSafety === "handoff_restatement"
  ) {
    return false;
  }
  if (state.phase === "terminal" || state.phase === "persisted_only") {
    return false;
  }
  if (
    state.ownership === "unfenced_external" ||
    state.ownership === "unknown"
  ) {
    return true;
  }
  return (
    runtimeOwnershipAllowsMutation(state.ownership) &&
    (runtimePhaseAllowsMutation(state.phase) ||
      BROKER_BLOCKING_PHASES.has(state.phase))
  );
}

function assertHandoffInvariant(state: SessionRuntimeControlState): void {
  if ((state.handoffRole === null) !== (state.handoffTransitionId === null)) {
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `binding ${state.bindingId} must carry both handoff role and transition identity, or neither`,
    );
  }
  if (
    state.executionSafety === "handoff_restatement" &&
    state.handoffRole !== "destination"
  ) {
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `binding ${state.bindingId} can use handoff restatement safety only as a handoff destination`,
    );
  }
  if (
    state.handoffRole === null &&
    state.handoffCheckpoint !== "not_applicable"
  ) {
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `binding ${state.bindingId} cannot carry handoff checkpoint ${state.handoffCheckpoint} without a handoff role`,
    );
  }
  if (
    state.handoffRole === "source" &&
    state.handoffCheckpoint !== "source_fenced"
  ) {
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `source binding ${state.bindingId} must be at the source_fenced checkpoint`,
    );
  }
  if (
    state.handoffRole === "destination" &&
    state.handoffCheckpoint !== "destination_staged" &&
    state.handoffCheckpoint !== "destination_restated"
  ) {
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `destination binding ${state.bindingId} has invalid checkpoint ${state.handoffCheckpoint}`,
    );
  }
}

function assertTurnInvariant(state: SessionRuntimeControlState): void {
  if (TURN_REQUIRED_PHASES.has(state.phase) && state.turnId === null) {
    throw new SessionRuntimeBrokerError(
      "turn_required",
      `phase ${state.phase} requires an active provider turn`,
    );
  }
  if (
    (state.phase === "idle" || state.phase === "terminal") &&
    state.turnId !== null
  ) {
    throw new SessionRuntimeBrokerError(
      "turn_required",
      `phase ${state.phase} cannot retain provider turn ${state.turnId}`,
    );
  }
}

function runtimePhaseAllowsRecovery(
  state: SessionRuntimeControlState,
): boolean {
  if (state.turnId !== null) return false;
  if (state.phase === "idle") return true;
  return (
    state.handoffRole === "destination" &&
    state.executionSafety === "handoff_restatement" &&
    (state.phase === "dispatching" || state.phase === "outcome_unknown")
  );
}

/**
 * Host-local owner of runtime incarnation, control-epoch, phase, and worktree
 * fencing. Server authorization is necessary but this broker makes the final
 * decision immediately before a provider mutation is dispatched.
 */
export class SessionRuntimeBroker {
  private readonly bindings = new Map<string, SessionRuntimeControlState>();
  private readonly handoffRestatementReceipts = new Map<
    string,
    SessionRuntimeHandoffRestatementReceipt
  >();
  private readonly providerThreadIds = new Map<string, string | null>();
  private readonly recoveryPermits =
    new WeakSet<SessionRuntimeRecoveryPermit>();
  private readonly runtimeRecoveryReceipts = new Map<
    string,
    SessionRuntimeRecoveryReceipt
  >();
  private readonly runtimeProcessIds = new Map<string, number | null>();
  private readonly processProbe: RuntimeProcessProbe;
  private readonly stateStore: SessionRuntimeBrokerStateStore | null;

  constructor(options: SessionRuntimeBrokerOptions = {}) {
    this.processProbe = options.processProbe ?? systemRuntimeProcessProbe;
    this.stateStore = options.stateStore ?? null;
    this.loadPersistedState();
  }

  bindManagedRuntime(args: BindManagedRuntimeArgs): SessionRuntimeControlState {
    const {
      providerThreadId = null,
      runtimeProcessId = null,
      ...controlArgs
    } = args;
    const next = freezeControlState({
      ...controlArgs,
      executionSafety: args.executionSafety ?? "standard",
      handoffCheckpoint: args.handoffCheckpoint ?? "not_applicable",
      handoffRole: args.handoffRole ?? null,
      handoffTransitionId: args.handoffTransitionId ?? null,
    });
    assertTurnInvariant(next);
    assertHandoffInvariant(next);
    const existing = this.bindings.get(args.bindingId);
    if (existing) {
      if (sameControlState(existing, next)) {
        const existingProcessId =
          this.runtimeProcessIds.get(args.bindingId) ?? null;
        const existingProviderThreadId =
          this.providerThreadIds.get(args.bindingId) ?? null;
        if (
          existingProcessId !== null &&
          runtimeProcessId !== null &&
          existingProcessId !== runtimeProcessId
        ) {
          throw new SessionRuntimeBrokerError(
            "runtime_incarnation_mismatch",
            `binding ${args.bindingId} incarnation is already associated with process ${existingProcessId}`,
          );
        }
        if (
          existingProviderThreadId !== null &&
          providerThreadId !== null &&
          existingProviderThreadId !== providerThreadId
        ) {
          throw new SessionRuntimeBrokerError(
            "runtime_incarnation_mismatch",
            `binding ${args.bindingId} is already associated with provider thread ${existingProviderThreadId}`,
          );
        }
        if (existingProcessId === null && runtimeProcessId !== null) {
          this.commitStateMutation(() => {
            this.runtimeProcessIds.set(args.bindingId, runtimeProcessId);
            if (
              existingProviderThreadId === null &&
              providerThreadId !== null
            ) {
              this.providerThreadIds.set(args.bindingId, providerThreadId);
            }
          });
        } else if (
          existingProviderThreadId === null &&
          providerThreadId !== null
        ) {
          this.commitStateMutation(() => {
            this.providerThreadIds.set(args.bindingId, providerThreadId);
          });
        }
        return existing;
      }
      if (sameIncarnation(existing.incarnation, next.incarnation)) {
        throw new SessionRuntimeBrokerError(
          "binding_already_exists",
          `binding ${args.bindingId} is already attached to this runtime; use an explicit phase or control-epoch transition`,
        );
      }
      if (existing.phase !== "terminal") {
        throw new SessionRuntimeBrokerError(
          "runtime_replacement_unsafe",
          `binding ${args.bindingId} cannot replace a runtime in phase ${existing.phase}`,
        );
      }
      if (next.controlEpoch !== existing.controlEpoch + 1) {
        throw new SessionRuntimeBrokerError(
          "control_epoch_not_next",
          `replacement epoch ${next.controlEpoch} must follow ${existing.controlEpoch}`,
        );
      }
    }
    this.assertWorkspaceAvailable(next, args.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
      this.providerThreadIds.set(args.bindingId, providerThreadId);
      this.runtimeProcessIds.set(args.bindingId, runtimeProcessId);
      this.handoffRestatementReceipts.delete(args.bindingId);
      this.runtimeRecoveryReceipts.delete(args.bindingId);
    });
    return next;
  }

  get(bindingId: string): SessionRuntimeControlState | null {
    return this.bindings.get(bindingId) ?? null;
  }

  list(): SessionRuntimeControlState[] {
    return [...this.bindings.values()];
  }

  getRuntimeProcessId(bindingId: string): number | null {
    return this.runtimeProcessIds.get(bindingId) ?? null;
  }

  getProviderThreadId(bindingId: string): string | null {
    return this.providerThreadIds.get(bindingId) ?? null;
  }

  getManagedRuntimeRecoveryReplay(args: {
    bindingId: string;
    expectedBootNonce: string;
    expectedControlEpoch: number;
    expectedEndpointFingerprint: string;
    expectedRuntimeInstanceId: string;
  }): SessionRuntimeControlState | null {
    const current = this.requireBinding(args.bindingId);
    const receipt = this.runtimeRecoveryReceipts.get(args.bindingId);
    if (
      !receipt ||
      current.controlEpoch !== args.expectedControlEpoch + 1 ||
      receipt.previousControlEpoch !== args.expectedControlEpoch ||
      receipt.previousIncarnation.bootNonce !== args.expectedBootNonce ||
      receipt.previousIncarnation.endpointFingerprint !==
        args.expectedEndpointFingerprint ||
      receipt.previousIncarnation.runtimeInstanceId !==
        args.expectedRuntimeInstanceId
    ) {
      return null;
    }
    return current;
  }

  /**
   * Proves the exact recorded provider process is gone before any replacement
   * is started. Unknown status (including permission failures) stays fenced.
   */
  prepareManagedRuntimeRecovery(args: {
    bindingId: string;
    expectedBootNonce: string;
    expectedControlEpoch: number;
    expectedEndpointFingerprint: string;
    expectedRuntimeInstanceId: string;
  }): SessionRuntimeRecoveryPermit {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, {
      bootNonce: args.expectedBootNonce,
      endpointFingerprint: args.expectedEndpointFingerprint,
      runtimeInstanceId: args.expectedRuntimeInstanceId,
    });
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (!runtimePhaseAllowsRecovery(current)) {
      throw new SessionRuntimeBrokerError(
        "runtime_recovery_unsafe",
        `binding ${args.bindingId} cannot recover from phase ${current.phase} with turn ${current.turnId ?? "none"}`,
      );
    }
    const previousRuntimeProcessId =
      this.runtimeProcessIds.get(args.bindingId) ?? null;
    if (previousRuntimeProcessId === null) {
      throw new SessionRuntimeBrokerError(
        "runtime_process_identity_unknown",
        `binding ${args.bindingId} has no recorded provider process identity`,
      );
    }
    const status = this.processProbe.getIdentityStatus(
      previousRuntimeProcessId,
    );
    if (status === "alive") {
      throw new SessionRuntimeBrokerError(
        "runtime_process_alive",
        `binding ${args.bindingId} provider process ${previousRuntimeProcessId} is still alive`,
      );
    }
    if (status !== "dead") {
      throw new SessionRuntimeBrokerError(
        "runtime_process_identity_unknown",
        `binding ${args.bindingId} provider process ${previousRuntimeProcessId} could not be proven dead`,
      );
    }
    const permit = Object.freeze({
      bindingId: args.bindingId,
      control: current,
      previousRuntimeProcessId,
    });
    this.recoveryPermits.add(permit);
    return permit;
  }

  /** Completes a prepared recovery as one durable incarnation/epoch swap. */
  completeManagedRuntimeRecovery(args: {
    incarnation: AgentRuntimeProviderProcessIncarnation;
    permit: SessionRuntimeRecoveryPermit;
    providerThreadId: string;
    runtimeProcessId: number;
  }): SessionRuntimeControlState {
    if (!this.recoveryPermits.delete(args.permit)) {
      throw new SessionRuntimeBrokerError(
        "runtime_recovery_unsafe",
        `binding ${args.permit.bindingId} recovery permit is invalid or already consumed`,
      );
    }
    const current = this.requireBinding(args.permit.bindingId);
    if (current !== args.permit.control) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${current.bindingId} changed while runtime recovery was in progress`,
      );
    }
    if (
      args.incarnation.providerId !== current.incarnation.providerId ||
      args.incarnation.connectorId !== current.incarnation.connectorId ||
      args.incarnation.processKey !== current.incarnation.processKey ||
      sameIncarnation(args.incarnation, current.incarnation)
    ) {
      throw new SessionRuntimeBrokerError(
        "runtime_incarnation_mismatch",
        `binding ${current.bindingId} recovery did not create a new equivalent provider process incarnation`,
      );
    }
    const expectedProviderThreadId =
      this.providerThreadIds.get(current.bindingId) ?? null;
    if (
      expectedProviderThreadId !== null &&
      expectedProviderThreadId !== args.providerThreadId
    ) {
      throw new SessionRuntimeBrokerError(
        "runtime_incarnation_mismatch",
        `binding ${current.bindingId} recovered provider conversation ${args.providerThreadId}, not ${expectedProviderThreadId}`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      incarnation: args.incarnation,
      phase: "idle" as const,
      turnId: null,
    });
    this.assertWorkspaceAvailable(next, current.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(current.bindingId, next);
      this.providerThreadIds.set(current.bindingId, args.providerThreadId);
      this.runtimeProcessIds.set(current.bindingId, args.runtimeProcessId);
      this.runtimeRecoveryReceipts.set(current.bindingId, {
        previousControlEpoch: current.controlEpoch,
        previousIncarnation: current.incarnation,
      });
    });
    return next;
  }

  /**
   * Final host-local fence for ordinary thread commands. Unadopted bb threads
   * remain usable; once a thread is brokered, every provider turn must honor
   * the binding's mutation policy, ownership, phase, live incarnation, and
   * worktree exclusivity.
   */
  assertThreadMutationAllowed(
    args: AssertThreadMutationAllowedArgs,
  ): SessionRuntimeControlState | null {
    const candidates = [...this.bindings.values()].filter(
      (state) =>
        state.environmentId === args.environmentId &&
        state.threadId === args.threadId,
    );
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length !== 1) {
      throw new SessionRuntimeBrokerError(
        "thread_binding_ambiguous",
        `thread ${args.threadId} has ${candidates.length} live broker bindings`,
      );
    }
    const current = candidates[0]!;
    if (current.mutationPolicy !== "enabled") {
      throw new SessionRuntimeBrokerError(
        "mutation_policy_read_only",
        `binding ${current.bindingId} is staged read-only`,
      );
    }
    if (current.executionSafety !== "standard") {
      throw new SessionRuntimeBrokerError(
        "execution_safety_read_only",
        `binding ${current.bindingId} is still under the handoff restatement isolation overlay`,
      );
    }
    if (!runtimeOwnershipAllowsMutation(current.ownership)) {
      throw new SessionRuntimeBrokerError(
        "runtime_ownership_read_only",
        `binding ${current.bindingId} ownership ${current.ownership} is read-only`,
      );
    }
    if (!runtimePhaseAllowsMutation(current.phase)) {
      throw new SessionRuntimeBrokerError(
        "runtime_phase_read_only",
        `binding ${current.bindingId} phase ${current.phase} does not admit thread mutation`,
      );
    }
    if (
      args.liveIncarnation !== undefined &&
      (args.liveIncarnation === null ||
        !sameIncarnation(current.incarnation, args.liveIncarnation))
    ) {
      throw new SessionRuntimeBrokerError(
        "runtime_incarnation_mismatch",
        `thread ${args.threadId} is not running on binding ${current.bindingId}'s exact incarnation`,
      );
    }
    this.assertWorkspaceAvailable(current, current.bindingId);
    return current;
  }

  advanceControlEpoch(args: {
    bindingId: string;
    expectedControlEpoch: number;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
    });
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  /** Exact-CAS local fence; identical retries return the already-applied state. */
  setMutationPolicy(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    expectedMutationPolicy: RuntimeMutationPolicy;
    nextMutationPolicy: RuntimeMutationPolicy;
    runtimeInstanceId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    if (current.handoffTransitionId !== null) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} belongs to handoff ${current.handoffTransitionId}; use a handoff-scoped control transition`,
      );
    }
    if (args.expectedMutationPolicy === args.nextMutationPolicy) {
      throw new SessionRuntimeBrokerError(
        "mutation_policy_mismatch",
        `binding ${args.bindingId} mutation-policy transition must change policy`,
      );
    }
    if (
      current.controlEpoch === args.expectedControlEpoch + 1 &&
      current.mutationPolicy === args.nextMutationPolicy
    ) {
      return current;
    }
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (current.mutationPolicy !== args.expectedMutationPolicy) {
      throw new SessionRuntimeBrokerError(
        "mutation_policy_mismatch",
        `binding ${args.bindingId} is ${current.mutationPolicy}, not ${args.expectedMutationPolicy}`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      mutationPolicy: args.nextMutationPolicy,
    });
    this.assertWorkspaceAvailable(next, args.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  /** Exact-CAS source fence that cannot be cleared by the generic policy RPC. */
  fenceHandoffSource(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    if (
      current.controlEpoch === args.expectedControlEpoch + 1 &&
      current.mutationPolicy === "staged_read_only" &&
      current.executionSafety === "standard" &&
      current.handoffCheckpoint === "source_fenced" &&
      current.handoffRole === "source" &&
      current.handoffTransitionId === args.transitionId
    ) {
      return current;
    }
    this.assertUnclaimedHandoffBinding(current, args.transitionId);
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (current.mutationPolicy !== "enabled") {
      throw new SessionRuntimeBrokerError(
        "mutation_policy_mismatch",
        `binding ${args.bindingId} is ${current.mutationPolicy}, not enabled`,
      );
    }
    if (current.executionSafety !== "standard") {
      throw new SessionRuntimeBrokerError(
        "execution_safety_read_only",
        `binding ${args.bindingId} cannot become a handoff source from ${current.executionSafety}`,
      );
    }
    if (current.phase !== "idle" || current.turnId !== null) {
      throw new SessionRuntimeBrokerError(
        "runtime_phase_read_only",
        `binding ${args.bindingId} must be idle before it can be fenced as a handoff source`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      handoffCheckpoint: "source_fenced" as const,
      handoffRole: "source" as const,
      handoffTransitionId: args.transitionId,
      mutationPolicy: "staged_read_only" as const,
    });
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  /** Proves source settlement is observing the exact durable handoff fence. */
  assertHandoffSourceFenced(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "source",
      transitionId: args.transitionId,
    });
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (
      current.executionSafety !== "standard" ||
      current.handoffCheckpoint !== "source_fenced" ||
      current.mutationPolicy !== "staged_read_only" ||
      current.phase !== "idle" ||
      current.turnId !== null
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not an idle fenced handoff source`,
      );
    }
    return current;
  }

  /**
   * Reopens a source only while its handoff is still at the reversible fence.
   * The handoff identity is cleared atomically with the epoch increment so the
   * generic policy RPC can never partially undo a handoff fence.
   */
  restoreHandoffSource(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    if (
      current.controlEpoch === args.expectedControlEpoch + 1 &&
      current.mutationPolicy === "enabled" &&
      current.executionSafety === "standard" &&
      current.handoffCheckpoint === "not_applicable" &&
      current.handoffRole === null &&
      current.handoffTransitionId === null &&
      current.phase === "idle" &&
      current.turnId === null
    ) {
      return current;
    }
    this.assertHandoffIdentity(current, {
      role: "source",
      transitionId: args.transitionId,
    });
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "standard" ||
      current.handoffCheckpoint !== "source_fenced"
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not a standard fenced handoff source`,
      );
    }
    if (current.phase !== "idle" || current.turnId !== null) {
      throw new SessionRuntimeBrokerError(
        "runtime_phase_read_only",
        `binding ${args.bindingId} must be idle before its handoff fence can be restored`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      handoffCheckpoint: "not_applicable" as const,
      handoffRole: null,
      handoffTransitionId: null,
      mutationPolicy: "enabled" as const,
    });
    this.assertWorkspaceAvailable(next, args.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  /**
   * Tombstones an abandoned destination before the durable handoff abort.
   * Transition-only evidence is reserved for the response-loss window before
   * the server has persisted the host-created destination incarnation.
   */
  discardHandoffDestination(args: {
    bindingId: string;
    environmentId: string;
    evidence: HandoffRuntimeTerminationEvidence;
    liveIncarnation: AgentRuntimeProviderProcessIncarnation | null;
    threadId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    return this.terminateHandoffRuntime({
      ...args,
      role: "destination",
    });
  }

  /** Tombstones the exact fenced source before its binding is closed. */
  retireHandoffSource(args: {
    bindingId: string;
    environmentId: string;
    evidence: Extract<HandoffRuntimeTerminationEvidence, { mode: "exact" }>;
    liveIncarnation: AgentRuntimeProviderProcessIncarnation | null;
    threadId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    return this.terminateHandoffRuntime({
      ...args,
      role: "source",
    });
  }

  /** Proves that a restatement turn still targets the exact staged runtime. */
  assertHandoffDestinationStaged(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (current.mutationPolicy !== "staged_read_only") {
      throw new SessionRuntimeBrokerError(
        "mutation_policy_mismatch",
        `binding ${args.bindingId} is ${current.mutationPolicy}, not staged_read_only`,
      );
    }
    if (current.executionSafety !== "handoff_restatement") {
      throw new SessionRuntimeBrokerError(
        "execution_safety_read_only",
        `binding ${args.bindingId} is not under the handoff restatement isolation overlay`,
      );
    }
    if (current.handoffCheckpoint !== "destination_staged") {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is at handoff checkpoint ${current.handoffCheckpoint}, not destination_staged`,
      );
    }
    if (current.phase !== "idle" || current.turnId !== null) {
      throw new SessionRuntimeBrokerError(
        "runtime_phase_read_only",
        `binding ${args.bindingId} must be idle before destination restatement`,
      );
    }
    return current;
  }

  /** Proves that an enable attempt still targets the verified destination. */
  assertHandoffDestinationRestated(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "handoff_restatement" ||
      current.handoffCheckpoint !== "destination_restated"
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not an isolated restated destination`,
      );
    }
    if (current.phase !== "idle" || current.turnId !== null) {
      throw new SessionRuntimeBrokerError(
        "runtime_phase_read_only",
        `binding ${args.bindingId} must be idle before destination enablement`,
      );
    }
    return current;
  }

  /** Records the verified, terminal no-tools restatement as an epoch CAS. */
  markHandoffDestinationRestated(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
    receipt: SessionRuntimeHandoffRestatementReceipt;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (
      current.controlEpoch === args.expectedControlEpoch + 1 &&
      current.handoffCheckpoint === "destination_restated" &&
      current.mutationPolicy === "staged_read_only" &&
      current.executionSafety === "handoff_restatement"
    ) {
      this.assertMatchingRestatementReceipt(current, args.receipt);
      return current;
    }
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (
      current.handoffCheckpoint !== "destination_staged" ||
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "handoff_restatement" ||
      current.phase !== "idle" ||
      current.turnId !== null
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not an idle isolated staged destination`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      handoffCheckpoint: "destination_restated" as const,
    });
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
      this.handoffRestatementReceipts.set(args.bindingId, args.receipt);
    });
    return next;
  }

  /** Returns the exact verified result for a lost-response replay. */
  getHandoffDestinationRestatement(args: {
    bindingId: string;
    bootNonce: string;
    capsuleContentHash: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    requestId: ClientTurnRequestId;
    runtimeInstanceId: string;
    transitionId: string;
  }): {
    control: SessionRuntimeControlState;
    receipt: SessionRuntimeHandoffRestatementReceipt;
  } | null {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (
      current.controlEpoch === args.expectedControlEpoch &&
      current.handoffCheckpoint === "destination_staged"
    ) {
      return null;
    }
    if (
      current.controlEpoch !== args.expectedControlEpoch + 1 ||
      current.handoffCheckpoint !== "destination_restated" ||
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "handoff_restatement"
    ) {
      return null;
    }
    const receipt = this.handoffRestatementReceipts.get(args.bindingId);
    if (!receipt) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is restated without its replay receipt`,
      );
    }
    this.assertMatchingRestatementReceipt(current, {
      ...receipt,
      capsuleContentHash: args.capsuleContentHash,
      requestId: args.requestId,
      transitionId: args.transitionId,
    });
    return { control: current, receipt };
  }

  /**
   * A no-tools restatement may be replayed after an unknown transport result
   * only once the same runtime is idle. The caller separately rechecks the
   * sealed workspace digest before clearing the phase fence.
   */
  prepareHandoffDestinationRestatementRetry(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    return this.prepareHandoffDestinationDispatchRetry({
      ...args,
      checkpoint: "destination_staged",
    });
  }

  /** Configuration-only enablement is an exact replay while no turn runs. */
  prepareHandoffDestinationEnableRetry(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    return this.prepareHandoffDestinationDispatchRetry({
      ...args,
      checkpoint: "destination_restated",
    });
  }

  /**
   * Opens destination mutation only after the provider acknowledged removal of
   * the restatement overlay. Identical retries return the applied state.
   */
  enableHandoffDestination(args: {
    bindingId: string;
    bootNonce: string;
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (
      current.controlEpoch === args.expectedControlEpoch + 1 &&
      current.mutationPolicy === "enabled" &&
      current.executionSafety === "standard" &&
      current.handoffCheckpoint === "destination_restated"
    ) {
      return current;
    }
    if (current.controlEpoch !== args.expectedControlEpoch) {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.expectedControlEpoch}`,
      );
    }
    if (
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "handoff_restatement" ||
      current.handoffCheckpoint !== "destination_restated"
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not an isolated staged destination`,
      );
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      executionSafety: "standard" as const,
      mutationPolicy: "enabled" as const,
    });
    this.assertWorkspaceAvailable(next, args.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  observeRuntimePhase(
    args: ObserveRuntimePhaseArgs,
  ): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    const transition = evaluateRuntimePhaseLifecycle({
      event: args.event,
      phase: current.phase,
    });
    if ("noop" in transition) {
      throw new SessionRuntimeBrokerError(
        "illegal_phase_transition",
        transition.detail,
      );
    }

    let turnId = args.turnId === undefined ? current.turnId : args.turnId;
    if (transition.to === "idle" || transition.to === "terminal") {
      turnId = null;
    }
    const next = freezeControlState({
      ...current,
      phase: transition.to,
      turnId,
      nativeCursor:
        args.nativeCursor === undefined
          ? current.nativeCursor
          : args.nativeCursor,
    });
    assertTurnInvariant(next);
    this.assertWorkspaceAvailable(next, args.bindingId);
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  markRuntimeLost(
    incarnation: AgentRuntimeProviderProcessIncarnation,
  ): SessionRuntimeControlState[] {
    return this.commitStateMutation(() => {
      const affected: SessionRuntimeControlState[] = [];
      for (const [bindingId, current] of this.bindings) {
        if (!sameIncarnation(current.incarnation, incarnation)) {
          continue;
        }
        if (current.phase === "terminal") {
          continue;
        }
        // An idle runtime has not accepted work, so its exact dead PID is the
        // fence and recovery owns the sole epoch increment. Keeping the phase
        // idle also distinguishes provider loss from an explicit stop, which
        // already transitions the binding to terminal.
        if (current.phase === "idle") {
          affected.push(current);
          continue;
        }
        const transition = evaluateRuntimePhaseLifecycle({
          event: "runtime_lost",
          phase: current.phase,
        });
        if ("noop" in transition) {
          continue;
        }
        const isolatedReplayableLoss =
          current.handoffRole === "destination" &&
          current.executionSafety === "handoff_restatement" &&
          transition.to === "outcome_unknown";
        const next = freezeControlState({
          ...current,
          controlEpoch: isolatedReplayableLoss
            ? current.controlEpoch
            : current.controlEpoch + 1,
          phase: transition.to,
          turnId:
            transition.to === "terminal" || isolatedReplayableLoss
              ? null
              : current.turnId,
        });
        this.bindings.set(bindingId, next);
        affected.push(next);
      }
      return affected;
    });
  }

  private terminateHandoffRuntime(args: {
    bindingId: string;
    environmentId: string;
    evidence: HandoffRuntimeTerminationEvidence;
    liveIncarnation: AgentRuntimeProviderProcessIncarnation | null;
    role: SessionRuntimeHandoffRole;
    threadId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    if (
      current.environmentId !== args.environmentId ||
      current.threadId !== args.threadId
    ) {
      throw new SessionRuntimeBrokerError(
        "binding_not_hosted",
        `binding ${args.bindingId} does not host ${args.environmentId}/${args.threadId}`,
      );
    }
    this.assertHandoffIdentity(current, {
      role: args.role,
      transitionId: args.transitionId,
    });
    if (args.evidence.mode === "exact") {
      this.assertIncarnation(current, {
        bootNonce: args.evidence.expectedBootNonce,
        endpointFingerprint: args.evidence.expectedEndpointFingerprint,
        runtimeInstanceId: args.evidence.expectedRuntimeInstanceId,
      });
      if (
        current.phase === "terminal" &&
        current.controlEpoch === args.evidence.expectedControlEpoch + 1
      ) {
        return current;
      }
      if (current.controlEpoch !== args.evidence.expectedControlEpoch) {
        throw new SessionRuntimeBrokerError(
          "control_epoch_mismatch",
          `binding ${args.bindingId} is at epoch ${current.controlEpoch}, not ${args.evidence.expectedControlEpoch}`,
        );
      }
    } else if (current.phase === "terminal") {
      return current;
    }
    if (current.phase === "terminal") {
      throw new SessionRuntimeBrokerError(
        "control_epoch_mismatch",
        `binding ${args.bindingId} terminal tombstone does not match the requested epoch`,
      );
    }
    if (
      current.mutationPolicy !== "staged_read_only" ||
      (args.role === "source" &&
        (current.executionSafety !== "standard" ||
          current.handoffCheckpoint !== "source_fenced" ||
          current.phase !== "idle" ||
          current.turnId !== null)) ||
      (args.role === "destination" &&
        (current.executionSafety !== "handoff_restatement" ||
          (current.handoffCheckpoint !== "destination_staged" &&
            current.handoffCheckpoint !== "destination_restated")))
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} is not a terminable ${args.role} for handoff ${args.transitionId}`,
      );
    }
    if (
      args.liveIncarnation !== null &&
      !sameIncarnation(current.incarnation, args.liveIncarnation)
    ) {
      throw new SessionRuntimeBrokerError(
        "runtime_incarnation_mismatch",
        `binding ${args.bindingId} termination targeted a different live incarnation`,
      );
    }
    if (args.liveIncarnation === null) {
      const runtimeProcessId =
        this.runtimeProcessIds.get(args.bindingId) ?? null;
      if (runtimeProcessId === null) {
        throw new SessionRuntimeBrokerError(
          "runtime_process_identity_unknown",
          `binding ${args.bindingId} has no provider process identity for termination`,
        );
      }
      const status = this.processProbe.getIdentityStatus(runtimeProcessId);
      if (status === "alive") {
        throw new SessionRuntimeBrokerError(
          "runtime_process_alive",
          `binding ${args.bindingId} provider process ${runtimeProcessId} is alive but not controllable`,
        );
      }
      if (status !== "dead") {
        throw new SessionRuntimeBrokerError(
          "runtime_process_identity_unknown",
          `binding ${args.bindingId} provider process ${runtimeProcessId} could not be proven dead`,
        );
      }
    }
    const next = freezeControlState({
      ...current,
      controlEpoch: current.controlEpoch + 1,
      phase: "terminal" as const,
      turnId: null,
    });
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  authorizeMutation(
    args: AuthorizeRuntimeMutationArgs,
  ): SessionRuntimeBrokerAuthorization {
    const current = this.bindings.get(args.bindingId);
    if (!current) {
      return {
        ok: false,
        reason: "binding_not_hosted",
        detail: `binding ${args.bindingId} is not hosted by this broker`,
      };
    }
    if (current.mutationPolicy === "staged_read_only") {
      return {
        ok: false,
        reason: "mutation_policy_read_only",
        detail: `binding ${args.bindingId} is staged read-only`,
      };
    }
    if (!args.liveIncarnation) {
      return {
        ok: false,
        reason: "live_runtime_missing",
        detail: `binding ${args.bindingId} has no live provider runtime`,
      };
    }
    if (!sameIncarnation(current.incarnation, args.liveIncarnation)) {
      return {
        ok: false,
        reason: "runtime_record_mismatch",
        detail:
          "live provider runtime does not match the broker control record",
      };
    }
    const conflicting = this.findWorkspaceConflict(current, args.bindingId);
    if (conflicting) {
      return {
        ok: false,
        reason: "workspace_control_conflict",
        detail: `binding ${conflicting.bindingId} may still mutate workspace ${current.workspaceId}`,
      };
    }

    return evaluateMutationGuard({
      guard: args.guard,
      target: {
        billingAuthorization: args.billingAuthorization,
        billingRoute: args.billingRoute,
        bootNonce: args.liveIncarnation.bootNonce,
        controlEpoch: current.controlEpoch,
        endpointFingerprint: args.liveIncarnation.endpointFingerprint,
        nativeCursor: current.nativeCursor,
        nowMs: args.nowMs,
        ownership: current.ownership,
        permissionMode: args.permissionMode,
        phase: current.phase,
        providerInstanceId: current.providerInstanceId,
        requestedModel: args.requestedModel,
        requiresBillingAuthorization: args.requiresBillingAuthorization,
        runtimeInstanceId: args.liveIncarnation.runtimeInstanceId,
        turnId: current.turnId,
      },
    });
  }

  private loadPersistedState(): void {
    const persisted = this.stateStore?.load();
    if (!persisted) return;
    for (const entry of persisted.bindings) {
      if (this.bindings.has(entry.control.bindingId)) {
        throw new Error(
          `Session Runtime Broker state contains duplicate binding ${entry.control.bindingId}`,
        );
      }
      const control = freezeControlState(entry.control);
      assertTurnInvariant(control);
      assertHandoffInvariant(control);
      this.bindings.set(control.bindingId, control);
      this.providerThreadIds.set(control.bindingId, entry.providerThreadId);
      this.runtimeProcessIds.set(control.bindingId, entry.runtimeProcessId);
    }
    for (const entry of persisted.handoffRestatementReceipts) {
      if (this.handoffRestatementReceipts.has(entry.bindingId)) {
        throw new Error(
          `Session Runtime Broker state contains duplicate restatement receipt for ${entry.bindingId}`,
        );
      }
      const control = this.bindings.get(entry.bindingId);
      if (
        !control ||
        control.handoffRole !== "destination" ||
        control.handoffCheckpoint !== "destination_restated" ||
        control.handoffTransitionId !== entry.transitionId
      ) {
        throw new Error(
          `Session Runtime Broker restatement receipt does not match binding ${entry.bindingId}`,
        );
      }
      const { bindingId: _bindingId, ...receipt } = entry;
      this.handoffRestatementReceipts.set(entry.bindingId, receipt);
    }
    for (const entry of persisted.runtimeRecoveryReceipts) {
      if (this.runtimeRecoveryReceipts.has(entry.bindingId)) {
        throw new Error(
          `Session Runtime Broker state contains duplicate recovery receipt for ${entry.bindingId}`,
        );
      }
      const control = this.bindings.get(entry.bindingId);
      if (
        !control ||
        control.controlEpoch < entry.previousControlEpoch + 1 ||
        sameIncarnation(control.incarnation, entry.previousIncarnation)
      ) {
        throw new Error(
          `Session Runtime Broker recovery receipt does not match binding ${entry.bindingId}`,
        );
      }
      const { bindingId: _bindingId, ...receipt } = entry;
      this.runtimeRecoveryReceipts.set(entry.bindingId, receipt);
    }
    for (const control of this.bindings.values()) {
      if (
        control.handoffRole === "destination" &&
        control.handoffCheckpoint === "destination_restated" &&
        !this.handoffRestatementReceipts.has(control.bindingId)
      ) {
        throw new Error(
          `Session Runtime Broker binding ${control.bindingId} is restated without a replay receipt`,
        );
      }
      this.assertWorkspaceAvailable(control, control.bindingId);
    }
  }

  private commitStateMutation<TResult>(mutation: () => TResult): TResult {
    const previousBindings = new Map(this.bindings);
    const previousProviderThreadIds = new Map(this.providerThreadIds);
    const previousProcessIds = new Map(this.runtimeProcessIds);
    const previousReceipts = new Map(this.handoffRestatementReceipts);
    const previousRecoveryReceipts = new Map(this.runtimeRecoveryReceipts);
    try {
      const result = mutation();
      this.persistState();
      return result;
    } catch (error) {
      if (
        error instanceof SessionRuntimeBrokerStateStorePersistenceError &&
        error.stateMayBeCommitted
      ) {
        throw error;
      }
      this.bindings.clear();
      this.providerThreadIds.clear();
      this.runtimeProcessIds.clear();
      this.handoffRestatementReceipts.clear();
      this.runtimeRecoveryReceipts.clear();
      for (const [bindingId, control] of previousBindings) {
        this.bindings.set(bindingId, control);
      }
      for (const [bindingId, processId] of previousProcessIds) {
        this.runtimeProcessIds.set(bindingId, processId);
      }
      for (const [bindingId, providerThreadId] of previousProviderThreadIds) {
        this.providerThreadIds.set(bindingId, providerThreadId);
      }
      for (const [bindingId, receipt] of previousReceipts) {
        this.handoffRestatementReceipts.set(bindingId, receipt);
      }
      for (const [bindingId, receipt] of previousRecoveryReceipts) {
        this.runtimeRecoveryReceipts.set(bindingId, receipt);
      }
      throw error;
    }
  }

  private persistState(): void {
    if (this.stateStore === null) return;
    this.stateStore.save({
      bindings: [...this.bindings.values()].map((control) => ({
        control,
        providerThreadId: this.providerThreadIds.get(control.bindingId) ?? null,
        runtimeProcessId: this.runtimeProcessIds.get(control.bindingId) ?? null,
      })),
      handoffRestatementReceipts: [
        ...this.handoffRestatementReceipts.entries(),
      ].map(([bindingId, receipt]) => ({ bindingId, ...receipt })),
      runtimeRecoveryReceipts: [...this.runtimeRecoveryReceipts.entries()].map(
        ([bindingId, receipt]) => ({ bindingId, ...receipt }),
      ),
    });
  }

  private requireBinding(bindingId: string): SessionRuntimeControlState {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      throw new SessionRuntimeBrokerError(
        "binding_not_hosted",
        `binding ${bindingId} is not hosted by this broker`,
      );
    }
    return binding;
  }

  private assertIncarnation(
    current: SessionRuntimeControlState,
    observed: Pick<
      ObserveRuntimePhaseArgs,
      "bootNonce" | "endpointFingerprint" | "runtimeInstanceId"
    >,
  ): void {
    if (
      current.incarnation.runtimeInstanceId !== observed.runtimeInstanceId ||
      current.incarnation.bootNonce !== observed.bootNonce ||
      current.incarnation.endpointFingerprint !== observed.endpointFingerprint
    ) {
      throw new SessionRuntimeBrokerError(
        "runtime_incarnation_mismatch",
        `runtime observation does not belong to binding ${current.bindingId}`,
      );
    }
  }

  private assertHandoffIdentity(
    current: SessionRuntimeControlState,
    expected: {
      role: SessionRuntimeHandoffRole;
      transitionId: string;
    },
  ): void {
    if (current.handoffTransitionId !== expected.transitionId) {
      throw new SessionRuntimeBrokerError(
        "handoff_transition_mismatch",
        `binding ${current.bindingId} belongs to handoff ${current.handoffTransitionId ?? "none"}, not ${expected.transitionId}`,
      );
    }
    if (current.handoffRole !== expected.role) {
      throw new SessionRuntimeBrokerError(
        "handoff_role_mismatch",
        `binding ${current.bindingId} is handoff role ${current.handoffRole ?? "none"}, not ${expected.role}`,
      );
    }
  }

  private assertMatchingRestatementReceipt(
    current: SessionRuntimeControlState,
    receipt: SessionRuntimeHandoffRestatementReceipt,
  ): void {
    const existing = this.handoffRestatementReceipts.get(current.bindingId);
    if (
      receipt.transitionId !== current.handoffTransitionId ||
      (existing !== undefined &&
        (existing.capsuleContentHash !== receipt.capsuleContentHash ||
          existing.requestId !== receipt.requestId ||
          existing.transitionId !== receipt.transitionId ||
          existing.turnId !== receipt.turnId ||
          JSON.stringify(existing.restatement) !==
            JSON.stringify(receipt.restatement) ||
          JSON.stringify(existing.workspaceState) !==
            JSON.stringify(receipt.workspaceState)))
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_transition_mismatch",
        `binding ${current.bindingId} restatement replay evidence differs from its verified receipt`,
      );
    }
  }

  private prepareHandoffDestinationDispatchRetry(args: {
    bindingId: string;
    bootNonce: string;
    checkpoint: "destination_restated" | "destination_staged";
    endpointFingerprint: string;
    expectedControlEpoch: number;
    runtimeInstanceId: string;
    transitionId: string;
  }): SessionRuntimeControlState {
    const current = this.requireBinding(args.bindingId);
    this.assertIncarnation(current, args);
    this.assertHandoffIdentity(current, {
      role: "destination",
      transitionId: args.transitionId,
    });
    if (
      current.controlEpoch !== args.expectedControlEpoch ||
      current.handoffCheckpoint !== args.checkpoint ||
      current.mutationPolicy !== "staged_read_only" ||
      current.executionSafety !== "handoff_restatement" ||
      current.phase !== "outcome_unknown" ||
      current.turnId !== null
    ) {
      throw new SessionRuntimeBrokerError(
        "handoff_control_required",
        `binding ${args.bindingId} cannot replay ${args.checkpoint} from phase ${current.phase}`,
      );
    }
    const next = freezeControlState({ ...current, phase: "idle" as const });
    this.commitStateMutation(() => {
      this.bindings.set(args.bindingId, next);
    });
    return next;
  }

  private assertUnclaimedHandoffBinding(
    current: SessionRuntimeControlState,
    transitionId: string,
  ): void {
    if (
      current.handoffTransitionId === null &&
      current.handoffRole === null &&
      current.handoffCheckpoint === "not_applicable"
    ) {
      return;
    }
    if (current.handoffTransitionId !== transitionId) {
      throw new SessionRuntimeBrokerError(
        "handoff_transition_mismatch",
        `binding ${current.bindingId} already belongs to handoff ${current.handoffTransitionId}`,
      );
    }
    throw new SessionRuntimeBrokerError(
      "handoff_role_mismatch",
      `binding ${current.bindingId} is already claimed as handoff ${current.handoffRole}`,
    );
  }

  private assertWorkspaceAvailable(
    candidate: SessionRuntimeControlState,
    excludingBindingId: string,
  ): void {
    if (!bindingMayMutateWorkspace(candidate)) {
      return;
    }
    const conflict = this.findWorkspaceConflict(candidate, excludingBindingId);
    if (conflict) {
      throw new SessionRuntimeBrokerError(
        "workspace_mutation_conflict",
        `binding ${conflict.bindingId} may still mutate workspace ${candidate.workspaceId}`,
      );
    }
  }

  private findWorkspaceConflict(
    candidate: SessionRuntimeControlState,
    excludingBindingId: string,
  ): SessionRuntimeControlState | null {
    for (const other of this.bindings.values()) {
      if (
        other.bindingId !== excludingBindingId &&
        other.workspaceId === candidate.workspaceId &&
        bindingMayMutateWorkspace(other)
      ) {
        return other;
      }
    }
    return null;
  }
}
