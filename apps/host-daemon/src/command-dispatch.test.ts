import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntime,
  AgentRuntimeProviderProcessIncarnation,
} from "@bb/agent-runtime";
import type {
  HostDaemonInjectedSkillSource,
  ProviderCliInstallEvent,
  ProviderCliStatus,
} from "@bb/host-daemon-contract";
import type { HostWorkspace } from "@bb/host-workspace";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import type { CommandOf } from "./command-dispatch-support.js";
import { RuntimeManager } from "./runtime-manager.js";
import { SessionDiscoveryCatalog } from "./session-discovery-catalog.js";
import { SessionRuntimeBroker } from "./session-runtime-broker.js";

const WORKSPACE_PATH = "/tmp/bb-command-dispatch-test";
const sessionFabricTestDependencies = {
  sessionDiscoveryCatalog: new SessionDiscoveryCatalog({
    hostId: "host-command-dispatch-test",
    sources: [],
  }),
  sessionRuntimeBroker: new SessionRuntimeBroker(),
};

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve: (value: TValue | PromiseLike<TValue>) => void;
  reject: (reason?: Error) => void;
}

interface WriteInjectedSkillSourceArgs {
  dataDir: string;
  token: string;
}

interface BusySkillCatalogFixture {
  createRuntimeSpy: Mock<() => AgentRuntime>;
  dataDir: string;
  manager: RuntimeManager;
  originalCatalogHash: string | null;
  runtime: FakeDispatchRuntime;
  source: HostDaemonInjectedSkillSource;
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeInjectedSkillSource(
  args: WriteInjectedSkillSourceArgs,
): Promise<HostDaemonInjectedSkillSource> {
  const sourceRootPath = path.join(args.dataDir, "skills", "release-notes");
  await fs.mkdir(sourceRootPath, { recursive: true });
  await fs.writeFile(
    path.join(sourceRootPath, "SKILL.md"),
    [
      "---",
      "name: release-notes",
      "description: Use release-notes when command dispatch tests run.",
      "---",
      "",
      args.token,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    kind: "workspace-path",
    sourceType: "project",
    name: "release-notes",
    description: "Use release-notes when command dispatch tests run.",
    sourceRootPath,
    skillFilePath: path.join(sourceRootPath, "SKILL.md"),
  };
}

/**
 * Builds the thread-brick scenario the catalog-deferral fix targets: an
 * environment whose runtime was created with an injected skill catalog, made
 * busy by an active thread, after which the skill source content changes so
 * the next staged catalog hash no longer matches the loaded runtime's.
 */
async function setupBusySkillCatalogEnvironment(args: {
  activeThreadId: string;
}): Promise<BusySkillCatalogFixture> {
  const dataDir = await makeTempDir("bb-command-dispatch-skills-");
  const source = await writeInjectedSkillSource({
    dataDir,
    token: "first-token",
  });
  const runtime = createRuntime();
  const createRuntimeSpy = vi.fn(() => runtime);
  const manager = new RuntimeManager({
    dataDir,
    createRuntime: createRuntimeSpy,
    provisionWorkspace: async () => createWorkspace(),
  });
  const entry = await manager.ensureEnvironment({
    environmentId: "env-1",
    injectedSkillSources: [source],
    workspacePath: WORKSPACE_PATH,
  });
  runtime.setActiveTurn(args.activeThreadId, "turn-busy-1");
  await writeInjectedSkillSource({ dataDir, token: "second-token" });
  return {
    createRuntimeSpy,
    dataDir,
    manager,
    originalCatalogHash: entry.skillCatalogHash,
    runtime,
    source,
  };
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: Deferred<TValue>["resolve"];
  let reject!: Deferred<TValue>["reject"];
  const promise = new Promise<TValue>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function unexpectedWorkspaceCall(): Promise<never> {
  throw new Error("Unexpected workspace call");
}

function createWorkspace(): HostWorkspace {
  return {
    path: WORKSPACE_PATH,
    managed: false,
    isGitRepo: false,
    isWorktree: false,
    getDefaultBranch: unexpectedWorkspaceCall,
    getCurrentBranch: unexpectedWorkspaceCall,
    getHeadSha: unexpectedWorkspaceCall,
    getLocalStateFingerprint: unexpectedWorkspaceCall,
    getSharedGitRefsFingerprint: unexpectedWorkspaceCall,
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: unexpectedWorkspaceCall,
    getSourceFreshness: unexpectedWorkspaceCall,
    getDiff: unexpectedWorkspaceCall,
    diffFiles: unexpectedWorkspaceCall,
    diffPatch: unexpectedWorkspaceCall,
    getPullRequest: unexpectedWorkspaceCall,
    runPullRequestAction: unexpectedWorkspaceCall,
    listBranches: unexpectedWorkspaceCall,
    listFiles: unexpectedWorkspaceCall,
    commit: unexpectedWorkspaceCall,
    reset: unexpectedWorkspaceCall,
    fetch: unexpectedWorkspaceCall,
    updateFromSource: unexpectedWorkspaceCall,
    squashMerge: unexpectedWorkspaceCall,
    destroy: vi.fn(async () => undefined),
  };
}

interface FakeDispatchRuntime extends AgentRuntime {
  /** Test-only mutator for the runtime-owned per-thread turn state. */
  setActiveTurn: (threadId: string, turnId: string) => void;
  setIdle: (threadId: string) => void;
}

function createRuntime(): FakeDispatchRuntime {
  const activeTurnsByThreadId = new Map<string, string>();
  const hostedThreadIds = new Set<string>();
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    resumeThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    reconfigureThread: vi.fn(async () => ({
      acceptance: "accepted" as const,
      diagnostic: null,
      providerRequestId: "provider-request-1",
      providerThreadId: "provider-thread-1",
    })),
    runTurn: vi.fn(async () => undefined),
    runTurnAndWaitForCompletion: vi.fn(async () => ({
      assistantText: "{}",
      errorMessage: null,
      status: "completed" as const,
      turnId: "turn-1",
    })),
    steerTurn: vi.fn(async () => ({ status: "steered" as const })),
    stopThread: vi.fn(async (args: { threadId: string }) => {
      activeTurnsByThreadId.delete(args.threadId);
      hostedThreadIds.delete(args.threadId);
    }),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({
      models: [],
      selectedOnlyModels: [],
    })),
    listNativeSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
    listRunningProviders: vi.fn(() => ["fake"]),
    listProviderRuntimeIncarnations: vi.fn(() => []),
    getActiveTurnId: (threadId) => activeTurnsByThreadId.get(threadId) ?? null,
    waitForActiveTurn: async (threadId) =>
      activeTurnsByThreadId.get(threadId) ?? null,
    getProviderSession: (threadId) =>
      hostedThreadIds.has(threadId)
        ? { providerId: "fake", providerThreadId: "provider-thread-1" }
        : null,
    getProviderRuntimeIncarnation: vi.fn(() => null),
    getProviderProcessId: vi.fn(() => null),
    getThreadExecutionOptions: vi.fn(() => null),
    getThreadConfigurationSnapshot: vi.fn(() => null),
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: (threadId) => hostedThreadIds.has(threadId),
    getActiveThreadIds: () => [...activeTurnsByThreadId.keys()],
    getLiveThreadIds: () => [...activeTurnsByThreadId.keys()],
    hasOpenBackgroundWork: () => false,
    hasOpenBackgroundWorkForThread: () => false,
    getThreadSettlementState: () => ({
      activeBackgroundResourceCount: 0,
      activeToolCount: 0,
      compacting: false,
      externalSideEffectStatus: "not_observed",
      outcomeUnknown: false,
      partialEdit: false,
      retrying: false,
      unknownBackgroundResourceCount: 0,
    }),
    shutdown: vi.fn(async () => undefined),
    setActiveTurn: (threadId, turnId) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setIdle: (threadId: string) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.delete(threadId);
    },
  };
}

