import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProviderProcessIncarnation } from "@bb/agent-runtime";
import type { MutationGuard } from "@bb/domain";
import {
  SessionRuntimeBroker,
  SessionRuntimeBrokerError,
  type BindManagedRuntimeArgs,
} from "./session-runtime-broker.js";

const firstIncarnation: AgentRuntimeProviderProcessIncarnation = {
  bootNonce: "boot_nonce_1234567890",
  connectorId: "codex-app-server",
  endpointFingerprint: "stdio:first",
  processKey: "codex\0thread:thread_1",
  providerId: "codex",
  runtimeInstanceId: "runtime_1",
  startedAt: 1_000,
};

const secondIncarnation: AgentRuntimeProviderProcessIncarnation = {
  bootNonce: "boot_nonce_0987654321",
  connectorId: "codex-app-server",
  endpointFingerprint: "stdio:second",
  processKey: "codex\0thread:thread_1",
  providerId: "codex",
  runtimeInstanceId: "runtime_2",
  startedAt: 2_000,
};

const binding: BindManagedRuntimeArgs = {
  bindingId: "binding_1",
  controlEpoch: 7,
  environmentId: "environment_1",
  executionSafety: "standard",
  handoffCheckpoint: "not_applicable",
  handoffRole: null,
  handoffTransitionId: null,
  incarnation: firstIncarnation,
  mutationPolicy: "enabled",
  nativeCursor: "cursor_10",
  ownership: "owned_brokered",
  phase: "idle",
  providerInstanceId: "provider_instance_1",
  threadId: "thread_1",
  turnId: null,
  workspaceId: "workspace_1",
};

const restatementReceipt = {
  capsuleContentHash:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  requestId: "creq_23456789ab" as const,
  restatement: {
    ambiguities: [],
    capsuleContentHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    constraints: [],
    decisions: [],
    destinationToolDifferences: [],
    expectedWorkspace: {
      diffDigest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      digestAlgorithm: "sha256",
      headSha: "head",
      indexDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      rootPath: "/workspace",
      untrackedManifestDigest:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      worktreeId: "worktree_1",
    },
    objective: "Continue safely",
    openTasks: [],
  },
  transitionId: "handoff_1",
  turnId: "turn_restatement_1",
  workspaceState: {
    backgroundResources: [],
    capturedAt: 3_000,
    diffDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    digestAlgorithm: "sha256",
    externalSideEffectStatus: "not_observed" as const,
    headSha: "head",
    indexDigest:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    rootPath: "/workspace",
    untrackedManifestDigest:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    watcherGeneration: 1,
    worktreeId: "worktree_1",
  },
};

function guardFor(
  state: BindManagedRuntimeArgs,
  commandId = "command_1",
): MutationGuard {
  return {
    billingAuthorizationId: null,
    commandId,
    expectedBootNonce: state.incarnation.bootNonce,
    expectedControlEpoch: state.controlEpoch,
    expectedEndpointFingerprint: state.incarnation.endpointFingerprint,
    expectedNativeCursor: state.nativeCursor,
    expectedPhase: state.phase,
    expectedProviderInstanceId: state.providerInstanceId,
    expectedRuntimeInstanceId: state.incarnation.runtimeInstanceId,
    expectedTurnId: state.turnId,
  };
}

function authorize(
  broker: SessionRuntimeBroker,
  args: {
    bindingId?: string;
    guard?: MutationGuard;
    liveIncarnation?: AgentRuntimeProviderProcessIncarnation | null;
  } = {},
) {
  return broker.authorizeMutation({
    billingAuthorization: null,
    billingRoute: null,
    bindingId: args.bindingId ?? binding.bindingId,
    guard: args.guard ?? guardFor(binding),
    liveIncarnation:
      args.liveIncarnation === undefined
        ? firstIncarnation
        : args.liveIncarnation,
    nowMs: 10_000,
    permissionMode: "auto",
    requestedModel: { modelId: "gpt-5.6-sol", providerId: "codex" },
    requiresBillingAuthorization: false,
  });
}

