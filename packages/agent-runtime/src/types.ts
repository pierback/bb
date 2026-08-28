import type {
  PermissionMode,
  AvailableModel,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  JsonObject,
  MutationAcceptance,
  PendingInteractionCreate,
  PendingInteractionResolution,
  PromptInput,
  ProviderFork,
  ProviderRecoveryKind,
  RuntimeThreadExecutionOptions,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type {
  ProviderHealthResult,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderUsageResult,
  SkillsConfigureRoot,
} from "@bb/provider-bridge-protocol";

export type AgentRuntimeShellEnvironment = Record<string, string>;

export type AgentRuntimeExecutionOptions = RuntimeThreadExecutionOptions;

/**
 * Host-enforced provider session overlay. A handoff-restatement session is
 * intentionally read-only even when the destination thread will later run
 * with a more permissive policy.
 */
export type AgentRuntimeExecutionSafety = "standard" | "handoff_restatement";

/**
 * One staged skill root, the shape every provider receives on
 * `skills/configure` (it is the wire type itself): `path` is an absolute
 * directory holding one subdirectory per listed skill
 * (`<path>/<skill.name>/SKILL.md`), and `skills` lists every skill in it.
 * Each bridge maps this to its provider's own layout (a codex extra root, a
 * claude local plugin, a pi skill path, an ACP prompt listing); no
 * provider-flavored root crosses the runtime.
 */
export type AgentRuntimeSkillRoot = SkillsConfigureRoot;

/**
 * Final per-thread state snapshot taken when a provider process exits,
 * captured before the runtime clears the thread's state. This is the only way
 * consumers can distinguish an idle session from a crashed active turn or a
 * turn request awaiting its first provider lifecycle event.
 */
export interface AgentRuntimeProcessExitThreadState {
  activeTurnId: string | null;
  pendingTurnStart: boolean;
  providerThreadId: string | null;
  threadId: string;
}

/** Stable identity for one live provider-bridge process incarnation. */
export interface AgentRuntimeProviderProcessIncarnation {
  readonly bootNonce: string;
  readonly connectorId: string;
  readonly endpointFingerprint: string;
  readonly processKey: string;
  readonly providerId: string;
  readonly runtimeInstanceId: string;
  readonly startedAt: number;
}

/** Host-private snapshot of the configuration attached to one live thread. */
export interface AgentRuntimeThreadConfigurationSnapshot {
  readonly disallowedTools: readonly string[];
  readonly dynamicTools: readonly DynamicTool[];
  readonly environmentId: string;
  readonly executionSafety: AgentRuntimeExecutionSafety;
  readonly instructionMode: InstructionMode;
  readonly instructions: string | null;
  readonly options: AgentRuntimeExecutionOptions;
  readonly processKey: string;
  readonly projectId: string | null;
  readonly providerId: string;
  readonly skillRoots: readonly AgentRuntimeSkillRoot[];
  readonly workspacePath: string;
}

export interface AgentRuntimeProcessExitInfo {
  providerId: string;
  runtimeIncarnation: AgentRuntimeProviderProcessIncarnation;
  threads: AgentRuntimeProcessExitThreadState[];
  code: number | null;
  expected: boolean;
  signal: string | null;
  stderr: string | null;
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  /** Working directory for provider processes. */
  workspacePath: string;

  /** Extra paths workspace-write providers may mutate in addition to workspacePath. */
  additionalWorkspaceWriteRoots?: readonly string[];

  /** Environment variables passed to ALL provider processes. */
  env?: Record<string, string>;

  /** Environment variables injected into agent shell execution via adapters. */
  shellEnv?: AgentRuntimeShellEnvironment;

  /** Root directory containing per-thread storage directories. */
  threadStorageRootPath?: string;

  /** Optional directory containing bundled provider bridges. */
  bridgeBundleDir?: string;
  /**
   * Bounds for the turn-start watchdog (visible system/error when an
   * accepted turn never starts). Defaults: 120s threshold, 15s sweep.
   */
  turnStartWatchdog?: { thresholdMs?: number; intervalMs?: number };
  /**
   * The retry ladder for a request a bridge rejected with a retryable
   * `rateLimited` recovery hint: one re-send per entry, after that delay.
   * Default: [2s, 8s]. Tests shorten it.
   */
  rateLimitRetry?: { delaysMs?: readonly number[] };
  /**
   * How long a session construction request (thread/start, resume, fork)
   * may take before the runtime gives the thread up. Default: 2 minutes.
   * Tests shorten it.
   */
  threadCreation?: { requestTimeoutMs?: number };

  /** Optional caller-provided skill roots to expose to provider sessions. */
  skillRoots?: readonly AgentRuntimeSkillRoot[];

  /** Called when a provider emits a translated event.
   *  Every event has `threadId` (bb ID) and `providerThreadId` (provider's internal ID). */
  onEvent: (event: ThreadEvent) => void;

  /** Called when a provider needs to execute a tool.
   *  `threadId` is always the BB thread id and `providerThreadId` is always present. */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;

  /** Called when a provider pauses for user permission or approval.
   *  The runtime converts provider-native requests into bb's shared pending-interaction contract. */
  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;

  /** Called on provider stderr lines. */
  onStderr?: (line: string, threadId?: string) => void;

  /** Called when a provider process exits unexpectedly. */
  onProcessExit?: (info: AgentRuntimeProcessExitInfo) => void;

  /**
   * Called when a bridge raises a typed `provider/recovery` hint, after the
   * runtime has recorded it for the action it drives (unarchive-and-retry,
   * typed `auth_required` rejection, bridge restart, stale-steer drop,
   * rate-limit ladder end). A session-scoped `rateLimited` rejection is
   * forwarded only when it is terminal or ends the retry ladder; a rung that
   * then succeeds forwards nothing. The host uses the forward for what the
   * runtime cannot do itself, such as re-checking provider health after
   * `authRequired`. A runtime signal, never a timeline event.
   */
  onProviderRecovery?: (hint: AgentRuntimeProviderRecoveryHint) => void;
}

/**
 * A bridge's `provider/recovery` notification, stamped with the provider it
 * came from. `threadId` is the bb thread for session-scoped hints
 * (`sessionArchived`, `staleTurn`) and absent for provider-wide ones
 * (`authRequired`, account-level `rateLimited`).
 */
export interface AgentRuntimeProviderRecoveryHint {
  providerId: string;
  threadId?: string;
  kind: ProviderRecoveryKind;
  message: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

/**
 * A plugin-delivered provider bridge, resolved by the host daemon: the bridge
 * artifact has been downloaded, hash-verified, and cached at `artifactPath`.
 * Rides per-call like the ACP launch spec; `sha256` keys process identity so
 * a plugin update (new artifact hash) gets a fresh bridge process.
 */
export interface AgentRuntimeBridgeLaunch {
  /** The plugin that ships this bridge. Scopes the process's directories. */
  pluginId: string;
  /**
   * This plugin's persistent bridge directory on this host, already created by
   * the daemon. The bootstrap hands it to the bridge; the matching temp dir is
   * this process's own and is created and removed by the bootstrap.
   */
  dataDir: string;
  /**
   * Which bridge binary to run, as the server decided it: a hash-verified
   * plugin artifact already cached on this host.
   */
  source: { kind: "artifact"; digest: string; artifactPath: string };
  /** Server-validated capabilities from the provider declaration. */
  capabilities: {
    providerInstallation: boolean;
    supportsServiceTier: boolean;
    permissionModes: PermissionMode[];
    supportsThreadArchive: boolean;
    supportsThreadRename: boolean;
    fork: ProviderFork;
  };
  /** Provider-owned statics; interpreted only by the provider bridge. */
  providerOptions: JsonObject;
  /**
   * Daemon environment variable names the bridge may read. Provider
   * processes are spawned with every inherited `BB_*` variable stripped;
   * exactly these are forwarded from the daemon's own environment.
   */
  envPassthrough: readonly string[];
}

export interface EnsureProviderArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
}

export interface StartThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  projectId: string;
  providerId: string;
  executionSafety?: AgentRuntimeExecutionSafety;
  clientRequestId?: ClientTurnRequestId;
  input?: PromptInput[];
  inputGroups?: PromptInput[][];
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
  /**
   * Present means fork the new thread from this source provider session
   * instead of starting fresh; absent means a normal start. The clone retains
   * the source history through `sourceProviderCheckpointId`; an absent
   * checkpoint clones the session tip.
   */
  fork?: {
    sourceProviderThreadId: string;
    sourceProviderCheckpointId?: string;
  };
}

