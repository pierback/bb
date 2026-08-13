import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  abortSessionHandoff,
  advanceSessionHandoff,
  applySessionCommandEvent,
  assertSessionThreadIngressAllowed,
  authorizeSessionHandoffDestination,
  captureSessionHandoffWorkspaceSnapshot,
  compareAndSwapActiveSessionBinding,
  confirmSessionHandoffUserReview,
  createConnection,
  createSessionLineage,
  createSessionHandoffTransition,
  createSessionRuntimeRecipe,
  draftSessionCommand,
  enablePreparedSessionAdoption,
  environments,
  finalizePreparedSessionAdoption,
  enableSessionHandoffDestinationMutation,
  fenceSessionHandoffSourceIngress,
  getActiveSessionModelEpoch,
  getSessionCommandAudit,
  getSessionExecutionBindingContext,
  getSessionAdoptionForRetry,
  getSessionFabricThreadConnection,
  getSessionHandoffAudit,
  hosts,
  initializeSessionModelEpoch,
  listSessionCommandEvents,
  listSessionFabricEnvironmentConnections,
  migrate,
  openSessionExecutionBinding,
  prepareSessionAdoption,
  projects,
  recordSessionRuntimeInstance,
  recordSessionWorkspaceState,
  recoverSessionExecutionBinding,
  retireSessionHandoffSource,
  sessionFabricBranches,
  sessionFabricAdoptions,
  sessionFabricModelEpochs,
  sessionFabricRuntimeInstances,
  sessionFabricWorkspaceStates,
  sealSessionContextCapsule,
  SessionFabricPersistenceError,
  stageSessionHandoffDestination,
  swapSessionHandoffActiveBinding,
  settleSessionModelChange,
  threads,
  upsertSessionNativeConversation,
  verifySessionHandoffDestinationRestatement,
  type DbConnection,
  type SessionFabricExecutionBindingRow,
  type SessionAdoptionRuntimeInspection,
} from "../../src/index.js";

const NOW = 10_000;
const HOST_ID = "host_session_fabric";
const PROJECT_ID = "proj_session_fabric";

