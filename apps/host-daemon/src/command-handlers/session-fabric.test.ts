import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgentRuntimeProviderProcessIncarnation } from "@bb/agent-runtime";
import {
  contextCapsuleWorkspaceDigest,
  serializeContextCapsuleForHash,
  type ContextCapsule,
  type MutationGuard,
  type RuntimeThreadExecutionOptions,
  type SessionWorkspaceState,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  createHarness,
  DISPATCH_TEST_BRIDGE_LAUNCH,
  makeTempDir,
  runGitCommand,
} from "../../test/command/dispatch-helpers.js";
import { testRuntimeIncarnation } from "../../test/runtime-incarnation.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { SessionRuntimeBroker } from "../session-runtime-broker.js";
import { inspectWorkspaceState } from "../session-runtime-inspection.js";
import {
  bindSessionRuntime,
  changeSessionModel,
  discardSessionHandoffDestination,
  enableSessionHandoffDestination,
  fenceSessionHandoffSource,
  inspectSessionHandoffDestinationWorkspace,
  restateSessionHandoffDestination,
  inspectSessionRuntime,
  recoverSessionRuntime,
  retireSessionHandoffSource,
  restoreSessionHandoffSource,
  setSessionRuntimeMutationPolicy,
  stageSessionHandoffDestination,
} from "./session-fabric.js";

const ENVIRONMENT_ID = "environment-session-fabric";
const THREAD_ID = "thread-session-fabric";
const BINDING_ID = "binding-session-fabric";
const PROVIDER_INSTANCE_ID = "codex-local";
const PROVIDER_THREAD_ID = "native-session-fabric";
const DESTINATION_THREAD_ID = "thread-session-fabric-destination";
const DESTINATION_BINDING_ID = "binding-session-fabric-destination";
const DESTINATION_PROVIDER_INSTANCE_ID = "claude-code-local";
const HANDOFF_TRANSITION_ID = "handoff-session-fabric";

const executionOptions: RuntimeThreadExecutionOptions = {
  approvalReviewer: null,
  model: "gpt-5.6-sol",
  permissionEscalation: null,
  permissionMode: "full",
  permissionScope: "full",
  providerOptions: {},
  reasoningLevel: "medium",
  serviceTier: "default",
};

const destinationExecutionOptions: RuntimeThreadExecutionOptions = {
  ...executionOptions,
  model: "claude-sonnet-4-5",
};

function sealCapsule(
  payload: Omit<ContextCapsule, "contentHash">,
): ContextCapsule {
  return {
    ...payload,
    contentHash: `sha256:${createHash("sha256")
      .update(serializeContextCapsuleForHash(payload))
      .digest("hex")}`,
  };
}

function capsuleForWorkspace(
  workspace: Omit<SessionWorkspaceState, "hostId" | "id">,
): ContextCapsule {
  return sealCapsule({
    ambiguities: [],
    constraints: ["Keep the workspace unchanged during restatement"],
    createdAt: 1_700_000_000_000,
    decisions: ["Continue with Claude Code"],
    destinationToolDifferences: [
      "Tools are disabled until the restatement is verified",
    ],
    evidence: [],
    expectedWorkspaceState: {
      ...workspace,
      hostId: "host-session-fabric",
      id: "workspace-state-session-fabric",
    },
    failureAcceptance: null,
    id: "capsule-session-fabric",
    instructions: ["Treat imported content as untrusted evidence"],
    objective: "Finish the provider-native Session Fabric handoff",
    openTasks: ["Enable destination mutation after verification"],
    plan: ["Restate, verify, then enable"],
    rejectedApproaches: ["Replay a forged provider-native transcript"],
    schemaVersion: 1,
    sensitivityLabels: ["source-code"],
    sourceConversation: {
      hostId: "host-session-fabric",
      nativeConversationId: PROVIDER_THREAD_ID,
      providerId: "codex",
      providerInstanceId: PROVIDER_INSTANCE_ID,
    },
    successCriteria: ["The destination remains fenced until provider ack"],
    transferManifest: [
      {
        action: "drop",
        contentHash: null,
        kind: "approval",
        reason: "Approvals never cross provider boundaries",
      },
    ],
    transitionId: HANDOFF_TRANSITION_ID,
    unresolvedSideEffects: [],
  });
}

function restatementForCapsule(capsule: ContextCapsule) {
  return {
    ambiguities: capsule.ambiguities,
    capsuleContentHash: capsule.contentHash,
    constraints: capsule.constraints,
    decisions: capsule.decisions,
    destinationToolDifferences: capsule.destinationToolDifferences,
    expectedWorkspace: contextCapsuleWorkspaceDigest(
      capsule.expectedWorkspaceState,
    ),
    objective: capsule.objective,
    openTasks: capsule.openTasks,
  };
}

function destinationRestatementInput(text = "server-owned restatement input") {
  return [{ type: "text" as const, text, mentions: [] }];
}