export interface StartThreadResult {
  providerThreadId: string;
}

interface PrepareThreadRewindArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  leaseId: string;
  projectId: string;
  providerId: string;
  sourceProviderThreadId: string;
  retainThroughProviderCheckpoint: string;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
}

interface PrepareThreadRewindResult {
  providerThreadId: string;
}

interface DiscardThreadRewindArgs {
  leaseId: string;
}

export interface ResumeThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  environmentId: string;
  threadId: string;
  projectId?: string;
  providerThreadId?: string;
  providerId: string;
  executionSafety?: AgentRuntimeExecutionSafety;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
}

export interface ResumeThreadResult {
  providerThreadId: string;
}

export interface ReconfigureThreadArgs {
  executionSafety?: AgentRuntimeExecutionSafety;
  instructions?: string;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

export interface ReconfigureThreadResult {
  acceptance: MutationAcceptance;
  diagnostic: string | null;
  providerRequestId: string | null;
  providerThreadId: string | null;
}

export interface RunTurnArgs {
  threadId: string;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
}

export interface RunTurnAndWaitForCompletionArgs extends RunTurnArgs {
  timeoutMs: number;
}

export interface RunTurnAndWaitForCompletionResult {
  assistantText: string;
  errorMessage: string | null;
  status: "completed" | "failed" | "interrupted";
  turnId: string;
}

export interface SteerTurnArgs {
  threadId: string;
  expectedTurnId: string;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
}

interface SteerTurnAppliedResult {
  status: "steered";
}

interface SteerTurnStaleResult {
  status: "stale";
  activeTurnId: string | null;
}

export type SteerTurnResult = SteerTurnAppliedResult | SteerTurnStaleResult;

export interface StopThreadArgs {
  threadId: string;
}

export interface StopThreadResult {
  providerCheckpointId: string | null;
}

export interface AgentRuntimeProviderSession {
  providerId: string;
  providerThreadId: string;
}

export interface WaitForActiveTurnArgs {
  timeoutMs: number;
}

export interface ReapIdleProviderSessionsArgs {
  idleForMs: number;
  nowMs: number;
  providerSessionReapingEnabled: boolean;
  runThreadExclusive?: (
    threadId: string,
    work: () => Promise<ReapedIdleProviderSession | null>,
  ) => Promise<ReapedIdleProviderSession | null>;
}

export interface ReapedIdleProviderSession {
  idleForMs: number;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ReapIdleProviderSessionsResult {
  reapedSessions: ReapedIdleProviderSession[];
}

export interface RenameThreadArgs {
  threadId: string;
  title: string;
}

interface ClearThreadGoalArgs {
  threadId: string;
}

interface ArchiveThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

interface UnarchiveThreadArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ListModelsArgs {
  providerId: string;
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  cwd?: string;
}

export interface ListNativeSessionsArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
  params: object;
}

/** Host-observed, fail-closed facts used by Session Fabric settlement. */
export interface AgentRuntimeThreadSettlementState {
  activeBackgroundResourceCount: number;
  activeToolCount: number;
  compacting: boolean;
  externalSideEffectStatus: "known" | "not_observed" | "unknown";
  outcomeUnknown: boolean;
  partialEdit: boolean;
  retrying: boolean;
  unknownBackgroundResourceCount: number;
}

interface ProviderMaintenanceArgs {
  providerId: string;
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  cwd?: string;
}

interface ProviderInstallationStatusArgs extends ProviderMaintenanceArgs {
  requirement?: "thread_rewind";
}

export interface AgentRuntime {
  ensureProvider(args: EnsureProviderArgs): Promise<void>;