function createProviderCliInstallEventStream(
  events: readonly ProviderCliInstallEvent[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

describe("dispatchCommand", () => {
  it("rejects ordinary turn dispatch while an adopted binding is staged read-only", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-staged",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-staged");
    const incarnation: AgentRuntimeProviderProcessIncarnation = {
      bootNonce: "boot_nonce_staged_1234567890",
      connectorId: "codex-app-server",
      endpointFingerprint: "stdio:staged",
      processKey: "codex\0thread:thread-staged",
      providerId: "codex",
      runtimeInstanceId: "runtime-staged",
      startedAt: 1_000,
    };
    vi.mocked(runtime.getProviderRuntimeIncarnation).mockReturnValue(
      incarnation,
    );
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime({
      bindingId: "binding-staged",
      controlEpoch: 0,
      environmentId: "env-staged",
      incarnation,
      mutationPolicy: "staged_read_only",
      nativeCursor: null,
      ownership: "owned_brokered",
      phase: "idle",
      providerInstanceId: "provider-instance-staged",
      threadId: "thread-staged",
      turnId: null,
      workspaceId: WORKSPACE_PATH,
    });

    await expect(
      dispatchCommand(
        {
          type: "turn.submit",
          environmentId: "env-staged",
          threadId: "thread-staged",
          requestId: "creq_staged_12345678",
          input: [{ type: "text", text: "mutate", mentions: [] }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            workflowsEnabled: false,
            permissionMode: "full",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: WORKSPACE_PATH,
              workspaceProvisionType: "unmanaged",
            },
            projectId: "project-staged",
            providerId: "codex",
            providerThreadId: "provider-thread-1",
            instructions: "Follow the request.",
            dynamicTools: [],
            injectedSkillSources: [],
            instructionMode: "append",
          },
          target: { mode: "start" },
        },
        {
          dataDir: "/tmp/bb-data",
          eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          runtimeManager: manager,
          sessionDiscoveryCatalog:
            sessionFabricTestDependencies.sessionDiscoveryCatalog,
          sessionRuntimeBroker: broker,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      ),
    ).rejects.toMatchObject({ code: "mutation_policy_read_only" });
    expect(runtime.runTurn).not.toHaveBeenCalled();
    expect(runtime.resumeThread).not.toHaveBeenCalled();
  });

  it("rejects an ordinary turn before it can resume a missing brokered incarnation", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-brokered-missing",
      workspacePath: WORKSPACE_PATH,
    });
    const incarnation: AgentRuntimeProviderProcessIncarnation = {
      bootNonce: "boot_nonce_brokered_missing_1234567890",
      connectorId: "codex-app-server",
      endpointFingerprint: "stdio:brokered-missing",
      processKey: "codex\0thread:thread-brokered-missing",
      providerId: "codex",
      runtimeInstanceId: "runtime-brokered-missing",
      startedAt: 1_000,
    };
    const broker = new SessionRuntimeBroker();
    broker.bindManagedRuntime({
      bindingId: "binding-brokered-missing",
      controlEpoch: 3,
      environmentId: "env-brokered-missing",
      incarnation,
      mutationPolicy: "enabled",
      nativeCursor: "cursor:brokered-missing",
      ownership: "owned_brokered",
      phase: "idle",
      providerInstanceId: "provider-instance-brokered-missing",
      threadId: "thread-brokered-missing",
      turnId: null,
      workspaceId: WORKSPACE_PATH,
    });

    await expect(
      dispatchCommand(
        {
          type: "turn.submit",
          environmentId: "env-brokered-missing",
          threadId: "thread-brokered-missing",
          requestId: "creq_brokered_missing_12345678",
          input: [{ type: "text", text: "mutate", mentions: [] }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            workflowsEnabled: false,
            permissionMode: "full",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: WORKSPACE_PATH,
              workspaceProvisionType: "unmanaged",
            },
            projectId: "project-brokered-missing",
            providerId: "codex",
            providerThreadId: "provider-thread-brokered-missing",
            instructions: "Follow the request.",
            dynamicTools: [],
            injectedSkillSources: [],
            instructionMode: "append",
          },
          target: { mode: "start" },
        },
        {
          dataDir: "/tmp/bb-data",
          eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          runtimeManager: manager,
          sessionDiscoveryCatalog:
            sessionFabricTestDependencies.sessionDiscoveryCatalog,
          sessionRuntimeBroker: broker,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      ),
    ).rejects.toMatchObject({ code: "runtime_incarnation_mismatch" });
    expect(runtime.runTurn).not.toHaveBeenCalled();
    expect(runtime.resumeThread).not.toHaveBeenCalled();
  });

  it("flushes buffered events before reporting thread.stop success", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/bb-command-dispatch-test",
    });
    runtime.setActiveTurn("thread-1", "turn-1");

    const flushDeferred = createDeferred<void>();
    const flush = vi.fn(async () => flushDeferred.promise);
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      environmentId: "env-1",
      threadId: "thread-1",
    };
    let resolved = false;
    const dispatchPromise = dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: {
        emit: vi.fn(),
        flush,
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    }).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(flush).toHaveBeenCalledTimes(1);
    });
    expect(resolved).toBe(false);

    flushDeferred.resolve(undefined);
    await dispatchPromise;

    expect(resolved).toBe(true);
    expect(runtime.hasThread("thread-1")).toBe(false);
  });

  it("cancels Plan through the active provider runtime before flushing events", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
      },
      {
        dataDir: "/tmp/bb-data",
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...sessionFabricTestDependencies,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: true });
    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("does not cancel Plan after its turn has already ended", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/bb-data",
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...sessionFabricTestDependencies,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not cancel a newer turn when the Plan cancellation is stale", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-newer-2");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/bb-data",
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...sessionFabricTestDependencies,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.getActiveTurnId("thread-1")).toBe("turn-newer-2");
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("resumes a reaped Codex runtime before clearing its Goal", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const flush = vi.fn(async () => undefined);
    const command: CommandOf<"thread.goal.clear"> = {
      type: "thread.goal.clear",
      environmentId: "env-1",
      threadId: "thread-1",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        workflowsEnabled: false,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj-1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: { emit: vi.fn(), flush },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ cleared: true });
    expect(runtime.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
      }),
    );
    expect(runtime.clearThreadGoal).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("treats thread.rename as best-effort when the runtime is not loaded", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.rename"> = {
      type: "thread.rename",
      environmentId: "env-missing-runtime",
      threadId: "thread-1",
      title: "Renamed",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({});
    expect(runtime.renameThread).not.toHaveBeenCalled();
  });

  it("blocks codex thread.start when the CLI is below the minimum version", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_unsupported_codex",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        workflowsEnabled: false,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };

    const unsupportedCodexStatus: ProviderCliStatus = {
      displayName: "Codex",
      executableName: "codex",
      executablePath: "/usr/local/bin/codex",
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "0.135.0",
      latestVersion: null,
      minimumSupportedVersion: "0.136.0",
      npmPackageName: "@openai/codex",
      npmGlobalPackageVersion: "0.135.0",
      installAction: {
        kind: "update",
        label: "Update",
        commandKind: "exec",
        command: "codex update",
      },
      needsUpdate: false,
      versionUnsupported: true,
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/bb-data",
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        getProviderCliStatusForProvider: async () => unsupportedCodexStatus,
        ...sessionFabricTestDependencies,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      }),
    ).rejects.toMatchObject({
      code: "provider_cli_unsupported_version",
    });

    expect(runtime.startThread).not.toHaveBeenCalled();
  });

  it("does not check Codex CLI status for non-Codex thread.start", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "claude-code",
      requestId: "creq_non_codex",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "claude-sonnet-4-6",
        serviceTier: "default",
        reasoningLevel: "medium",
        workflowsEnabled: false,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const getProviderCliStatusForProvider = vi.fn(async () => {
      throw new Error("Codex CLI status should not be checked");
    });

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      getProviderCliStatusForProvider,
      ...sessionFabricTestDependencies,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ providerThreadId: "provider-thread-1" });
    expect(getProviderCliStatusForProvider).not.toHaveBeenCalled();
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("invalidates the provider maintenance runtime after a successful Codex CLI update", async () => {
    const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
    const staleRuntime = createRuntime();
    const freshRuntime = createRuntime();
    const createRuntimeSpy = vi.fn(() => staleRuntime);
    createRuntimeSpy.mockReturnValueOnce(staleRuntime);
    createRuntimeSpy.mockReturnValueOnce(freshRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      dataDir,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureProviderMaintenanceRuntime({ dataDir });

    const events: ProviderCliInstallEvent[] = [
      {
        type: "started",
        provider: "codex",
        command: "codex update",
      },
      {
        type: "completed",
        provider: "codex",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ];
    const streamProviderCliInstall = vi.fn(() =>
      createProviderCliInstallEventStream(events),
    );
    const command: CommandOf<"provider_cli.install"> = {
      type: "provider_cli.install",
      provider: "codex",
      actionKind: "update",
    };

    const result = await dispatchOnlineRpcCommand(command, {
      dataDir,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: manager,
      streamProviderCliInstall,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ events });
    expect(streamProviderCliInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        actionKind: "update",
        provider: "codex",
      }),
    );
    expect(staleRuntime.shutdown).toHaveBeenCalledOnce();

    await manager.ensureProviderMaintenanceRuntime({ dataDir });
    expect(createRuntimeSpy).toHaveBeenCalledTimes(2);
    expect(freshRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps the provider maintenance runtime after failed or non-Codex CLI installs", async () => {
    const cases: Array<{
      actionKind: CommandOf<"provider_cli.install">["actionKind"];
      events: ProviderCliInstallEvent[];
      provider: CommandOf<"provider_cli.install">["provider"];
    }> = [
      {
        actionKind: "update",
        provider: "codex",
        events: [
          {
            type: "completed",
            provider: "codex",
            exitCode: 1,
            signal: null,
            success: false,
          },
        ],
      },
      {
        actionKind: "update",
        provider: "claudeCode",
        events: [
          {
            type: "completed",
            provider: "claudeCode",
            exitCode: 0,
            signal: null,
            success: true,
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
      const runtime = createRuntime();
      const createRuntimeSpy = vi.fn(() => runtime);
      const manager = new RuntimeManager({
        createRuntime: createRuntimeSpy,
        dataDir,
        provisionWorkspace: async () => createWorkspace(),
      });
      await manager.ensureProviderMaintenanceRuntime({ dataDir });
      const streamProviderCliInstall = vi.fn(() =>
        createProviderCliInstallEventStream(testCase.events),
      );

      const result = await dispatchOnlineRpcCommand(
        {
          type: "provider_cli.install",
          provider: testCase.provider,
          actionKind: testCase.actionKind,
        },
        {
          dataDir,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          ...sessionFabricTestDependencies,
          runtimeManager: manager,
          streamProviderCliInstall,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      );

      expect(result).toEqual({ events: testCase.events });
      expect(runtime.shutdown).not.toHaveBeenCalled();
      await expect(
        manager.ensureProviderMaintenanceRuntime({ dataDir }),
      ).resolves.toBe(runtime);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(1);
    }
  });

  // Regression: a thread.start whose freshly staged skill catalog differed
  // from the busy runtime's catalog used to fail the command (and brick the
  // thread) instead of reusing the runtime. This drives the real plumbing —
  // the handler's targetThreadId carried through workspace resolution into
  // RuntimeManager.ensureEnvironment.
  it("reuses a busy runtime when thread.start carries a changed skill catalog", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "sibling-thread",
    });
    const command: CommandOf<"thread.start"> = {
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        workflowsEnabled: false,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      injectedSkillSources: [fixture.source],
      instructionMode: "append",
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result.providerThreadId).toBe("provider-thread-1");
    expect(fixture.runtime.startThread).toHaveBeenCalledTimes(1);
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    // The stale catalog stays bound; the refresh is deferred until idle.
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });

  // Regression: the self-brick case — an agent installs a skill mid-turn, so
  // the next turn.submit for its own (active) thread stages a different
  // catalog hash. The command must reuse the busy runtime instead of failing
  // and dropping the message.
  it("reuses a busy runtime when turn.submit carries a changed skill catalog", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "thread-1",
    });
    const command: CommandOf<"turn.submit"> = {
      type: "turn.submit",
      environmentId: "env-1",
      threadId: "thread-1",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        workflowsEnabled: false,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        injectedSkillSources: [fixture.source],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      ...sessionFabricTestDependencies,
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(fixture.runtime.runTurn).toHaveBeenCalledTimes(1);
    // The runtime already hosts the thread, so no resume round-trip happens.
    expect(fixture.runtime.resumeThread).not.toHaveBeenCalled();
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    // The stale catalog stays bound; the refresh is deferred until idle.
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });
});