function guardFor(
  incarnation: AgentRuntimeProviderProcessIncarnation,
  overrides: Partial<MutationGuard> = {},
): MutationGuard {
  return {
    billingAuthorizationId: null,
    commandId: "command-session-fabric",
    expectedBootNonce: incarnation.bootNonce,
    expectedControlEpoch: 1,
    expectedEndpointFingerprint: incarnation.endpointFingerprint,
    expectedNativeCursor: null,
    expectedPhase: "idle",
    expectedProviderInstanceId: PROVIDER_INSTANCE_ID,
    expectedRuntimeInstanceId: incarnation.runtimeInstanceId,
    expectedTurnId: null,
    ...overrides,
  };
}

function modelChangeCommand(
  incarnation: AgentRuntimeProviderProcessIncarnation,
  guardOverrides: Partial<MutationGuard> = {},
): CommandOf<"session.model_change"> {
  return {
    billingAuthorization: null,
    billingRoute: null,
    bindingId: BINDING_ID,
    environmentId: ENVIRONMENT_ID,
    guard: guardFor(incarnation, guardOverrides),
    reasoningLevel: executionOptions.reasoningLevel,
    requestedModel: {
      modelId: executionOptions.model,
      providerId: "codex",
    },
    requiresBillingAuthorization: false,
    serviceTier: executionOptions.serviceTier,
    threadId: THREAD_ID,
    type: "session.model_change",
  };
}

async function createHostedFixture() {
  const workspacePath = await makeTempDir("bb-session-fabric-handler-");
  await runGitCommand(["init"], { cwd: workspacePath });
  const harness = createHarness({ workspacePath });
  await harness.manager.ensureEnvironment({
    environmentId: ENVIRONMENT_ID,
    workspacePath,
  });
  harness.threadControls.setProviderSession(THREAD_ID, {
    providerId: "codex",
    providerThreadId: PROVIDER_THREAD_ID,
  });
  const incarnation = testRuntimeIncarnation("codex", "handler");
  vi.spyOn(harness.runtime, "getProviderRuntimeIncarnation").mockReturnValue(
    incarnation,
  );
  vi.spyOn(harness.runtime, "getProviderProcessId").mockReturnValue(31_337);
  vi.spyOn(harness.runtime, "getThreadExecutionOptions").mockReturnValue(
    executionOptions,
  );
  vi.spyOn(harness.runtime, "getThreadConfigurationSnapshot").mockReturnValue({
    disallowedTools: [],
    dynamicTools: [],
    environmentId: ENVIRONMENT_ID,
    executionSafety: "standard",
    instructionMode: "append",
    instructions: "Test Session Fabric safely.",
    options: executionOptions,
    processKey: incarnation.processKey,
    projectId: "project-session-fabric",
    providerId: "codex",
    skillRoots: [],
    workspacePath,
  });
  const options = harness.dispatchOptions();
  return { harness, incarnation, options, workspacePath };
}

async function createBoundFixture() {
  const fixture = await createHostedFixture();
  fixture.options.sessionRuntimeBroker.bindManagedRuntime({
    bindingId: BINDING_ID,
    controlEpoch: 1,
    environmentId: ENVIRONMENT_ID,
    incarnation: fixture.incarnation,
    mutationPolicy: "enabled",
    nativeCursor: null,
    ownership: "owned_brokered",
    phase: "idle",
    providerInstanceId: PROVIDER_INSTANCE_ID,
    threadId: THREAD_ID,
    turnId: null,
    workspaceId: await realpath(fixture.workspacePath),
  });
  return fixture;
}