  startThread(args: StartThreadArgs): Promise<StartThreadResult>;

  prepareThreadRewind(
    args: PrepareThreadRewindArgs,
  ): Promise<PrepareThreadRewindResult>;

  discardThreadRewind(args: DiscardThreadRewindArgs): Promise<void>;

  resumeThread(args: ResumeThreadArgs): Promise<ResumeThreadResult>;

  reconfigureThread(
    args: ReconfigureThreadArgs,
  ): Promise<ReconfigureThreadResult>;

  runTurn(args: RunTurnArgs): Promise<void>;

  runTurnAndWaitForCompletion(
    args: RunTurnAndWaitForCompletionArgs,
  ): Promise<RunTurnAndWaitForCompletionResult>;

  steerTurn(args: SteerTurnArgs): Promise<SteerTurnResult>;

  /**
   * Stops the thread's active turn and removes the thread from the runtime:
   * identity, execution config, and turn state are cleared, so `hasThread`
   * reports `false` afterwards and the next turn must go through
   * `resumeThread`. The provider process keeps running for other threads.
   */
  stopThread(args: StopThreadArgs): Promise<StopThreadResult>;

  clearThreadGoal(args: ClearThreadGoalArgs): Promise<{ cleared: boolean }>;

  renameThread(args: RenameThreadArgs): Promise<void>;