describe("SessionRuntimeBroker", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  function makeStatePath(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "bb-session-runtime-broker-test-"),
    );
    temporaryDirectories.push(directory);
    return path.join(directory, "session-fabric", "runtime-broker-v1.json");
  }

  it("durably restores runtime fences, process identity, and exact restatement replay evidence", () => {
    const statePath = makeStatePath();
    const broker = new SessionRuntimeBroker({ statePath });
    const destination = broker.bindManagedRuntime({
      ...binding,
      bindingId: "binding_persisted_destination",
      controlEpoch: 1,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      handoffRole: "destination",
      handoffTransitionId: restatementReceipt.transitionId,
      incarnation: secondIncarnation,
      mutationPolicy: "staged_read_only",
      providerThreadId: "provider-thread-persisted",
      runtimeProcessId: 42_424,
      threadId: "thread_persisted_destination",
      workspaceId: "workspace_persisted_destination",
    });
    const restated = broker.markHandoffDestinationRestated({
      bindingId: destination.bindingId,
      bootNonce: secondIncarnation.bootNonce,
      endpointFingerprint: secondIncarnation.endpointFingerprint,
      expectedControlEpoch: destination.controlEpoch,
      receipt: restatementReceipt,
      runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      transitionId: restatementReceipt.transitionId,
    });

    const restored = new SessionRuntimeBroker({ statePath });
    expect(restored.get(destination.bindingId)).toEqual(restated);
    expect(restored.getRuntimeProcessId(destination.bindingId)).toBe(42_424);
    expect(restored.getProviderThreadId(destination.bindingId)).toBe(
      "provider-thread-persisted",
    );
    expect(
      restored.getHandoffDestinationRestatement({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        capsuleContentHash: restatementReceipt.capsuleContentHash,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: destination.controlEpoch,
        requestId: restatementReceipt.requestId,
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
        transitionId: restatementReceipt.transitionId,
      }),
    ).toEqual({ control: restated, receipt: restatementReceipt });
  });

  it("fails closed when persisted broker state is corrupt", () => {
    const statePath = makeStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not-json\n", { mode: 0o600 });

    expect(() => new SessionRuntimeBroker({ statePath })).toThrow(
      /not valid JSON/,
    );
  });

  it("recovers only after the exact recorded process is proven dead and durably replays the epoch swap", () => {
    const statePath = makeStatePath();
    const processIdentityStatus = vi.fn(() => "dead" as const);
    const broker = new SessionRuntimeBroker({
      processIdentityStatus,
      statePath,
    });
    broker.bindManagedRuntime({
      ...binding,
      providerThreadId: "provider-thread-1",
      runtimeProcessId: 31_337,
    });
    const permit = broker.prepareManagedRuntimeRecovery({
      bindingId: binding.bindingId,
      expectedBootNonce: firstIncarnation.bootNonce,
      expectedControlEpoch: binding.controlEpoch,
      expectedEndpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedRuntimeInstanceId: firstIncarnation.runtimeInstanceId,
    });
    const recovered = broker.completeManagedRuntimeRecovery({
      incarnation: secondIncarnation,
      permit,
      providerThreadId: "provider-thread-1",
      runtimeProcessId: 41_337,
    });

    expect(processIdentityStatus).toHaveBeenCalledWith(31_337);
    expect(recovered).toMatchObject({
      controlEpoch: binding.controlEpoch + 1,
      incarnation: secondIncarnation,
      phase: "idle",
      turnId: null,
    });
    const restored = new SessionRuntimeBroker({
      processIdentityStatus,
      statePath,
    });
    expect(
      restored.getManagedRuntimeRecoveryReplay({
        bindingId: binding.bindingId,
        expectedBootNonce: firstIncarnation.bootNonce,
        expectedControlEpoch: binding.controlEpoch,
        expectedEndpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedRuntimeInstanceId: firstIncarnation.runtimeInstanceId,
      }),
    ).toEqual(recovered);
    expect(restored.getRuntimeProcessId(binding.bindingId)).toBe(41_337);
  });

  it("refuses recovery while the recorded process may still be alive", () => {
    const broker = new SessionRuntimeBroker({
      processIdentityStatus: () => "alive",
    });
    broker.bindManagedRuntime({
      ...binding,
      providerThreadId: "provider-thread-1",
      runtimeProcessId: 31_337,
    });

    expect(() =>
      broker.prepareManagedRuntimeRecovery({
        bindingId: binding.bindingId,
        expectedBootNonce: firstIncarnation.bootNonce,
        expectedControlEpoch: binding.controlEpoch,
        expectedEndpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedRuntimeInstanceId: firstIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_process_alive",
      }),
    );
  });

  it("keeps an idle lost runtime recoverable without spending a second epoch", () => {
    const broker = new SessionRuntimeBroker({
      processIdentityStatus: () => "dead",
    });
    broker.bindManagedRuntime({
      ...binding,
      providerThreadId: "provider-thread-1",
      runtimeProcessId: 31_337,
    });

    expect(broker.markRuntimeLost(firstIncarnation)).toEqual([binding]);
    const permit = broker.prepareManagedRuntimeRecovery({
      bindingId: binding.bindingId,
      expectedBootNonce: firstIncarnation.bootNonce,
      expectedControlEpoch: binding.controlEpoch,
      expectedEndpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedRuntimeInstanceId: firstIncarnation.runtimeInstanceId,
    });
    expect(
      broker.completeManagedRuntimeRecovery({
        incarnation: secondIncarnation,
        permit,
        providerThreadId: "provider-thread-1",
        runtimeProcessId: 41_337,
      }),
    ).toMatchObject({ controlEpoch: binding.controlEpoch + 1, phase: "idle" });
  });

  it("tombstones handoff runtimes with exact replay and refuses an uncontrollable live process", () => {
    const broker = new SessionRuntimeBroker({
      processIdentityStatus: () => "alive",
    });
    const transitionId = "handoff_terminal_cleanup";
    const destination = broker.bindManagedRuntime({
      ...binding,
      bindingId: "binding_destination_cleanup",
      controlEpoch: 0,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      handoffRole: "destination",
      handoffTransitionId: transitionId,
      incarnation: secondIncarnation,
      mutationPolicy: "staged_read_only",
      providerThreadId: "provider-destination-cleanup",
      runtimeProcessId: 43_337,
      threadId: "thread_destination_cleanup",
    });

    expect(() =>
      broker.discardHandoffDestination({
        bindingId: destination.bindingId,
        environmentId: destination.environmentId,
        evidence: { mode: "transition" },
        liveIncarnation: null,
        threadId: destination.threadId,
        transitionId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_process_alive",
      }),
    );

    const discarded = broker.discardHandoffDestination({
      bindingId: destination.bindingId,
      environmentId: destination.environmentId,
      evidence: { mode: "transition" },
      liveIncarnation: secondIncarnation,
      threadId: destination.threadId,
      transitionId,
    });
    expect(discarded).toMatchObject({
      controlEpoch: 1,
      phase: "terminal",
      turnId: null,
    });
    expect(
      broker.discardHandoffDestination({
        bindingId: destination.bindingId,
        environmentId: destination.environmentId,
        evidence: {
          mode: "exact",
          expectedBootNonce: secondIncarnation.bootNonce,
          expectedControlEpoch: 0,
          expectedEndpointFingerprint: secondIncarnation.endpointFingerprint,
          expectedRuntimeInstanceId: secondIncarnation.runtimeInstanceId,
        },
        liveIncarnation: null,
        threadId: destination.threadId,
        transitionId,
      }),
    ).toBe(discarded);

    const source = broker.bindManagedRuntime({
      ...binding,
      bindingId: "binding_source_cleanup",
      providerThreadId: "provider-source-cleanup",
      runtimeProcessId: 33_337,
      threadId: "thread_source_cleanup",
      workspaceId: "workspace_source_cleanup",
    });
    const fenced = broker.fenceHandoffSource({
      bindingId: source.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedControlEpoch: source.controlEpoch,
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      transitionId,
    });
    const retired = broker.retireHandoffSource({
      bindingId: fenced.bindingId,
      environmentId: fenced.environmentId,
      evidence: {
        mode: "exact",
        expectedBootNonce: firstIncarnation.bootNonce,
        expectedControlEpoch: fenced.controlEpoch,
        expectedEndpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedRuntimeInstanceId: firstIncarnation.runtimeInstanceId,
      },
      liveIncarnation: firstIncarnation,
      threadId: fenced.threadId,
      transitionId,
    });
    expect(retired).toMatchObject({
      controlEpoch: fenced.controlEpoch + 1,
      phase: "terminal",
    });
  });

  it("authorizes only the exact live incarnation and control snapshot", () => {
    const broker = new SessionRuntimeBroker();
    expect(broker.bindManagedRuntime(binding)).toEqual(binding);
    expect(authorize(broker)).toEqual({ ok: true });
    expect(
      authorize(broker, { liveIncarnation: secondIncarnation }),
    ).toMatchObject({ ok: false, reason: "runtime_record_mismatch" });
    expect(authorize(broker, { liveIncarnation: null })).toMatchObject({
      ok: false,
      reason: "live_runtime_missing",
    });
  });

  it("invalidates the epoch and records outcome-unknown when a dispatching runtime is lost", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    broker.observeRuntimePhase({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      event: "begin_dispatch",
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
    });

    expect(broker.markRuntimeLost(firstIncarnation)).toEqual([
      expect.objectContaining({
        controlEpoch: 8,
        phase: "outcome_unknown",
      }),
    ]);
    expect(authorize(broker)).toMatchObject({
      ok: false,
      reason: "phase_not_mutable",
    });
  });

  it("requires an explicit terminal fence and next epoch before replacing a runtime", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    expect(() =>
      broker.bindManagedRuntime({
        ...binding,
        controlEpoch: 8,
        incarnation: secondIncarnation,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_replacement_unsafe",
      }),
    );

    broker.observeRuntimePhase({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      event: "stop",
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
    });
    expect(() =>
      broker.bindManagedRuntime({
        ...binding,
        controlEpoch: 9,
        incarnation: secondIncarnation,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "control_epoch_not_next",
      }),
    );
    expect(
      broker.bindManagedRuntime({
        ...binding,
        controlEpoch: 8,
        incarnation: secondIncarnation,
      }),
    ).toMatchObject({
      controlEpoch: 8,
      incarnation: secondIncarnation,
    });
  });

  it("rejects stale provider events from an earlier incarnation", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    expect(() =>
      broker.observeRuntimePhase({
        bindingId: binding.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        event: "begin_dispatch",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_incarnation_mismatch",
      }),
    );
  });

  it("keeps a staged destination read-only until the source no longer controls the workspace", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    const destination = {
      ...binding,
      bindingId: "binding_2",
      controlEpoch: 1,
      incarnation: secondIncarnation,
      mutationPolicy: "staged_read_only" as const,
      phase: "attaching" as const,
      threadId: "thread_2",
    };
    broker.bindManagedRuntime(destination);

    expect(
      broker.observeRuntimePhase({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        event: "attach_ready",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toMatchObject({ phase: "idle", mutationPolicy: "staged_read_only" });
    expect(
      broker.authorizeMutation({
        billingAuthorization: null,
        billingRoute: null,
        bindingId: destination.bindingId,
        guard: guardFor({ ...destination, phase: "idle" }),
        liveIncarnation: secondIncarnation,
        nowMs: 10_000,
        permissionMode: "auto",
        requestedModel: { modelId: "gpt-5.6-sol", providerId: "codex" },
        requiresBillingAuthorization: false,
      }),
    ).toMatchObject({ ok: false, reason: "mutation_policy_read_only" });
    expect(() =>
      broker.assertThreadMutationAllowed({
        environmentId: destination.environmentId,
        liveIncarnation: secondIncarnation,
        threadId: destination.threadId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "mutation_policy_read_only",
      }),
    );

    expect(() =>
      broker.setMutationPolicy({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: 1,
        expectedMutationPolicy: "staged_read_only",
        nextMutationPolicy: "enabled",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "workspace_mutation_conflict",
      }),
    );

    const fencedSource = broker.setMutationPolicy({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedControlEpoch: 7,
      expectedMutationPolicy: "enabled",
      nextMutationPolicy: "staged_read_only",
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
    });
    expect(fencedSource).toMatchObject({
      controlEpoch: 8,
      mutationPolicy: "staged_read_only",
    });

    const enabledDestination = broker.setMutationPolicy({
      bindingId: destination.bindingId,
      bootNonce: secondIncarnation.bootNonce,
      endpointFingerprint: secondIncarnation.endpointFingerprint,
      expectedControlEpoch: 1,
      expectedMutationPolicy: "staged_read_only",
      nextMutationPolicy: "enabled",
      runtimeInstanceId: secondIncarnation.runtimeInstanceId,
    });
    expect(enabledDestination).toMatchObject({
      controlEpoch: 2,
      mutationPolicy: "enabled",
    });
    expect(
      broker.setMutationPolicy({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: 1,
        expectedMutationPolicy: "staged_read_only",
        nextMutationPolicy: "enabled",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toBe(enabledDestination);
    expect(() =>
      broker.setMutationPolicy({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: 0,
        expectedMutationPolicy: "staged_read_only",
        nextMutationPolicy: "enabled",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "control_epoch_mismatch",
      }),
    );
  });

  it("allows destination mutation in an isolated workspace", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    const destination = broker.bindManagedRuntime({
      ...binding,
      bindingId: "binding_2",
      controlEpoch: 1,
      incarnation: secondIncarnation,
      mutationPolicy: "enabled",
      phase: "attaching",
      workspaceId: "workspace_2",
    });
    expect(
      broker.observeRuntimePhase({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        event: "attach_ready",
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      }),
    ).toMatchObject({ phase: "idle", workspaceId: "workspace_2" });
  });

  it("requires the handoff-specific restatement checkpoint before enabling a destination", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    const transitionId = "handoff_1";
    const destination = broker.bindManagedRuntime({
      ...binding,
      bindingId: "binding_2",
      controlEpoch: 1,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      handoffRole: "destination",
      handoffTransitionId: transitionId,
      incarnation: secondIncarnation,
      mutationPolicy: "staged_read_only",
      threadId: "thread_2",
    });

    const fencedSource = broker.fenceHandoffSource({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedControlEpoch: binding.controlEpoch,
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      transitionId,
    });
    expect(fencedSource).toMatchObject({
      controlEpoch: 8,
      handoffCheckpoint: "source_fenced",
      handoffRole: "source",
      mutationPolicy: "staged_read_only",
    });
    expect(() =>
      broker.setMutationPolicy({
        bindingId: binding.bindingId,
        bootNonce: firstIncarnation.bootNonce,
        endpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedControlEpoch: 8,
        expectedMutationPolicy: "staged_read_only",
        nextMutationPolicy: "enabled",
        runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "handoff_control_required",
      }),
    );
    expect(() =>
      broker.enableHandoffDestination({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: 1,
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
        transitionId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "handoff_control_required",
      }),
    );

    const restated = broker.markHandoffDestinationRestated({
      bindingId: destination.bindingId,
      bootNonce: secondIncarnation.bootNonce,
      endpointFingerprint: secondIncarnation.endpointFingerprint,
      expectedControlEpoch: 1,
      runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      transitionId,
      receipt: restatementReceipt,
    });
    expect(restated).toMatchObject({
      controlEpoch: 2,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_restated",
      mutationPolicy: "staged_read_only",
    });
    expect(
      broker.markHandoffDestinationRestated({
        bindingId: destination.bindingId,
        bootNonce: secondIncarnation.bootNonce,
        endpointFingerprint: secondIncarnation.endpointFingerprint,
        expectedControlEpoch: 1,
        runtimeInstanceId: secondIncarnation.runtimeInstanceId,
        transitionId,
        receipt: restatementReceipt,
      }),
    ).toBe(restated);

    const enabled = broker.enableHandoffDestination({
      bindingId: destination.bindingId,
      bootNonce: secondIncarnation.bootNonce,
      endpointFingerprint: secondIncarnation.endpointFingerprint,
      expectedControlEpoch: 2,
      runtimeInstanceId: secondIncarnation.runtimeInstanceId,
      transitionId,
    });
    expect(enabled).toMatchObject({
      controlEpoch: 3,
      executionSafety: "standard",
      handoffCheckpoint: "destination_restated",
      mutationPolicy: "enabled",
    });
  });

  it("restores only the exact idle fenced source and makes retries idempotent", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    const transitionId = "handoff_restore_1";
    const fenced = broker.fenceHandoffSource({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedControlEpoch: binding.controlEpoch,
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      transitionId,
    });

    expect(() =>
      broker.restoreHandoffSource({
        bindingId: binding.bindingId,
        bootNonce: firstIncarnation.bootNonce,
        endpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedControlEpoch: fenced.controlEpoch,
        runtimeInstanceId: firstIncarnation.runtimeInstanceId,
        transitionId: "different_handoff",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "handoff_transition_mismatch",
      }),
    );

    const restored = broker.restoreHandoffSource({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      expectedControlEpoch: fenced.controlEpoch,
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      transitionId,
    });
    expect(restored).toMatchObject({
      controlEpoch: fenced.controlEpoch + 1,
      executionSafety: "standard",
      handoffCheckpoint: "not_applicable",
      handoffRole: null,
      handoffTransitionId: null,
      mutationPolicy: "enabled",
      phase: "idle",
      turnId: null,
    });
    expect(
      broker.restoreHandoffSource({
        bindingId: binding.bindingId,
        bootNonce: firstIncarnation.bootNonce,
        endpointFingerprint: firstIncarnation.endpointFingerprint,
        expectedControlEpoch: fenced.controlEpoch,
        runtimeInstanceId: firstIncarnation.runtimeInstanceId,
        transitionId,
      }),
    ).toBe(restored);
  });

  it("lets unadopted threads run but rejects an adopted thread on a replacement incarnation", () => {
    const broker = new SessionRuntimeBroker();
    expect(
      broker.assertThreadMutationAllowed({
        environmentId: "environment_unadopted",
        threadId: "thread_unadopted",
      }),
    ).toBeNull();

    broker.bindManagedRuntime(binding);
    expect(
      broker.assertThreadMutationAllowed({
        environmentId: binding.environmentId,
        liveIncarnation: firstIncarnation,
        threadId: binding.threadId,
      }),
    ).toEqual(binding);
    expect(() =>
      broker.assertThreadMutationAllowed({
        environmentId: binding.environmentId,
        liveIncarnation: secondIncarnation,
        threadId: binding.threadId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_incarnation_mismatch",
      }),
    );
  });

  it("keeps terminal binding tombstones authoritative", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    broker.observeRuntimePhase({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      event: "stop",
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
    });

    expect(() =>
      broker.assertThreadMutationAllowed({
        environmentId: binding.environmentId,
        threadId: binding.threadId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "runtime_phase_read_only",
      }),
    );
  });

  it("requires a provider turn before entering running", () => {
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime(binding);
    broker.observeRuntimePhase({
      bindingId: binding.bindingId,
      bootNonce: firstIncarnation.bootNonce,
      endpointFingerprint: firstIncarnation.endpointFingerprint,
      event: "begin_dispatch",
      runtimeInstanceId: firstIncarnation.runtimeInstanceId,
    });
    expect(() =>
      broker.observeRuntimePhase({
        bindingId: binding.bindingId,
        bootNonce: firstIncarnation.bootNonce,
        endpointFingerprint: firstIncarnation.endpointFingerprint,
        event: "command_accepted",
        runtimeInstanceId: firstIncarnation.runtimeInstanceId,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionRuntimeBrokerError>>({
        code: "turn_required",
      }),
    );
  });
});