async function createRecoverableFixture(
  processIdentityStatus: "alive" | "dead" = "dead",
) {
  const fixture = await createHostedFixture();
  const broker = new SessionRuntimeBroker({
    processProbe: {
      getIdentityStatus: () => processIdentityStatus,
    },
  });
  const options = {
    ...fixture.options,
    sessionRuntimeBroker: broker,
  };
  const inspection = await inspectSessionRuntime(
    {
      environmentId: ENVIRONMENT_ID,
      expectedProviderId: "codex",
      expectedProviderThreadId: PROVIDER_THREAD_ID,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      threadId: THREAD_ID,
      type: "session.runtime.inspect",
    },
    options,
  );
  broker.bindManagedRuntime({
    bindingId: BINDING_ID,
    controlEpoch: 1,
    environmentId: ENVIRONMENT_ID,
    incarnation: fixture.incarnation,
    mutationPolicy: "enabled",
    nativeCursor: null,
    ownership: "owned_brokered",
    phase: "idle",
    providerInstanceId: PROVIDER_INSTANCE_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    runtimeProcessId: 31_337,
    threadId: THREAD_ID,
    turnId: null,
    workspaceId: await realpath(fixture.workspacePath),
  });

  let liveIncarnation = fixture.incarnation;
  let liveProcessId = 31_337;
  const recoveredIncarnation = Object.freeze({
    ...fixture.incarnation,
    bootNonce: "boot_nonce_handler_recovered",
    endpointFingerprint: "stdio:handler-recovered",
    runtimeInstanceId: "runtime_handler_recovered",
    startedAt: fixture.incarnation.startedAt + 1,
  });
  vi.mocked(
    fixture.harness.runtime.getProviderRuntimeIncarnation,
  ).mockImplementation(() => liveIncarnation);
  vi.spyOn(fixture.harness.runtime, "getProviderProcessId").mockImplementation(
    () => liveProcessId,
  );
  const resumeThreadImplementation = fixture.harness.runtime.resumeThread.bind(
    fixture.harness.runtime,
  );
  const resumeThread = vi
    .spyOn(fixture.harness.runtime, "resumeThread")
    .mockImplementation(async (args) => {
      liveIncarnation = recoveredIncarnation;
      liveProcessId = 41_337;
      return resumeThreadImplementation(args);
    });
  fixture.harness.threadControls.clearProviderSession(THREAD_ID);

  const command: CommandOf<"session.runtime.recover"> = {
    bindingId: BINDING_ID,
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    dynamicTools: [],
    environmentId: ENVIRONMENT_ID,
    expectedBootNonce: fixture.incarnation.bootNonce,
    expectedControlEpoch: 1,
    expectedEndpointFingerprint: fixture.incarnation.endpointFingerprint,
    expectedProviderThreadId: PROVIDER_THREAD_ID,
    expectedRuntimeInstanceId: fixture.incarnation.runtimeInstanceId,
    expectedRuntimeRecipe: inspection.runtimeRecipe,
    expectedWorkspaceState: inspection.workspaceState,
    injectedSkillSources: [],
    instructionMode: "append",
    instructions: "Test Session Fabric safely.",
    options: executionOptions,
    projectId: "project-session-fabric",
    providerId: "codex",
    providerInstanceId: PROVIDER_INSTANCE_ID,
    threadId: THREAD_ID,
    type: "session.runtime.recover",
    workspaceContext: {
      workspacePath: fixture.workspacePath,
      workspaceProvisionType: "unmanaged",
    },
  };
  return {
    ...fixture,
    command,
    inspection,
    options,
    recoveredIncarnation,
    resumeThread,
  };
}

async function createDestinationStageFixture(
  processIdentityStatus: "alive" | "dead" = "dead",
) {
  const workspacePath = await makeTempDir(
    "bb-session-fabric-destination-handler-",
  );
  await runGitCommand(["init"], { cwd: workspacePath });
  const threadStorageRootPath = await makeTempDir(
    "bb-session-fabric-thread-storage-",
  );
  const harness = createHarness({ workspacePath });
  const entry = await harness.manager.ensureEnvironment({
    environmentId: ENVIRONMENT_ID,
    workspacePath,
  });
  const incarnation = testRuntimeIncarnation("claude-code", "destination");
  const recoveredIncarnation = Object.freeze({
    ...incarnation,
    bootNonce: "boot_nonce_destination_recovered",
    endpointFingerprint: "stdio:destination-recovered",
    runtimeInstanceId: "runtime_destination_recovered",
    startedAt: incarnation.startedAt + 1,
  });
  let liveIncarnation = incarnation;
  let liveProcessId = 32_337;
  let executionSafety: "handoff_restatement" | "standard" =
    "handoff_restatement";
  vi.spyOn(harness.runtime, "getProviderRuntimeIncarnation").mockImplementation(
    () => liveIncarnation,
  );
  vi.spyOn(harness.runtime, "getProviderProcessId").mockImplementation(
    () => liveProcessId,
  );
  vi.spyOn(
    harness.runtime,
    "getThreadConfigurationSnapshot",
  ).mockImplementation(() => ({
    disallowedTools: [],
    dynamicTools: [],
    environmentId: ENVIRONMENT_ID,
    executionSafety,
    instructionMode: "append",
    instructions: "Continue the Session Fabric implementation safely.",
    options: destinationExecutionOptions,
    processKey: incarnation.processKey,
    projectId: "project-session-fabric",
    providerId: "claude-code",
    skillRoots: [],
    workspacePath,
  }));
  const startThread = vi.spyOn(harness.runtime, "startThread");
  const resumeThreadImplementation = harness.runtime.resumeThread.bind(
    harness.runtime,
  );
  const resumeThread = vi
    .spyOn(harness.runtime, "resumeThread")
    .mockImplementation(async (args) => {
      liveIncarnation = recoveredIncarnation;
      liveProcessId = 42_337;
      return resumeThreadImplementation(args);
    });
  const options = {
    ...harness.dispatchOptions({ threadStorageRootPath }),
    sessionRuntimeBroker: new SessionRuntimeBroker({
      processProbe: {
        getIdentityStatus: () => processIdentityStatus,
      },
    }),
  };
  const expectedWorkspaceState = await inspectWorkspaceState({
    capturedAt: Date.now(),
    entry,
  });
  const stageCommand: CommandOf<"session.handoff.stage_destination"> = {
    bindingId: DESTINATION_BINDING_ID,
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    controlEpoch: 0,
    dynamicTools: [],
    environmentId: ENVIRONMENT_ID,
    expectedWorkspaceState,
    injectedSkillSources: [],
    instructionMode: "append",
    instructions: "Continue the Session Fabric implementation safely.",
    options: destinationExecutionOptions,
    projectId: "project-session-fabric",
    providerId: "claude-code",
    providerInstanceId: DESTINATION_PROVIDER_INSTANCE_ID,
    threadId: DESTINATION_THREAD_ID,
    threadStoragePath: `${threadStorageRootPath}/${DESTINATION_THREAD_ID}`,
    transitionId: HANDOFF_TRANSITION_ID,
    type: "session.handoff.stage_destination",
    workspaceContext: {
      workspacePath,
      workspaceProvisionType: "unmanaged",
    },
  };
  return {
    harness,
    incarnation,
    options,
    recoveredIncarnation,
    resumeThread,
    setExecutionSafety(value: "handoff_restatement" | "standard") {
      executionSafety = value;
    },
    stageCommand,
    startThread,
    workspacePath,
  };
}