  archiveThread(args: ArchiveThreadArgs): Promise<void>;

  unarchiveThread(args: UnarchiveThreadArgs): Promise<void>;

  listModels(args: ListModelsArgs): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;

  listNativeSessions(args: ListNativeSessionsArgs): Promise<unknown>;

  providerHealth(
    args: ProviderMaintenanceArgs,
  ): Promise<ProviderHealthResult>;

  providerUsage(
    args: ProviderMaintenanceArgs,
  ): Promise<ProviderUsageResult>;

  providerInstallationStatus(
    args: ProviderInstallationStatusArgs,
  ): Promise<ProviderInstallationStatus>;

  providerInstallationRun(
    args: ProviderMaintenanceArgs & { action: "install" | "update" },
  ): Promise<ProviderInstallationRunResult>;

  listRunningProviders(): string[];

  listProviderRuntimeIncarnations(): AgentRuntimeProviderProcessIncarnation[];

  /** Active turn id for the thread, or `null` when no turn is running. */
  getActiveTurnId(threadId: string): string | null;

  /**
   * Resolves with the active turn id as soon as one is known: immediately if
   * a turn is already active, on the next `turn/started` observation
   * otherwise. Resolves `null` on timeout or when the thread goes idle
   * (stopped, cleared, or its provider process exits) before a turn starts.
   */
  waitForActiveTurn(
    threadId: string,
    args: WaitForActiveTurnArgs,
  ): Promise<string | null>;

  /** Provider identity for a hosted thread, or `null` when not hosted. */
  getProviderSession(threadId: string): AgentRuntimeProviderSession | null;

  getThreadExecutionOptions(
    threadId: string,
  ): AgentRuntimeExecutionOptions | null;

  getThreadConfigurationSnapshot(
    threadId: string,
  ): AgentRuntimeThreadConfigurationSnapshot | null;

  getProviderRuntimeIncarnation(
    threadId: string,
  ): AgentRuntimeProviderProcessIncarnation | null;

  getProviderProcessId(threadId: string): number | null;

  /**
   * Stops idle live provider sessions without deleting bb thread state or
   * provider history. The next turn must resume from the persisted provider
   * thread id.
   */
  reapIdleProviderSessions(
    args: ReapIdleProviderSessionsArgs,
  ): Promise<ReapIdleProviderSessionsResult>;

  /** Whether the runtime currently hosts the thread (turns can run on it). */
  hasThread(threadId: string): boolean;

  /** Thread ids with an active turn or an accepted turn awaiting its first event. */
  getLiveThreadIds(): string[];

  getActiveThreadIds(): string[];

  /**
   * Whether any hosted thread still has an open background task (a workflow or
   * backgrounded command). These outlive their spawning turn, so a runtime with
   * no active turn can still be doing real work that a shutdown would destroy.
   */
  hasOpenBackgroundWork(): boolean;

  hasOpenBackgroundWorkForThread(threadId: string): boolean;

  getThreadSettlementState(
    threadId: string,
  ): AgentRuntimeThreadSettlementState;

  shutdown(): Promise<void>;
}