function setup(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);
  db.insert(hosts)
    .values({
      id: HOST_ID,
      name: "Session Fabric host",
      type: "persistent",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Session Fabric project",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return db;
}

function seedAdoptionTarget(db: DbConnection) {
  const environmentId = "environment_adoption";
  const threadId = "thread_adoption";
  db.insert(environments)
    .values({
      id: environmentId,
      projectId: PROJECT_ID,
      hostId: HOST_ID,
      path: "/repo",
      managed: true,
      isGitRepo: true,
      branchName: "bb/adoption",
      workspaceProvisionType: "managed-worktree",
      status: "ready",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(threads)
    .values({
      id: threadId,
      projectId: PROJECT_ID,
      environmentId,
      providerId: "codex",
      status: "idle",
      latestAttentionAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const nativeConversation = upsertSessionNativeConversation(db, {
    cwd: "/repo",
    hostId: HOST_ID,
    lastObservedAt: NOW,
    nativeConversationId: "native_adoption",
    projectId: PROJECT_ID,
    providerId: "codex",
    providerInstanceId: "codex:subscription:default",
    providerState: "provider_reported_idle",
    title: "Adoptable Codex session",
  });
  const inspection: SessionAdoptionRuntimeInspection = {
    environmentId,
    execution: {
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      reasoningLevel: "medium",
      serviceTier: "default",
    },
    incarnation: {
      bootNonce: "boot_nonce_adoption_1234567890",
      connectorId: "codex-app-server",
      endpointFingerprint: "stdio:adoption",
      processKey: "codex\0adoption",
      providerId: "codex",
      runtimeInstanceId: "runtime_adoption",
      startedAt: NOW,
    },
    ownership: "owned_brokered",
    phase: "idle",
    providerId: "codex",
    providerInstanceId: "codex:subscription:default",
    providerThreadId: "native_adoption",
    runtimeRecipe: {
      cwd: "/repo",
      environmentFingerprint: "sha256:environment-adoption",
      environmentReferenceIds: [environmentId],
      mcpServersFingerprint: "sha256:mcp-adoption",
      permissionMode: "auto",
      pluginsFingerprint: "sha256:plugins-adoption",
      sandboxProfile: "workspace-write",
      toolsFingerprint: "sha256:tools-adoption",
      workspaceWriteRoots: ["/repo"],
    },
    threadId,
    turnId: null,
    workspaceState: {
      backgroundResources: [],
      capturedAt: NOW,
      diffDigest: "sha256:diff-adoption",
      digestAlgorithm: "bb-session-workspace-v1:sha256",
      externalSideEffectStatus: "unknown",
      headSha: "abc123",
      indexDigest: "sha256:index-adoption",
      rootPath: "/repo",
      untrackedManifestDigest: "sha256:untracked-adoption",
      watcherGeneration: 0,
      worktreeId: "worktree:adoption",
    },
  };
  return { environmentId, inspection, nativeConversation, threadId };
}

function seedBinding(
  db: DbConnection,
  args: {
    activate?: boolean;
    bindingId?: string;
    branchId?: string;
    environmentId?: string;
    mutationPolicy?: "enabled" | "staged_read_only";
    permissionMode?: "accept-edits" | "auto" | "full";
    providerId?: string;
    providerInstanceId?: string;
    threadId?: string;
    workspaceStateId?: string;
  } = {},
): SessionFabricExecutionBindingRow {
  const lineage =
    args.branchId === undefined
      ? createSessionLineage(db, {
          createdAt: NOW,
          objective: "Safely continue provider-native work",
          projectId: PROJECT_ID,
          title: "Session Fabric",
        })
      : null;
  const branchId = args.branchId ?? lineage!.branch.id;
  const providerId = args.providerId ?? "codex";
  const providerInstanceId =
    args.providerInstanceId ?? "codex:subscription:default";
  const environmentId =
    args.environmentId ?? `environment_${args.bindingId ?? "one"}`;
  const threadId = args.threadId ?? `thread_${args.bindingId ?? "one"}`;
  const existingEnvironment = db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (!existingEnvironment) {
    db.insert(environments)
      .values({
        id: environmentId,
        projectId: PROJECT_ID,
        hostId: HOST_ID,
        path: `/repo/${environmentId}`,
        managed: true,
        isGitRepo: true,
        branchName: "bb/session-fabric",
        workspaceProvisionType: "managed-worktree",
        status: "ready",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
  const existingThread = db
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();
  if (!existingThread) {
    db.insert(threads)
      .values({
        id: threadId,
        projectId: PROJECT_ID,
        environmentId,
        providerId,
        status: "idle",
        latestAttentionAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
  const nativeConversation = upsertSessionNativeConversation(db, {
    cwd: "/repo",
    hostId: HOST_ID,
    lastObservedAt: NOW,
    nativeConversationId: `native_${args.bindingId ?? "one"}`,
    projectId: PROJECT_ID,
    providerId,
    providerInstanceId,
    providerState: "idle",
    title: "Native session",
  });
  const runtimeId = `runtime_${args.bindingId ?? "one"}`;
  recordSessionRuntimeInstance(db, {
    bootNonce: `boot_nonce_${runtimeId}_1234567890`,
    connectorId: `${providerId}-connector`,
    endpointFingerprint: `sha256:endpoint:${runtimeId}`,
    hostId: HOST_ID,
    id: runtimeId,
    processKey: `process:${runtimeId}`,
    providerId,
    providerInstanceId,
    startedAt: NOW,
    status: "live",
    stoppedAt: null,
  });
  const recipe = createSessionRuntimeRecipe(db, {
    createdAt: NOW,
    cwd: "/repo",
    environmentFingerprint: "sha256:env",
    environmentReferenceIds: ["shell:default"],
    mcpServersFingerprint: "sha256:mcp",
    permissionMode: args.permissionMode ?? "auto",
    pluginsFingerprint: "sha256:plugins",
    sandboxProfile: "workspace-write",
    toolsFingerprint: "sha256:tools",
    workspaceWriteRoots: ["/repo"],
  });
  const workspaceStateId =
    args.workspaceStateId ?? `workspace_${args.bindingId ?? "one"}`;
  if (args.workspaceStateId === undefined) {
    recordSessionWorkspaceState(db, {
      backgroundResources: [],
      capturedAt: NOW,
      diffDigest: "sha256:diff",
      digestAlgorithm: "session-workspace-v1",
      externalSideEffectStatus: "not_observed",
      headSha: "abc123",
      hostId: HOST_ID,
      id: workspaceStateId,
      indexDigest: "sha256:index",
      rootPath: "/repo",
      untrackedManifestDigest: "sha256:untracked",
      watcherGeneration: 1,
      worktreeId: "worktree:repo",
    });
  }
  const binding = openSessionExecutionBinding(db, {
    controlEpoch: 1,
    environmentId,
    id: args.bindingId,
    nativeConversationId: nativeConversation.id,
    nativeCursor: "cursor:10",
    mutationPolicy: args.mutationPolicy ?? "enabled",
    openedAt: NOW,
    ownership: "owned_brokered",
    phase: "idle",
    providerTurnId: null,
    runtimeInstanceId: runtimeId,
    runtimeRecipeId: recipe.id,
    threadId,
    workspaceStateId,
    workstreamBranchId: branchId,
  });
  if (args.activate !== false) {
    compareAndSwapActiveSessionBinding(db, {
      branchId,
      expectedBindingId: null,
      nextBindingId: binding.id,
      updatedAt: NOW,
    });
  }
  return binding;
}

function advanceToDispatched(db: DbConnection, commandId: string): void {
  expect(
    applySessionCommandEvent(db, {
      commandId,
      event: "authorize",
      occurredAt: NOW + 1,
    }).applied,
  ).toBe(true);
  expect(
    applySessionCommandEvent(db, {
      commandId,
      event: "dispatch",
      occurredAt: NOW + 2,
    }).applied,
  ).toBe(true);
}

const PI_MODEL = { modelId: "pi-model", providerId: "pi" } as const;
const PI_PROVIDER_INSTANCE_ID = "pi:api-key:test";

function createHandoffAtWorkspaceSnapshot(
  db: DbConnection,
  source: SessionFabricExecutionBindingRow,
  transitionId: string,
) {
  const sourceContext = getSessionExecutionBindingContext(db, source.id);
  if (!sourceContext?.environment) {
    throw new Error("handoff source requires an environment");
  }
  const destinationThreadId = `${transitionId}_destination_thread`;
  db.insert(threads)
    .values({
      id: destinationThreadId,
      projectId: PROJECT_ID,
      environmentId: sourceContext.environment.id,
      providerId: "pi",
      status: "idle",
      latestAttentionAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const workspace = recordSessionWorkspaceState(db, {
    backgroundResources: [],
    capturedAt: NOW + 10,
    diffDigest: "sha256:diff",
    digestAlgorithm: "session-workspace-v1",
    externalSideEffectStatus: "not_observed",
    headSha: "abc123",
    hostId: HOST_ID,
    id: `${transitionId}_workspace`,
    indexDigest: "sha256:index",
    rootPath: "/repo",
    untrackedManifestDigest: "sha256:untracked",
    watcherGeneration: 2,
    worktreeId: "worktree:repo",
  });
  createSessionHandoffTransition(db, {
    createdAt: NOW + 1,
    destinationEnvironmentId: sourceContext.environment.id,
    destinationHostId: HOST_ID,
    destinationModel: PI_MODEL,
    destinationProviderInstanceId: PI_PROVIDER_INSTANCE_ID,
    destinationReasoningLevel: "high",
    destinationServiceTier: "default",
    destinationThreadId,
    destinationWorkspaceDisposition: "source_worktree",
    id: transitionId,
    idempotencyKey: `${transitionId}:idempotency`,
    requestHash: `sha256:${"a".repeat(64)}`,
    sourceBindingId: source.id,
  });
  advanceSessionHandoff(db, {
    event: "start_target_preflight",
    occurredAt: NOW + 2,
    transitionId,
  });
  fenceSessionHandoffSourceIngress(db, {
    expectedControlEpoch: 1,
    fencedAt: NOW + 3,
    fencedControlEpoch: 2,
    transitionId,
  });
  advanceSessionHandoff(db, {
    event: "begin_source_quiesce",
    occurredAt: NOW + 4,
    transitionId,
  });
  advanceSessionHandoff(db, {
    event: "begin_source_reconcile",
    occurredAt: NOW + 5,
    transitionId,
  });
  const transition = captureSessionHandoffWorkspaceSnapshot(db, {
    capturedAt: NOW + 10,
    expectedWorkspaceStateId: workspace.id,
    settlement: {
      acceptedQueueCount: 0,
      activeBackgroundResourceCount: 0,
      activeToolCount: 0,
      compacting: false,
      externalSideEffectStatus: "not_observed",
      outcomeUnknown: false,
      partialEdit: false,
      retrying: false,
      unknownBackgroundResourceCount: 0,
      unresolvedInteractionCount: 0,
    },
    sourceWorkspaceStateId: workspace.id,
    transitionId,
  });
  return {
    destinationEnvironmentId: sourceContext.environment.id,
    destinationThreadId,
    transition,
    workspace,
  };
}

function capsuleDraft() {
  return {
    ambiguities: [],
    constraints: ["destination stays read-only before the swap"],
    decisions: ["continue with Pi"],
    destinationToolDifferences: ["Codex-only tool is unavailable"],
    evidence: [
      {
        contentHash: `sha256:${"b".repeat(64)}`,
        kind: "turn" as const,
        nativeCursor: "cursor:10",
        provenance: "codex:native-source",
        trust: "untrusted_evidence" as const,
      },
    ],
    failureAcceptance: null,
    instructions: ["Follow AGENTS.md"],
    objective: "finish Session Fabric",
    openTasks: ["verify provider continuation"],
    plan: ["stage Pi read-only", "swap atomically"],
    rejectedApproaches: ["forge a Pi transcript"],
    schemaVersion: 1 as const,
    sensitivityLabels: ["source-code"],
    successCriteria: ["workspace hash gate passes"],
    transferManifest: [
      {
        action: "drop" as const,
        contentHash: null,
        kind: "approval" as const,
        reason: "approvals never cross provider boundaries",
      },
    ],
    unresolvedSideEffects: [],
  };
}

function stageHandoffDestination(
  db: DbConnection,
  source: SessionFabricExecutionBindingRow,
  transitionId: string,
) {
  const { destinationEnvironmentId, destinationThreadId, workspace } =
    createHandoffAtWorkspaceSnapshot(
    db,
    source,
    transitionId,
  );
  const capsule = sealSessionContextCapsule(db, {
    capsule: capsuleDraft(),
    createdAt: NOW + 11,
    id: `${transitionId}_capsule`,
    transitionId,
  });
  confirmSessionHandoffUserReview(db, {
    capsuleContentHash: capsule.contentHash,
    reviewedAt: NOW + 12,
    reviewerId: "user:test",
    transitionId,
  });
  authorizeSessionHandoffDestination(db, {
    authorizedAt: NOW + 13,
    billingAuthorizationId: "billing-auth:test",
    billingRouteId: "billing-route:pi",
    destinationModel: PI_MODEL,
    destinationProviderInstanceId: PI_PROVIDER_INSTANCE_ID,
    id: `${transitionId}_authorization`,
    permissionMode: "auto",
    policyVersion: 1,
    transitionId,
  });
  advanceSessionHandoff(db, {
    event: "begin_destination_stage",
    occurredAt: NOW + 13,
    transitionId,
  });
  const destinationBindingId = `${transitionId}_destination`;
  const incarnation = {
    bootNonce: `${transitionId}_destination_boot_nonce_1234567890`,
    connectorId: "pi-sdk",
    endpointFingerprint: `stdio:${transitionId}:destination`,
    processKey: `pi\0${transitionId}`,
    providerId: "pi",
    runtimeInstanceId: `${transitionId}_destination_runtime`,
    startedAt: NOW + 14,
  };
  const inspection = {
    environmentId: destinationEnvironmentId,
    execution: {
      effectiveModel: PI_MODEL,
      reasoningLevel: "high" as const,
      serviceTier: "default" as const,
    },
    executionSafety: "handoff_restatement" as const,
    incarnation,
    ownership: "owned_brokered" as const,
    phase: "idle" as const,
    providerId: "pi",
    providerInstanceId: PI_PROVIDER_INSTANCE_ID,
    providerThreadId: `${transitionId}_pi_native_thread`,
    runtimeRecipe: {
      cwd: workspace.rootPath,
      environmentFingerprint: `sha256:${transitionId}:environment`,
      environmentReferenceIds: [destinationEnvironmentId],
      mcpServersFingerprint: `sha256:${transitionId}:mcp`,
      permissionMode: "auto" as const,
      pluginsFingerprint: `sha256:${transitionId}:plugins`,
      sandboxProfile: "workspace-write",
      toolsFingerprint: `sha256:${transitionId}:tools`,
      workspaceWriteRoots: [workspace.rootPath],
    },
    threadId: destinationThreadId,
    turnId: null,
    workspaceState: {
      backgroundResources: workspace.backgroundResources,
      capturedAt: NOW + 14,
      diffDigest: workspace.diffDigest,
      digestAlgorithm: workspace.digestAlgorithm,
      externalSideEffectStatus: workspace.externalSideEffectStatus,
      headSha: workspace.headSha,
      indexDigest: workspace.indexDigest,
      rootPath: workspace.rootPath,
      untrackedManifestDigest: workspace.untrackedManifestDigest,
      watcherGeneration: workspace.watcherGeneration,
      worktreeId: workspace.worktreeId,
    },
  };
  stageSessionHandoffDestination(db, {
    control: {
      bindingId: destinationBindingId,
      controlEpoch: 0,
      environmentId: destinationEnvironmentId,
      executionSafety: "handoff_restatement",
      handoffCheckpoint: "destination_staged",
      handoffRole: "destination",
      handoffTransitionId: transitionId,
      incarnation,
      mutationPolicy: "staged_read_only",
      nativeCursor: null,
      ownership: "owned_brokered",
      phase: "idle",
      providerInstanceId: PI_PROVIDER_INSTANCE_ID,
      threadId: destinationThreadId,
      turnId: null,
      workspaceId: workspace.rootPath,
    },
    destinationBindingId,
    effectiveAccount: null,
    effectiveModel: PI_MODEL,
    inspection,
    stagedAt: NOW + 14,
    transitionId,
  });
  const destination = getSessionExecutionBindingContext(
    db,
    destinationBindingId,
  )?.binding;
  if (!destination) {
    throw new Error("handoff destination was not persisted");
  }
  const restatement = {
    ambiguities: capsule.ambiguities,
    capsuleContentHash: capsule.contentHash,
    constraints: capsule.constraints,
    decisions: capsule.decisions,
    destinationToolDifferences: capsule.destinationToolDifferences,
    expectedWorkspace: {
      diffDigest: workspace.diffDigest,
      digestAlgorithm: workspace.digestAlgorithm,
      headSha: workspace.headSha,
      indexDigest: workspace.indexDigest,
      rootPath: workspace.rootPath,
      untrackedManifestDigest: workspace.untrackedManifestDigest,
      worktreeId: workspace.worktreeId,
    },
    objective: capsule.objective,
    openTasks: capsule.openTasks,
  };
  return { capsule, destination, restatement, workspace };
}

describe("Session Fabric server ledger", () => {
  it("projects the exact provider-native connection for a thread and worktree", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_projection" });
    initializeSessionModelEpoch(db, {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      bindingId: binding.id,
      effectiveAccount: null,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      reasoningLevel: "high",
      requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      serviceTier: "default",
    });

    const connection = getSessionFabricThreadConnection(
      db,
      "thread_binding_projection",
    );
    expect(connection).toMatchObject({
      adoptionStatus: null,
      bindingId: binding.id,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      environmentId: "environment_binding_projection",
      isActiveAuthority: true,
      mutationPolicy: "enabled",
      nativeConversation: {
        hostId: HOST_ID,
        nativeConversationId: "native_binding_projection",
        providerId: "codex",
        providerInstanceId: "codex:subscription:default",
        title: "Native session",
      },
      reasoningLevel: "high",
      runtime: { id: "runtime_binding_projection", status: "live" },
      serviceTier: "default",
      threadId: "thread_binding_projection",
    });
    expect(
      listSessionFabricEnvironmentConnections(
        db,
        "environment_binding_projection",
      ),
    ).toEqual([connection]);
    expect(getSessionFabricThreadConnection(db, "thread_missing")).toBeNull();
  });

  it("prepares one durable adoption topology and fences ordinary ingress", () => {
    const db = setup();
    const target = seedAdoptionTarget(db);
    const request = {
      catalogConversationId: target.nativeConversation.id,
      idempotencyKey: "session-adoption-request-0001",
      objective: "Continue the discovered Codex session safely",
      threadId: target.threadId,
      title: "Adopt discovered Codex session",
    };

    const prepared = prepareSessionAdoption(db, {
      ...request,
      inspection: target.inspection,
      preparedAt: NOW + 1,
    });

    expect(prepared.adoption.status).toBe("prepared");
    expect(prepared.bindingContext.binding).toMatchObject({
      controlEpoch: 0,
      environmentId: target.environmentId,
      mutationPolicy: "staged_read_only",
      phase: "attaching",
      threadId: target.threadId,
    });
    expect(prepared.bindingContext.branch.activeBindingId).toBe(
      prepared.adoption.bindingId,
    );
    expect(prepared.bindingContext.workstream.activeBranchId).toBe(
      prepared.adoption.branchId,
    );
    expect(() =>
      assertSessionThreadIngressAllowed(db, target.threadId),
    ).toThrowError(expect.objectContaining({ code: "binding_ingress_fenced" }));

    const retry = prepareSessionAdoption(db, {
      ...request,
      inspection: target.inspection,
      preparedAt: NOW + 2,
    });
    expect(retry.adoption).toEqual(prepared.adoption);
    expect(getSessionAdoptionForRetry(db, request)?.adoption).toEqual(
      prepared.adoption,
    );

    expect(() =>
      getSessionAdoptionForRetry(db, {
        ...request,
        title: "Conflicting adoption request",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "adoption_idempotency_conflict" }),
    );
    expect(() =>
      prepareSessionAdoption(db, {
        ...request,
        idempotencyKey: "session-adoption-request-0002",
        inspection: target.inspection,
      }),
    ).toThrowError(expect.objectContaining({ code: "thread_already_bound" }));
  });

  it("finalizes and enables an adoption only from exact host control evidence", () => {
    const db = setup();
    const target = seedAdoptionTarget(db);
    const prepared = prepareSessionAdoption(db, {
      catalogConversationId: target.nativeConversation.id,
      idempotencyKey: "session-adoption-request-0003",
      inspection: target.inspection,
      objective: "Continue the discovered Codex session safely",
      preparedAt: NOW + 1,
      threadId: target.threadId,
      title: "Adopt discovered Codex session",
    });
    const stagedControl = {
      bindingId: prepared.adoption.bindingId,
      controlEpoch: 0,
      environmentId: target.environmentId,
      incarnation: target.inspection.incarnation,
      mutationPolicy: "staged_read_only" as const,
      nativeCursor: null,
      ownership: "owned_brokered" as const,
      phase: "idle" as const,
      providerInstanceId: target.inspection.providerInstanceId,
      threadId: target.threadId,
      turnId: null,
      workspaceId: target.inspection.workspaceState.rootPath,
    };

    const hostBound = finalizePreparedSessionAdoption(db, {
      adoptionId: prepared.adoption.id,
      control: stagedControl,
      finalizedAt: NOW + 2,
    });
    expect(hostBound.adoption.status).toBe("host_bound");
    expect(hostBound.bindingContext.binding).toMatchObject({
      controlEpoch: 0,
      mutationPolicy: "staged_read_only",
      phase: "idle",
    });
    expect(() =>
      assertSessionThreadIngressAllowed(db, target.threadId),
    ).toThrowError(expect.objectContaining({ code: "binding_ingress_fenced" }));

    const enabledControl = {
      ...stagedControl,
      controlEpoch: 1,
      mutationPolicy: "enabled" as const,
    };
    const enabled = enablePreparedSessionAdoption(db, {
      adoptionId: prepared.adoption.id,
      control: enabledControl,
      enabledAt: NOW + 3,
    });
    expect(enabled.adoption.status).toBe("enabled");
    expect(enabled.bindingContext.binding).toMatchObject({
      controlEpoch: 1,
      mutationPolicy: "enabled",
      phase: "idle",
    });
    expect(() =>
      assertSessionThreadIngressAllowed(db, target.threadId),
    ).not.toThrow();
    expect(
      enablePreparedSessionAdoption(db, {
        adoptionId: prepared.adoption.id,
        control: enabledControl,
        enabledAt: NOW + 4,
      }).adoption,
    ).toEqual(enabled.adoption);
  });

  it("keeps a prepared adoption unchanged when host evidence does not match", () => {
    const db = setup();
    const target = seedAdoptionTarget(db);
    const prepared = prepareSessionAdoption(db, {
      catalogConversationId: target.nativeConversation.id,
      idempotencyKey: "session-adoption-request-0004",
      inspection: target.inspection,
      objective: "Continue the discovered Codex session safely",
      preparedAt: NOW + 1,
      threadId: target.threadId,
      title: "Adopt discovered Codex session",
    });

    expect(() =>
      finalizePreparedSessionAdoption(db, {
        adoptionId: prepared.adoption.id,
        control: {
          bindingId: prepared.adoption.bindingId,
          controlEpoch: 0,
          environmentId: target.environmentId,
          incarnation: {
            ...target.inspection.incarnation,
            endpointFingerprint: "stdio:different-runtime",
          },
          mutationPolicy: "staged_read_only",
          nativeCursor: null,
          ownership: "owned_brokered",
          phase: "idle",
          providerInstanceId: target.inspection.providerInstanceId,
          threadId: target.threadId,
          turnId: null,
          workspaceId: target.inspection.workspaceState.rootPath,
        },
        finalizedAt: NOW + 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_binding_topology" }),
    );
    expect(
      db
        .select()
        .from(sessionFabricAdoptions)
        .where(eq(sessionFabricAdoptions.id, prepared.adoption.id))
        .get(),
    ).toMatchObject({ status: "prepared", updatedAt: NOW + 1 });
    expect(
      getSessionAdoptionForRetry(db, {
        catalogConversationId: target.nativeConversation.id,
        idempotencyKey: "session-adoption-request-0004",
        objective: "Continue the discovered Codex session safely",
        threadId: target.threadId,
        title: "Adopt discovered Codex session",
      })?.bindingContext.binding,
    ).toMatchObject({ phase: "attaching", mutationPolicy: "staged_read_only" });
  });

  it("creates lineage and swaps the active binding only with an exact CAS", () => {
    const db = setup();
    const first = seedBinding(db, { bindingId: "binding_first" });
    const branch = db
      .select()
      .from(sessionFabricBranches)
      .where(eq(sessionFabricBranches.id, first.workstreamBranchId))
      .get();
    expect(branch?.activeBindingId).toBe(first.id);

    const second = seedBinding(db, {
      activate: false,
      bindingId: "binding_second",
      branchId: first.workstreamBranchId,
    });
    compareAndSwapActiveSessionBinding(db, {
      branchId: first.workstreamBranchId,
      expectedBindingId: first.id,
      nextBindingId: second.id,
      updatedAt: NOW + 1,
    });
    expect(() =>
      compareAndSwapActiveSessionBinding(db, {
        branchId: first.workstreamBranchId,
        expectedBindingId: first.id,
        nextBindingId: first.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "active_binding_changed" }));
  });

  it("rejects runtime-id reuse with different incarnation evidence", () => {
    const db = setup();
    seedBinding(db, { bindingId: "binding_runtime" });
    expect(() =>
      recordSessionRuntimeInstance(db, {
        bootNonce: "different_boot_nonce_1234567890",
        connectorId: "codex-app-server",
        endpointFingerprint: "sha256:other-endpoint",
        hostId: HOST_ID,
        id: "runtime_binding_runtime",
        processKey: "process:runtime_binding_runtime",
        providerId: "codex",
        providerInstanceId: "codex:subscription:default",
        startedAt: NOW,
        status: "live",
        stoppedAt: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "runtime_incarnation_conflict" }),
    );
  });

  it("atomically records an exact idle runtime recovery and replays it", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_recovery" });
    initializeSessionModelEpoch(db, {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      bindingId: binding.id,
      effectiveAccount: null,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      reasoningLevel: "medium",
      requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      serviceTier: "default",
      startedAt: NOW,
    });
    const before = getSessionExecutionBindingContext(db, binding.id)!;
    const { createdAt: _recipeCreatedAt, id: _recipeId, ...runtimeRecipe } =
      before.runtimeRecipe;
    const {
      hostId: _workspaceHostId,
      id: _workspaceId,
      ...workspaceState
    } = before.workspaceState;
    const recoveredIncarnation = {
      bootNonce: "boot_nonce_runtime_recovery_1234567890",
      connectorId: before.runtimeInstance!.connectorId,
      endpointFingerprint: "sha256:endpoint:runtime-recovery-new",
      processKey: before.runtimeInstance!.processKey,
      providerId: before.runtimeInstance!.providerId,
      runtimeInstanceId: "runtime_binding_recovery_recovered",
      startedAt: NOW + 1,
    };
    const inspection = {
      environmentId: binding.environmentId!,
      execution: {
        effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      },
      executionSafety: "standard" as const,
      incarnation: recoveredIncarnation,
      ownership: binding.ownership,
      phase: "idle" as const,
      providerId: before.nativeConversation.providerId,
      providerInstanceId: before.nativeConversation.providerInstanceId,
      providerThreadId: before.nativeConversation.nativeConversationId,
      runtimeRecipe,
      threadId: binding.threadId!,
      turnId: null,
      workspaceState: {
        ...workspaceState,
        capturedAt: NOW + 1,
        externalSideEffectStatus: "unknown" as const,
        watcherGeneration: workspaceState.watcherGeneration + 1,
      },
    };
    const control = {
      bindingId: binding.id,
      controlEpoch: binding.controlEpoch + 1,
      environmentId: binding.environmentId!,
      executionSafety: "standard" as const,
      handoffCheckpoint: "not_applicable" as const,
      handoffRole: null,
      handoffTransitionId: null,
      incarnation: recoveredIncarnation,
      mutationPolicy: binding.mutationPolicy,
      nativeCursor: binding.nativeCursor,
      ownership: binding.ownership,
      phase: "idle" as const,
      providerInstanceId: before.nativeConversation.providerInstanceId,
      threadId: binding.threadId!,
      turnId: null,
      workspaceId: before.workspaceState.rootPath,
    };

    const recovered = recoverSessionExecutionBinding(db, {
      bindingId: binding.id,
      control,
      expectedControlEpoch: binding.controlEpoch,
      expectedRuntimeInstanceId: before.runtimeInstance!.id,
      inspection,
      recoveredAt: NOW + 2,
    });
    expect(recovered.binding).toMatchObject({
      controlEpoch: binding.controlEpoch + 1,
      phase: "idle",
      providerTurnId: null,
      runtimeInstanceId: recoveredIncarnation.runtimeInstanceId,
    });
    expect(recovered.runtimeInstance).toMatchObject({
      id: recoveredIncarnation.runtimeInstanceId,
      status: "live",
    });
    expect(recovered.workspaceState).toMatchObject({
      capturedAt: NOW + 1,
      externalSideEffectStatus:
        before.workspaceState.externalSideEffectStatus,
      watcherGeneration: workspaceState.watcherGeneration + 1,
    });
    expect(
      db
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, before.runtimeInstance!.id))
        .get(),
    ).toMatchObject({ status: "lost", stoppedAt: null });

    const workspaceCount = db.select().from(sessionFabricWorkspaceStates).all()
      .length;
    expect(
      recoverSessionExecutionBinding(db, {
        bindingId: binding.id,
        control,
        expectedControlEpoch: binding.controlEpoch,
        expectedRuntimeInstanceId: before.runtimeInstance!.id,
        inspection,
        recoveredAt: NOW + 3,
      }).binding,
    ).toEqual(recovered.binding);
    expect(db.select().from(sessionFabricWorkspaceStates).all()).toHaveLength(
      workspaceCount,
    );
  });

  it("rolls back runtime recovery when the workspace digest changes", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_recovery_reject" });
    initializeSessionModelEpoch(db, {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      bindingId: binding.id,
      effectiveAccount: null,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      reasoningLevel: "medium",
      requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      serviceTier: "default",
      startedAt: NOW,
    });
    const before = getSessionExecutionBindingContext(db, binding.id)!;
    const { createdAt: _createdAt, id: _id, ...runtimeRecipe } =
      before.runtimeRecipe;
    const { hostId: _hostId, id: _workspaceId, ...workspaceState } =
      before.workspaceState;
    const incarnation = {
      bootNonce: "boot_nonce_runtime_recovery_reject_1234567890",
      connectorId: before.runtimeInstance!.connectorId,
      endpointFingerprint: "sha256:endpoint:runtime-recovery-reject",
      processKey: before.runtimeInstance!.processKey,
      providerId: before.runtimeInstance!.providerId,
      runtimeInstanceId: "runtime_binding_recovery_rejected",
      startedAt: NOW + 1,
    };

    expect(() =>
      recoverSessionExecutionBinding(db, {
        bindingId: binding.id,
        control: {
          bindingId: binding.id,
          controlEpoch: binding.controlEpoch + 1,
          environmentId: binding.environmentId!,
          executionSafety: "standard",
          handoffCheckpoint: "not_applicable",
          handoffRole: null,
          handoffTransitionId: null,
          incarnation,
          mutationPolicy: binding.mutationPolicy,
          nativeCursor: binding.nativeCursor,
          ownership: binding.ownership,
          phase: "idle",
          providerInstanceId: before.nativeConversation.providerInstanceId,
          threadId: binding.threadId!,
          turnId: null,
          workspaceId: before.workspaceState.rootPath,
        },
        expectedControlEpoch: binding.controlEpoch,
        expectedRuntimeInstanceId: before.runtimeInstance!.id,
        inspection: {
          environmentId: binding.environmentId!,
          execution: {
            effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          executionSafety: "standard",
          incarnation,
          ownership: binding.ownership,
          phase: "idle",
          providerId: before.nativeConversation.providerId,
          providerInstanceId: before.nativeConversation.providerInstanceId,
          providerThreadId: before.nativeConversation.nativeConversationId,
          runtimeRecipe,
          threadId: binding.threadId!,
          turnId: null,
          workspaceState: {
            ...workspaceState,
            diffDigest: "sha256:changed-diff",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "runtime_recovery_conflict" }),
    );
    expect(getSessionExecutionBindingContext(db, binding.id)?.binding).toEqual(
      binding,
    );
  });

  it("derives the mutation guard from active server state", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_guard" });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: "billing_auth_1",
      bindingId: binding.id,
      createdAt: NOW,
      id: "command_guard",
      kind: "change_model",
      payloadHash: "sha256:model-change",
    });
    expect(command.guard).toEqual({
      billingAuthorizationId: "billing_auth_1",
      commandId: "command_guard",
      expectedBootNonce: "boot_nonce_runtime_binding_guard_1234567890",
      expectedControlEpoch: 1,
      expectedEndpointFingerprint: "sha256:endpoint:runtime_binding_guard",
      expectedNativeCursor: "cursor:10",
      expectedPhase: "idle",
      expectedProviderInstanceId: "codex:subscription:default",
      expectedRuntimeInstanceId: "runtime_binding_guard",
      expectedTurnId: null,
    });
  });

  it("serializes model changes against ordinary ingress and other commands", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_serialized" });
    initializeSessionModelEpoch(db, {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      bindingId: binding.id,
      effectiveAccount: null,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
      reasoningLevel: "medium",
      requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      serviceTier: "default",
      startedAt: NOW,
    });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: null,
      bindingId: binding.id,
      id: "command_serialized",
      kind: "change_model",
      payloadHash: "sha256:serialized",
    });

    expect(() =>
      assertSessionThreadIngressAllowed(db, binding.threadId!, {
        model: "gpt-5.6",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "binding_command_in_flight" }),
    );
    expect(() =>
      draftSessionCommand(db, {
        billingAuthorizationId: null,
        bindingId: binding.id,
        kind: "change_model",
        payloadHash: "sha256:conflicting",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "binding_command_in_flight" }),
    );

    advanceToDispatched(db, command.id);
    settleSessionModelChange(db, {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      commandId: command.id,
      reasoningLevel: "medium",
      serviceTier: "default",
      receipt: {
        acceptance: "not_accepted",
        diagnostic: "rejected before provider acceptance",
        effectiveAccount: null,
        effectiveModel: null,
        observedCursor: null,
        providerRequestId: null,
        providerTurnId: null,
        requestedModel: { modelId: "gpt-5.6-pro", providerId: "codex" },
      },
    });
    expect(() =>
      assertSessionThreadIngressAllowed(db, binding.threadId!, {
        model: "gpt-5.6",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    ).not.toThrow();

    db.update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, binding.threadId!))
      .run();
    expect(() =>
      draftSessionCommand(db, {
        billingAuthorizationId: null,
        bindingId: binding.id,
        kind: "change_model",
        payloadHash: "sha256:not-idle",
      }),
    ).toThrowError(expect.objectContaining({ code: "binding_not_idle" }));
  });

  it("refuses commands against a binding after active control moves", () => {
    const db = setup();
    const first = seedBinding(db, { bindingId: "binding_old" });
    const second = seedBinding(db, {
      activate: false,
      bindingId: "binding_new",
      branchId: first.workstreamBranchId,
    });
    compareAndSwapActiveSessionBinding(db, {
      branchId: first.workstreamBranchId,
      expectedBindingId: first.id,
      nextBindingId: second.id,
    });
    expect(() =>
      draftSessionCommand(db, {
        billingAuthorizationId: null,
        bindingId: first.id,
        kind: "interrupt",
        payloadHash: "sha256:interrupt",
      }),
    ).toThrowError(expect.objectContaining({ code: "binding_not_active" }));
  });

  it("appends exact lifecycle events and rejects undeclared transitions", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_lifecycle" });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: null,
      bindingId: binding.id,
      id: "command_lifecycle",
      kind: "quiesce",
      payloadHash: "sha256:quiesce",
    });
    const illegal = applySessionCommandEvent(db, {
      commandId: command.id,
      event: "dispatch",
    });
    expect(illegal).toMatchObject({
      applied: false,
      reason: "illegal_transition",
    });
    advanceToDispatched(db, command.id);
    expect(listSessionCommandEvents(db, command.id)).toMatchObject([
      { sequence: 0, fromStatus: "drafted", toStatus: "authorized" },
      { sequence: 1, fromStatus: "authorized", toStatus: "dispatched" },
    ]);
  });

  it("resolves binding authority and command audit from canonical rows", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_context" });
    const context = getSessionExecutionBindingContext(db, binding.id);
    expect(context).toMatchObject({
      binding: { id: binding.id },
      branch: { activeBindingId: binding.id },
      nativeConversation: {
        providerId: "codex",
        providerInstanceId: "codex:subscription:default",
      },
      runtimeInstance: { id: "runtime_binding_context", status: "live" },
      runtimeRecipe: { permissionMode: "auto" },
      workstream: { projectId: PROJECT_ID },
      workspaceState: { hostId: HOST_ID },
    });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: null,
      bindingId: binding.id,
      id: "command_audit",
      kind: "quiesce",
      payloadHash: "sha256:audit",
    });
    expect(getSessionCommandAudit(db, command.id)).toMatchObject({
      command: { id: command.id, status: "drafted" },
      events: [],
      modelEpoch: null,
      receipt: null,
    });
  });

  it("opens model epochs only for unambiguous accepted receipts", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_model" });
    const first = draftSessionCommand(db, {
      billingAuthorizationId: "billing_auth_1",
      bindingId: binding.id,
      id: "command_model_one",
      kind: "change_model",
      payloadHash: "sha256:model-one",
    });
    advanceToDispatched(db, first.id);
    const firstSettlement = settleSessionModelChange(db, {
      billingRouteId: "billing_route_subscription",
      commandId: first.id,
      occurredAt: NOW + 3,
      reasoningLevel: "high",
      serviceTier: "default",
      receipt: {
        acceptance: "accepted",
        diagnostic: null,
        effectiveAccount: null,
        effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
        observedCursor: "cursor:11",
        providerRequestId: "request:model-one",
        providerTurnId: null,
        requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      },
    });
    expect(firstSettlement.command.status).toBe("succeeded");
    expect(firstSettlement.modelEpoch).toMatchObject({
      sequence: 0,
      endedAt: null,
      effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
    });

    const ambiguous = draftSessionCommand(db, {
      billingAuthorizationId: "billing_auth_2",
      bindingId: binding.id,
      id: "command_model_ambiguous",
      kind: "change_model",
      payloadHash: "sha256:model-ambiguous",
    });
    advanceToDispatched(db, ambiguous.id);
    const ambiguousSettlement = settleSessionModelChange(db, {
      billingRouteId: "billing_route_subscription",
      commandId: ambiguous.id,
      occurredAt: NOW + 4,
      reasoningLevel: "xhigh",
      serviceTier: "default",
      receipt: {
        acceptance: "outcome_unknown",
        diagnostic: "provider connection closed after dispatch",
        effectiveAccount: null,
        effectiveModel: null,
        observedCursor: null,
        providerRequestId: "request:model-ambiguous",
        providerTurnId: null,
        requestedModel: { modelId: "gpt-5.6-pro", providerId: "codex" },
      },
    });
    expect(ambiguousSettlement.command.status).toBe("outcome_unknown");
    expect(ambiguousSettlement.modelEpoch).toBeNull();
    expect(getActiveSessionModelEpoch(db, binding.id)?.id).toBe(
      firstSettlement.modelEpoch?.id,
    );
    expect(() =>
      assertSessionThreadIngressAllowed(db, binding.threadId!, {
        model: "gpt-5.6",
        reasoningLevel: "high",
        serviceTier: "default",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "binding_execution_uncertain" }),
    );
    expect(() =>
      draftSessionCommand(db, {
        billingAuthorizationId: null,
        bindingId: binding.id,
        kind: "change_model",
        payloadHash: "sha256:blocked-by-ambiguous-outcome",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "binding_execution_uncertain" }),
    );
    expect(
      db
        .select()
        .from(sessionFabricModelEpochs)
        .where(eq(sessionFabricModelEpochs.bindingId, binding.id))
        .all(),
    ).toHaveLength(1);
  });

  it("rolls back an accepted receipt that omits effective model evidence", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_bad_receipt" });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: null,
      bindingId: binding.id,
      id: "command_bad_receipt",
      kind: "change_model",
      payloadHash: "sha256:bad-receipt",
    });
    advanceToDispatched(db, command.id);
    expect(() =>
      settleSessionModelChange(db, {
        billingRouteId: "billing_route_subscription",
        commandId: command.id,
        reasoningLevel: "high",
        serviceTier: "default",
        receipt: {
          acceptance: "accepted",
          diagnostic: null,
          effectiveAccount: null,
          effectiveModel: null,
          observedCursor: null,
          providerRequestId: "request:bad",
          providerTurnId: null,
          requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_model_change_receipt" }),
    );
    expect(listSessionCommandEvents(db, command.id)).toHaveLength(2);
  });

  it("replays an identical settled model receipt without duplicating epochs", () => {
    const db = setup();
    const binding = seedBinding(db, { bindingId: "binding_replay" });
    const command = draftSessionCommand(db, {
      billingAuthorizationId: null,
      bindingId: binding.id,
      id: "command_replay",
      kind: "change_model",
      payloadHash: "sha256:replay",
    });
    advanceToDispatched(db, command.id);
    const settlement = {
      billingRouteId: "current-provider-instance:codex:subscription:default",
      commandId: command.id,
      occurredAt: NOW + 3,
      reasoningLevel: "high" as const,
      serviceTier: "default" as const,
      receipt: {
        acceptance: "accepted" as const,
        diagnostic: null,
        effectiveAccount: null,
        effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
        observedCursor: "cursor:11",
        providerRequestId: "request:replay",
        providerTurnId: null,
        requestedModel: { modelId: "gpt-5.6", providerId: "codex" },
      },
    };
    const first = settleSessionModelChange(db, settlement);
    const replay = settleSessionModelChange(db, settlement);
    expect(replay).toEqual(first);
    expect(listSessionCommandEvents(db, command.id)).toHaveLength(4);
    expect(
      db
        .select()
        .from(sessionFabricModelEpochs)
        .where(eq(sessionFabricModelEpochs.bindingId, binding.id))
        .all(),
    ).toHaveLength(1);
    expect(() =>
      settleSessionModelChange(db, {
        ...settlement,
        reasoningLevel: "xhigh",
      }),
    ).toThrowError(expect.objectContaining({ code: "command_status_changed" }));
  });

  it("executes a durable two-phase cross-provider handoff without opening mutation early", () => {
    const db = setup();
    const source = seedBinding(db, { bindingId: "binding_handoff_source" });
    const transitionId = "handoff_complete";
    const { destination, restatement, workspace } = stageHandoffDestination(
      db,
      source,
      transitionId,
    );

    advanceSessionHandoff(db, {
      event: "begin_destination_restatement",
      occurredAt: NOW + 14,
      transitionId,
    });

    expect(
      getSessionExecutionBindingContext(db, destination.id)?.binding,
    ).toMatchObject({ mutationPolicy: "staged_read_only" });
    expect(
      db
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, source.workstreamBranchId))
        .get()?.activeBindingId,
    ).toBe(source.id);

    verifySessionHandoffDestinationRestatement(db, {
      expectedControlEpoch: 0,
      observedWorkspaceStateId: workspace.id,
      restatement,
      restatedControlEpoch: 1,
      transitionId,
      verifiedAt: NOW + 15,
    });
    swapSessionHandoffActiveBinding(db, {
      observedWorkspaceStateId: workspace.id,
      swappedAt: NOW + 16,
      transitionId,
    });

    advanceSessionHandoff(db, {
      event: "begin_destination_enablement",
      occurredAt: NOW + 16,
      transitionId,
    });

    expect(
      db
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, source.workstreamBranchId))
        .get()?.activeBindingId,
    ).toBe(destination.id);
    expect(
      getSessionExecutionBindingContext(db, destination.id)?.binding,
    ).toMatchObject({ mutationPolicy: "staged_read_only" });

    enableSessionHandoffDestinationMutation(db, {
      enabledAt: NOW + 17,
      enabledControlEpoch: 2,
      expectedControlEpoch: 1,
      observedWorkspaceStateId: workspace.id,
      transitionId,
    });
    const completed = retireSessionHandoffSource(db, {
      retiredAt: NOW + 18,
      sourceRetirement: {
        expectedControlEpoch: 2,
        terminalControlEpoch: 3,
      },
      transitionId,
    });

    expect(completed.phase).toBe("source_retired_or_detached");
    expect(
      getSessionExecutionBindingContext(db, destination.id)?.binding,
    ).toMatchObject({ controlEpoch: 2, mutationPolicy: "enabled" });
    expect(
      getSessionExecutionBindingContext(db, source.id)?.binding.closedAt,
    ).toBe(NOW + 18);
    expect(getActiveSessionModelEpoch(db, destination.id)).toMatchObject({
      billingRouteId: "billing-route:pi",
      effectiveModel: PI_MODEL,
      requestedModel: PI_MODEL,
      sequence: 0,
    });
    expect(getSessionHandoffAudit(db, transitionId)).toMatchObject({
      authorization: { capsuleContentHash: restatement.capsuleContentHash },
      capsule: { contentHash: restatement.capsuleContentHash },
      events: expect.arrayContaining([
        expect.objectContaining({ event: "swap_active_binding" }),
        expect.objectContaining({ event: "enable_destination_mutation" }),
      ]),
      restatement: { destinationBindingId: destination.id },
      review: { reviewerId: "user:test" },
      settlement: { sourceControlDisposition: "fenced" },
      transition: { phase: "source_retired_or_detached" },
    });
  });

  it("rolls back restatement evidence when the destination workspace drifts", () => {
    const db = setup();
    const source = seedBinding(db, { bindingId: "binding_drift_source" });
    const transitionId = "handoff_drift";
    const { restatement } = stageHandoffDestination(db, source, transitionId);
    advanceSessionHandoff(db, {
      event: "begin_destination_restatement",
      occurredAt: NOW + 14,
      transitionId,
    });
    const drifted = recordSessionWorkspaceState(db, {
      backgroundResources: [],
      capturedAt: NOW + 15,
      diffDigest: "sha256:drifted",
      digestAlgorithm: "session-workspace-v1",
      externalSideEffectStatus: "not_observed",
      headSha: "abc123",
      hostId: HOST_ID,
      id: "handoff_drift_workspace_observation",
      indexDigest: "sha256:index",
      rootPath: "/repo",
      untrackedManifestDigest: "sha256:untracked",
      watcherGeneration: 3,
      worktreeId: "worktree:repo",
    });

    expect(() =>
      verifySessionHandoffDestinationRestatement(db, {
        expectedControlEpoch: 0,
        observedWorkspaceStateId: drifted.id,
        restatement,
        restatedControlEpoch: 1,
        transitionId,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "destination_mutation_gate_closed" }),
    );
    expect(getSessionHandoffAudit(db, transitionId)).toMatchObject({
      restatement: null,
      transition: { phase: "destination_restating" },
    });
  });

  it("rejects sensitive capsule material without leaving partial evidence", () => {
    const db = setup();
    const source = seedBinding(db, { bindingId: "binding_secret_source" });
    const transitionId = "handoff_secret";
    createHandoffAtWorkspaceSnapshot(db, source, transitionId);

    expect(() =>
      sealSessionContextCapsule(db, {
        capsule: {
          ...capsuleDraft(),
          instructions: [
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
          ],
        },
        transitionId,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "capsule_sensitive_material" }),
    );
    expect(getSessionHandoffAudit(db, transitionId)).toMatchObject({
      capsule: null,
      transition: { phase: "workspace_snapshot_captured" },
    });
  });

  it("permits abort only before the active-binding swap and keeps the source active", () => {
    const db = setup();
    const source = seedBinding(db, { bindingId: "binding_abort_source" });
    const transitionId = "handoff_abort";
    const { destination } = stageHandoffDestination(db, source, transitionId);
    const aborted = abortSessionHandoff(db, {
      abortedAt: NOW + 15,
      destinationDiscard: {
        bindingId: destination.id,
        expectedControlEpoch: 0,
        terminalControlEpoch: 1,
      },
      sourceRestore: {
        enabledControlEpoch: 3,
        expectedControlEpoch: 2,
      },
      transitionId,
    });

    expect(aborted.phase).toBe("aborted");
    expect(
      db
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, source.workstreamBranchId))
        .get()?.activeBindingId,
    ).toBe(source.id);
    expect(
      getSessionExecutionBindingContext(db, source.id)?.binding,
    ).toMatchObject({
      closedAt: null,
      controlEpoch: 3,
      mutationPolicy: "enabled",
    });
    expect(
      getSessionExecutionBindingContext(db, destination.id)?.binding.closedAt,
    ).toBe(NOW + 15);
    expect(getActiveSessionModelEpoch(db, destination.id)).toBeNull();

    const sourceContext = getSessionExecutionBindingContext(db, source.id);
    if (!sourceContext?.environment) {
      throw new Error("handoff source requires an environment");
    }
    db.insert(threads)
      .values({
        id: "handoff_after_abort_destination_thread",
        projectId: PROJECT_ID,
        environmentId: sourceContext.environment.id,
        providerId: "pi",
        status: "idle",
        latestAttentionAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    createSessionHandoffTransition(db, {
      destinationEnvironmentId: sourceContext.environment.id,
      destinationHostId: HOST_ID,
      destinationModel: PI_MODEL,
      destinationProviderInstanceId: PI_PROVIDER_INSTANCE_ID,
      destinationReasoningLevel: "high",
      destinationServiceTier: "default",
      destinationThreadId: "handoff_after_abort_destination_thread",
      destinationWorkspaceDisposition: "source_worktree",
      id: "handoff_after_abort",
      idempotencyKey: "handoff_after_abort:idempotency",
      requestHash: `sha256:${"c".repeat(64)}`,
      sourceBindingId: source.id,
    });
    expect(() => abortSessionHandoff(db, { transitionId })).toThrowError(
      expect.objectContaining({ code: "handoff_illegal_transition" }),
    );
  });

  it("uses a typed persistence error for control failures", () => {
    expect(
      new SessionFabricPersistenceError("binding_not_found", "missing"),
    ).toBeInstanceOf(Error);
  });
});