async function createStagedDestinationFixture(
  processIdentityStatus: "alive" | "dead" = "dead",
) {
  const fixture = await createDestinationStageFixture(processIdentityStatus);
  const staged = await stageSessionHandoffDestination(
    fixture.stageCommand,
    fixture.options,
  );
  return { ...fixture, staged };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe("Session Fabric command handlers", () => {
  it("inspects exact runtime, recipe, and workspace evidence without binding", async () => {
    const fixture = await createHostedFixture();
    await expect(
      inspectSessionRuntime(
        {
          environmentId: ENVIRONMENT_ID,
          expectedProviderId: "codex",
          expectedProviderThreadId: PROVIDER_THREAD_ID,
          providerInstanceId: PROVIDER_INSTANCE_ID,
          threadId: THREAD_ID,
          type: "session.runtime.inspect",
        },
        fixture.options,
      ),
    ).resolves.toMatchObject({
      environmentId: ENVIRONMENT_ID,
      incarnation: fixture.incarnation,
      ownership: "owned_brokered",
      phase: "idle",
      providerId: "codex",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      providerThreadId: PROVIDER_THREAD_ID,
      runtimeRecipe: {
        cwd: await realpath(fixture.workspacePath),
        environmentReferenceIds: [ENVIRONMENT_ID],
        permissionMode: "full",
        workspaceWriteRoots: [await realpath(fixture.workspacePath)],
      },
      workspaceState: {
        backgroundResources: [],
        digestAlgorithm: "bb-session-workspace-v2:sha256",
        externalSideEffectStatus: "unknown",
        headSha: "commit-1",
        rootPath: await realpath(fixture.workspacePath),
      },
    });
    expect(fixture.options.sessionRuntimeBroker.list()).toEqual([]);
  });

  it("inspects a reserved destination workspace without requiring a runtime", async () => {
    const fixture = await createHostedFixture();

    await expect(
      inspectSessionHandoffDestinationWorkspace(
        {
          type: "session.handoff.inspect_destination_workspace",
          environmentId: ENVIRONMENT_ID,
          workspaceContext: {
            workspacePath: fixture.workspacePath,
            workspaceProvisionType: "unmanaged",
          },
        },
        fixture.options,
      ),
    ).resolves.toMatchObject({
      digestAlgorithm: "bb-session-workspace-v2:sha256",
      externalSideEffectStatus: "unknown",
      headSha: "commit-1",
      rootPath: await realpath(fixture.workspacePath),
    });
  });

  it("binds only the exact hosted provider-native conversation", async () => {
    const fixture = await createHostedFixture();
    const command: CommandOf<"session.runtime.bind"> = {
      bindingId: BINDING_ID,
      controlEpoch: 1,
      environmentId: ENVIRONMENT_ID,
      expectedBootNonce: fixture.incarnation.bootNonce,
      expectedEndpointFingerprint: fixture.incarnation.endpointFingerprint,
      expectedProviderId: "codex",
      expectedProviderThreadId: PROVIDER_THREAD_ID,
      expectedRuntimeInstanceId: fixture.incarnation.runtimeInstanceId,
      mutationPolicy: "enabled",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      threadId: THREAD_ID,
      type: "session.runtime.bind",
    };

    await expect(
      bindSessionRuntime(command, fixture.options),
    ).resolves.toMatchObject({
      bindingId: BINDING_ID,
      incarnation: fixture.incarnation,
      ownership: "owned_brokered",
      phase: "idle",
      workspaceId: await realpath(fixture.workspacePath),
    });
    await expect(
      bindSessionRuntime(
        { ...command, expectedProviderThreadId: "different-native-session" },
        fixture.options,
      ),
    ).rejects.toMatchObject({ code: "native_conversation_mismatch" });
  });

  it("recovers an idle binding only after proving the old process dead and replays the exact result", async () => {
    const fixture = await createRecoverableFixture();

    const recovered = await recoverSessionRuntime(
      fixture.command,
      fixture.options,
    );
    expect(fixture.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        providerId: "codex",
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: THREAD_ID,
      }),
    );
    expect(fixture.resumeThread.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(recovered).toMatchObject({
      control: {
        controlEpoch: 2,
        incarnation: fixture.recoveredIncarnation,
        phase: "idle",
      },
      inspection: {
        incarnation: fixture.recoveredIncarnation,
        providerThreadId: PROVIDER_THREAD_ID,
        runtimeRecipe: fixture.inspection.runtimeRecipe,
      },
    });

    const replayed = await recoverSessionRuntime(
      fixture.command,
      fixture.options,
    );
    expect(replayed.control).toBe(recovered.control);
    expect(replayed.inspection).toMatchObject({
      incarnation: fixture.recoveredIncarnation,
      providerThreadId: PROVIDER_THREAD_ID,
      runtimeRecipe: fixture.inspection.runtimeRecipe,
      workspaceState: {
        diffDigest: recovered.inspection.workspaceState.diffDigest,
        headSha: recovered.inspection.workspaceState.headSha,
        indexDigest: recovered.inspection.workspaceState.indexDigest,
        untrackedManifestDigest:
          recovered.inspection.workspaceState.untrackedManifestDigest,
      },
    });
    expect(fixture.resumeThread).toHaveBeenCalledTimes(1);
  });

  it("stops a newly resumed runtime when recovery evidence does not match", async () => {
    const fixture = await createRecoverableFixture();
    fixture.command.expectedWorkspaceState = {
      ...fixture.command.expectedWorkspaceState,
      diffDigest: "sha256:unexpected-recovery-diff",
    };
    const stopThread = vi.spyOn(fixture.harness.runtime, "stopThread");

    await expect(
      recoverSessionRuntime(fixture.command, fixture.options),
    ).rejects.toMatchObject({ code: "runtime_recovery_mismatch" });

    expect(fixture.resumeThread).toHaveBeenCalledTimes(1);
    expect(stopThread).toHaveBeenCalledWith({ threadId: THREAD_ID });
    expect(fixture.harness.runtime.hasThread(THREAD_ID)).toBe(false);
    expect(fixture.options.sessionRuntimeBroker.get(BINDING_ID)).toMatchObject({
      controlEpoch: fixture.command.expectedControlEpoch,
      incarnation: fixture.incarnation,
    });
  });

  it("does not resume a replacement while the recorded provider process may still be alive", async () => {
    const fixture = await createRecoverableFixture("alive");

    await expect(
      recoverSessionRuntime(fixture.command, fixture.options),
    ).rejects.toMatchObject({ code: "runtime_process_alive" });
    expect(fixture.resumeThread).not.toHaveBeenCalled();
  });

  it("restores an exact pre-swap source fence through the handoff RPC", async () => {
    const fixture = await createBoundFixture();
    const target = {
      bindingId: BINDING_ID,
      bootNonce: fixture.incarnation.bootNonce,
      endpointFingerprint: fixture.incarnation.endpointFingerprint,
      environmentId: ENVIRONMENT_ID,
      runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
      threadId: THREAD_ID,
      transitionId: HANDOFF_TRANSITION_ID,
    };
    const fenced = await fenceSessionHandoffSource(
      {
        ...target,
        expectedControlEpoch: 1,
        type: "session.handoff.fence_source",
      },
      fixture.options,
    );

    const restored = await restoreSessionHandoffSource(
      {
        ...target,
        expectedControlEpoch: fenced.controlEpoch,
        type: "session.handoff.restore_source",
      },
      fixture.options,
    );
    expect(restored).toMatchObject({
      controlEpoch: fenced.controlEpoch + 1,
      handoffCheckpoint: "not_applicable",
      handoffRole: null,
      handoffTransitionId: null,
      mutationPolicy: "enabled",
    });
  });

  it("tombstones and stops an abandoned destination with an exact replay", async () => {
    const fixture = await createStagedDestinationFixture();
    const stopThread = vi.spyOn(fixture.harness.runtime, "stopThread");
    const command: CommandOf<"session.handoff.discard_destination"> = {
      bindingId: DESTINATION_BINDING_ID,
      bootNonce: fixture.incarnation.bootNonce,
      endpointFingerprint: fixture.incarnation.endpointFingerprint,
      environmentId: ENVIRONMENT_ID,
      evidenceMode: "exact",
      expectedControlEpoch: fixture.staged.control.controlEpoch,
      runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
      threadId: DESTINATION_THREAD_ID,
      transitionId: HANDOFF_TRANSITION_ID,
      type: "session.handoff.discard_destination",
    };

    const discarded = await discardSessionHandoffDestination(
      command,
      fixture.options,
    );
    expect(discarded).toMatchObject({
      controlEpoch: fixture.staged.control.controlEpoch + 1,
      handoffRole: "destination",
      phase: "terminal",
    });
    expect(stopThread).toHaveBeenCalledWith({
      threadId: DESTINATION_THREAD_ID,
    });
    await expect(
      discardSessionHandoffDestination(command, fixture.options),
    ).resolves.toBe(discarded);
    expect(stopThread).toHaveBeenCalledTimes(1);
  });

  it("tombstones and stops the exact fenced source before retirement", async () => {
    const fixture = await createBoundFixture();
    const fenced = await fenceSessionHandoffSource(
      {
        bindingId: BINDING_ID,
        bootNonce: fixture.incarnation.bootNonce,
        endpointFingerprint: fixture.incarnation.endpointFingerprint,
        environmentId: ENVIRONMENT_ID,
        expectedControlEpoch: 1,
        runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
        threadId: THREAD_ID,
        transitionId: HANDOFF_TRANSITION_ID,
        type: "session.handoff.fence_source",
      },
      fixture.options,
    );
    const stopThread = vi.spyOn(fixture.harness.runtime, "stopThread");
    const retired = await retireSessionHandoffSource(
      {
        bindingId: BINDING_ID,
        bootNonce: fixture.incarnation.bootNonce,
        endpointFingerprint: fixture.incarnation.endpointFingerprint,
        environmentId: ENVIRONMENT_ID,
        expectedControlEpoch: fenced.controlEpoch,
        runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
        threadId: THREAD_ID,
        transitionId: HANDOFF_TRANSITION_ID,
        type: "session.handoff.retire_source",
      },
      fixture.options,
    );
    expect(retired).toMatchObject({
      controlEpoch: fenced.controlEpoch + 1,
      handoffRole: "source",
      phase: "terminal",
    });
    expect(stopThread).toHaveBeenCalledWith({ threadId: THREAD_ID });
  });

  it("changes mutation policy only for the exact live incarnation and accepts an identical retry", async () => {
    const fixture = await createBoundFixture();
    const command: CommandOf<"session.runtime.set_mutation_policy"> = {
      bindingId: BINDING_ID,
      bootNonce: fixture.incarnation.bootNonce,
      endpointFingerprint: fixture.incarnation.endpointFingerprint,
      environmentId: ENVIRONMENT_ID,
      expectedControlEpoch: 1,
      expectedMutationPolicy: "enabled",
      nextMutationPolicy: "staged_read_only",
      runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
      threadId: THREAD_ID,
      type: "session.runtime.set_mutation_policy",
    };

    const fenced = await setSessionRuntimeMutationPolicy(
      command,
      fixture.options,
    );
    expect(fenced).toMatchObject({
      controlEpoch: 2,
      mutationPolicy: "staged_read_only",
    });
    await expect(
      setSessionRuntimeMutationPolicy(command, fixture.options),
    ).resolves.toBe(fenced);
    await expect(
      setSessionRuntimeMutationPolicy(
        { ...command, runtimeInstanceId: "stale-runtime" },
        fixture.options,
      ),
    ).rejects.toMatchObject({ code: "runtime_incarnation_unavailable" });
  });

  it("rejects a stale guard before any provider request is dispatched", async () => {
    const fixture = await createBoundFixture();
    const reconfigure = vi.spyOn(fixture.harness.runtime, "reconfigureThread");

    await expect(
      changeSessionModel(
        modelChangeCommand(fixture.incarnation, {
          expectedControlEpoch: 0,
        }),
        fixture.options,
      ),
    ).resolves.toMatchObject({
      acceptance: "not_accepted",
      diagnostic: expect.stringContaining("control_epoch_mismatch"),
    });
    expect(reconfigure).not.toHaveBeenCalled();
    expect(fixture.options.sessionRuntimeBroker.get(BINDING_ID)?.phase).toBe(
      "idle",
    );
  });

  it("returns provider-acknowledged model changes and restores the idle phase", async () => {
    const fixture = await createBoundFixture();
    vi.spyOn(fixture.harness.runtime, "reconfigureThread").mockResolvedValue({
      acceptance: "accepted",
      diagnostic: null,
      providerRequestId: "provider-request-accepted",
      providerThreadId: PROVIDER_THREAD_ID,
    });

    await expect(
      changeSessionModel(
        modelChangeCommand(fixture.incarnation),
        fixture.options,
      ),
    ).resolves.toEqual({
      acceptance: "accepted",
      diagnostic: null,
      effectiveAccount: null,
      effectiveModel: {
        modelId: executionOptions.model,
        providerId: "codex",
      },
      observedCursor: null,
      providerRequestId: "provider-request-accepted",
      providerTurnId: null,
      requestedModel: {
        modelId: executionOptions.model,
        providerId: "codex",
      },
    });
    expect(fixture.options.sessionRuntimeBroker.get(BINDING_ID)?.phase).toBe(
      "idle",
    );
  });

  it("fences an ambiguous post-dispatch outcome for reconciliation", async () => {
    const fixture = await createBoundFixture();
    vi.spyOn(fixture.harness.runtime, "reconfigureThread").mockResolvedValue({
      acceptance: "outcome_unknown",
      diagnostic: "provider process exited after dispatch",
      providerRequestId: "provider-request-ambiguous",
      providerThreadId: PROVIDER_THREAD_ID,
    });

    await expect(
      changeSessionModel(
        modelChangeCommand(fixture.incarnation),
        fixture.options,
      ),
    ).resolves.toMatchObject({
      acceptance: "outcome_unknown",
      providerRequestId: "provider-request-ambiguous",
    });
    expect(fixture.options.sessionRuntimeBroker.get(BINDING_ID)?.phase).toBe(
      "outcome_unknown",
    );
  });

  it("stages, verifies, and enables a destination through distinct broker checkpoints", async () => {
    const fixture = await createStagedDestinationFixture();
    expect(fixture.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        executionSafety: "handoff_restatement",
        providerId: "claude-code",
        threadId: DESTINATION_THREAD_ID,
      }),
    );
    expect(fixture.startThread.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(fixture.staged.control).toMatchObject({
      controlEpoch: 0,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      mutationPolicy: "staged_read_only",
    });

    const capsule = capsuleForWorkspace(
      fixture.staged.inspection.workspaceState,
    );
    const expectedRestatement = restatementForCapsule(capsule);
    const input = destinationRestatementInput(
      "server-owned verbatim restatement input",
    );
    const runRestatement = vi
      .spyOn(fixture.harness.runtime, "runTurnAndWaitForCompletion")
      .mockResolvedValue({
        assistantText: JSON.stringify(expectedRestatement),
        errorMessage: null,
        status: "completed",
        turnId: "turn-destination-restatement",
      });
    const restated = await restateSessionHandoffDestination(
      {
        bindingId: DESTINATION_BINDING_ID,
        bootNonce: fixture.incarnation.bootNonce,
        capsule,
        endpointFingerprint: fixture.incarnation.endpointFingerprint,
        environmentId: ENVIRONMENT_ID,
        expectedControlEpoch: fixture.staged.control.controlEpoch,
        input,
        requestId: "creq_destination_restatement",
        runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
        threadId: DESTINATION_THREAD_ID,
        timeoutMs: 30_000,
        transitionId: HANDOFF_TRANSITION_ID,
        type: "session.handoff.restate_destination",
      },
      fixture.options,
    );
    expect(restated).toMatchObject({
      control: {
        controlEpoch: 1,
        executionSafety: "handoff_restatement",
        handoffCheckpoint: "destination_restated",
        mutationPolicy: "staged_read_only",
      },
      restatement: expectedRestatement,
      turnId: "turn-destination-restatement",
    });
    expect(runRestatement.mock.calls[0]?.[0].input).toBe(input);

    const reconfigure = vi
      .spyOn(fixture.harness.runtime, "reconfigureThread")
      .mockImplementation(async () => {
        fixture.setExecutionSafety("standard");
        return {
          acceptance: "accepted",
          diagnostic: null,
          providerRequestId: "provider-request-enable-destination",
          providerThreadId: `provider-${DESTINATION_THREAD_ID}`,
        };
      });
    const enabled = await enableSessionHandoffDestination(
      {
        bindingId: DESTINATION_BINDING_ID,
        bootNonce: fixture.incarnation.bootNonce,
        endpointFingerprint: fixture.incarnation.endpointFingerprint,
        environmentId: ENVIRONMENT_ID,
        expectedControlEpoch: restated.control.controlEpoch,
        runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
        threadId: DESTINATION_THREAD_ID,
        transitionId: HANDOFF_TRANSITION_ID,
        type: "session.handoff.enable_destination",
      },
      fixture.options,
    );
    expect(reconfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        executionSafety: "standard",
        threadId: DESTINATION_THREAD_ID,
      }),
    );
    expect(enabled).toMatchObject({
      acceptance: "accepted",
      control: {
        controlEpoch: 2,
        executionSafety: "standard",
        handoffCheckpoint: "destination_restated",
        mutationPolicy: "enabled",
      },
      providerRequestId: "provider-request-enable-destination",
    });
  });

  it("stops a newly created isolated destination when stage validation fails", async () => {
    const fixture = await createDestinationStageFixture();
    fixture.stageCommand.expectedWorkspaceState = {
      ...fixture.stageCommand.expectedWorkspaceState,
      diffDigest: "sha256:unexpected-diff",
    };
    const stopThread = vi.spyOn(fixture.harness.runtime, "stopThread");

    await expect(
      stageSessionHandoffDestination(fixture.stageCommand, fixture.options),
    ).rejects.toMatchObject({ code: "destination_workspace_mismatch" });

    expect(fixture.startThread).toHaveBeenCalledTimes(1);
    expect(stopThread).toHaveBeenCalledWith({
      threadId: DESTINATION_THREAD_ID,
    });
    expect(
      fixture.options.sessionRuntimeBroker.get(DESTINATION_BINDING_ID),
    ).toBeNull();
    expect(fixture.harness.runtime.hasThread(DESTINATION_THREAD_ID)).toBe(
      false,
    );
  });

  it("recovers an unpersisted staged destination after exact old-process death and replays the recovered stage", async () => {
    const fixture = await createStagedDestinationFixture();
    fixture.harness.threadControls.clearProviderSession(DESTINATION_THREAD_ID);

    const recovered = await stageSessionHandoffDestination(
      fixture.stageCommand,
      fixture.options,
    );
    expect(fixture.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        executionSafety: "handoff_restatement",
        providerId: "claude-code",
        providerThreadId: `provider-${DESTINATION_THREAD_ID}`,
        threadId: DESTINATION_THREAD_ID,
      }),
    );
    expect(fixture.resumeThread.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(recovered).toMatchObject({
      control: {
        controlEpoch: 1,
        incarnation: fixture.recoveredIncarnation,
      },
      inspection: {
        incarnation: fixture.recoveredIncarnation,
        providerThreadId: `provider-${DESTINATION_THREAD_ID}`,
      },
    });

    await expect(
      stageSessionHandoffDestination(fixture.stageCommand, fixture.options),
    ).resolves.toMatchObject({
      control: recovered.control,
      inspection: {
        incarnation: fixture.recoveredIncarnation,
      },
    });
    expect(fixture.resumeThread).toHaveBeenCalledTimes(1);
  });

  it("keeps an unpersisted staged destination fenced while its recorded provider process may be alive", async () => {
    const fixture = await createStagedDestinationFixture("alive");
    fixture.harness.threadControls.clearProviderSession(DESTINATION_THREAD_ID);

    await expect(
      stageSessionHandoffDestination(fixture.stageCommand, fixture.options),
    ).rejects.toMatchObject({ code: "runtime_process_alive" });
    expect(fixture.resumeThread).not.toHaveBeenCalled();
  });

  it("keeps a destination staged when its restatement differs from the sealed capsule", async () => {
    const fixture = await createStagedDestinationFixture();
    const capsule = capsuleForWorkspace(
      fixture.staged.inspection.workspaceState,
    );
    vi.spyOn(
      fixture.harness.runtime,
      "runTurnAndWaitForCompletion",
    ).mockResolvedValue({
      assistantText: JSON.stringify({
        ...restatementForCapsule(capsule),
        objective: "A different objective",
      }),
      errorMessage: null,
      status: "completed",
      turnId: "turn-mismatched-restatement",
    });

    await expect(
      restateSessionHandoffDestination(
        {
          bindingId: DESTINATION_BINDING_ID,
          bootNonce: fixture.incarnation.bootNonce,
          capsule,
          endpointFingerprint: fixture.incarnation.endpointFingerprint,
          environmentId: ENVIRONMENT_ID,
          expectedControlEpoch: fixture.staged.control.controlEpoch,
          input: destinationRestatementInput(),
          requestId: "creq_mismatched_restatement",
          runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
          threadId: DESTINATION_THREAD_ID,
          timeoutMs: 30_000,
          transitionId: HANDOFF_TRANSITION_ID,
          type: "session.handoff.restate_destination",
        },
        fixture.options,
      ),
    ).rejects.toMatchObject({ code: "destination_restatement_mismatch" });
    expect(
      fixture.options.sessionRuntimeBroker.get(DESTINATION_BINDING_ID),
    ).toMatchObject({
      controlEpoch: 0,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      mutationPolicy: "staged_read_only",
      phase: "idle",
    });
  });

  it("does not open mutation when the provider rejects removal of the isolation overlay", async () => {
    const fixture = await createStagedDestinationFixture();
    const capsule = capsuleForWorkspace(
      fixture.staged.inspection.workspaceState,
    );
    vi.spyOn(
      fixture.harness.runtime,
      "runTurnAndWaitForCompletion",
    ).mockResolvedValue({
      assistantText: JSON.stringify(restatementForCapsule(capsule)),
      errorMessage: null,
      status: "completed",
      turnId: "turn-valid-restatement",
    });
    const restated = await restateSessionHandoffDestination(
      {
        bindingId: DESTINATION_BINDING_ID,
        bootNonce: fixture.incarnation.bootNonce,
        capsule,
        endpointFingerprint: fixture.incarnation.endpointFingerprint,
        environmentId: ENVIRONMENT_ID,
        expectedControlEpoch: fixture.staged.control.controlEpoch,
        input: destinationRestatementInput(),
        requestId: "creq_valid_restatement",
        runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
        threadId: DESTINATION_THREAD_ID,
        timeoutMs: 30_000,
        transitionId: HANDOFF_TRANSITION_ID,
        type: "session.handoff.restate_destination",
      },
      fixture.options,
    );
    vi.spyOn(fixture.harness.runtime, "reconfigureThread").mockResolvedValue({
      acceptance: "not_accepted",
      diagnostic: "provider cannot acknowledge reconfiguration",
      providerRequestId: "provider-request-rejected",
      providerThreadId: `provider-${DESTINATION_THREAD_ID}`,
    });

    await expect(
      enableSessionHandoffDestination(
        {
          bindingId: DESTINATION_BINDING_ID,
          bootNonce: fixture.incarnation.bootNonce,
          endpointFingerprint: fixture.incarnation.endpointFingerprint,
          environmentId: ENVIRONMENT_ID,
          expectedControlEpoch: restated.control.controlEpoch,
          runtimeInstanceId: fixture.incarnation.runtimeInstanceId,
          threadId: DESTINATION_THREAD_ID,
          transitionId: HANDOFF_TRANSITION_ID,
          type: "session.handoff.enable_destination",
        },
        fixture.options,
      ),
    ).resolves.toMatchObject({
      acceptance: "not_accepted",
      control: null,
    });
    expect(
      fixture.options.sessionRuntimeBroker.get(DESTINATION_BINDING_ID),
    ).toMatchObject({
      controlEpoch: 1,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_restated",
      mutationPolicy: "staged_read_only",
      phase: "idle",
    });
  });
});
