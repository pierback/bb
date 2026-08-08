import type {
  AvailableModel,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  JsonObject,
  MutationAcceptance,
  PendingInteractionCreate,
  PendingInteractionResolution,
  PromptInput,
  RuntimeThreadExecutionOptions,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { HostDaemonAcpLaunchSpec } from "@bb/host-daemon-contract";

export type AgentRuntimeShellEnvironment = Record<string, string>;

export type AgentRuntimeExecutionOptions = RuntimeThreadExecutionOptions;

/**
 * Host-enforced provider session overlay. A handoff restatement session must
 * be incapable of mutating state even when its eventual execution recipe is
 * more permissive.
 */
export type AgentRuntimeExecutionSafety = "standard" | "handoff_restatement";

export interface AgentRuntimeCodexSkillRoot {
  id: string;
  providerId: "codex";
  skillDirectoryRootPath: string;
}

export interface AgentRuntimeClaudeCodeSkillRoot {
  id: string;
  providerId: "claude-code";
  localPluginPath: string;
}

export interface AgentRuntimePiSkillRoot {
  id: string;
  providerId: "pi";
  skillDirectoryRootPath: string;
}

export interface AgentRuntimeAcpSkill {
  description: string;
  name: string;
}

export interface AgentRuntimeAcpSkillRoot {
  id: string;
  providerId: "acp";
  skillDirectoryRootPath: string;
  skills: readonly AgentRuntimeAcpSkill[];
}

export type AgentRuntimeSkillRoot =
  | AgentRuntimeAcpSkillRoot
  | AgentRuntimeClaudeCodeSkillRoot
  | AgentRuntimeCodexSkillRoot
  | AgentRuntimePiSkillRoot;

/**
 * Final per-thread state snapshot taken when a provider process exits,
 * captured before the runtime clears the thread's state. This is the only
 * way consumers can see which turn a crashed thread was running.
 */
export interface AgentRuntimeProcessExitThreadState {
  activeTurnId: string | null;
  providerThreadId: string | null;
  threadId: string;
}

/**
 * Broker-owned identity for one provider process incarnation. These values are
 * generated when the private process channel is created and never derived
 * from a PID, which may be reused by the operating system.
 */
export interface AgentRuntimeProviderProcessIncarnation {
  readonly bootNonce: string;
  readonly connectorId: string;
  readonly endpointFingerprint: string;
  readonly processKey: string;
  readonly providerId: string;
  readonly runtimeInstanceId: string;
  readonly startedAt: number;
}

/**
 * Host-internal snapshot of the configuration actually attached to a thread.
 * It may contain local paths and instructions, so callers must derive opaque
 * fingerprints before crossing the host-daemon trust boundary.
 */
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

  /** Optional executable used to run Node-based provider bridges. */
  bridgeNodeExecutablePath?: string;

  /** Optional env values needed by the executable used for Node-based bridges. */
  bridgeNodeEnv?: Record<string, string>;

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
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface EnsureProviderArgs {
  acpLaunchSpec?: HostDaemonAcpLaunchSpec;
  /**
   * Providers with thread-scoped processes use this to start the process for a
   * specific bb thread. Omit it for provider-scoped maintenance work such as
   * model listing.
   */
  forThreadId?: string;
  providerId: string;
}

export interface StartThreadArgs {
  acpLaunchSpec?: HostDaemonAcpLaunchSpec;
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
  /** JSON Schema constraining the session's structured output. Session-level
   *  structured output is claude-code only (SDK `outputFormat` is fixed at
   *  query creation); other adapters reject it. Absent means no structured
   *  output. */
  outputSchema?: JsonObject;
  /**
   * Present means fork the new thread from this source provider session
   * instead of starting fresh; absent means a normal start.
   */
  fork?: { sourceProviderThreadId: string };
}

export interface StartThreadResult {
  providerThreadId: string;
}

export interface ResumeThreadArgs {
  acpLaunchSpec?: HostDaemonAcpLaunchSpec;
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

/** Provider-observed disposition for a configuration-only mutation. */
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

export interface SteerTurnAppliedResult {
  status: "steered";
}

export interface SteerTurnStaleResult {
  status: "stale";
  activeTurnId: string | null;
}

export type SteerTurnResult = SteerTurnAppliedResult | SteerTurnStaleResult;

export interface StopThreadArgs {
  threadId: string;
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

export interface ClearThreadGoalArgs {
  threadId: string;
}

export interface ArchiveThreadArgs {
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface UnarchiveThreadArgs {
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export interface ListModelsArgs {
  providerId: string;
  acpLaunchSpec?: HostDaemonAcpLaunchSpec;
  cwd?: string;
}

export interface ListNativeSessionsArgs {
  providerId: string;
  params: object;
}

/** Host-observed, thread-local facts used by Session Fabric settlement. */
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

export interface AgentRuntime {
  ensureProvider(args: EnsureProviderArgs): Promise<void>;

  startThread(args: StartThreadArgs): Promise<StartThreadResult>;

  resumeThread(args: ResumeThreadArgs): Promise<ResumeThreadResult>;

  /** Reconfigures an idle hosted thread and requires a provider response. */
  reconfigureThread(
    args: ReconfigureThreadArgs,
  ): Promise<ReconfigureThreadResult>;

  runTurn(args: RunTurnArgs): Promise<void>;

  /**
   * Registers completion observation before dispatch, then resolves only when
   * the matching top-level provider turn reaches a terminal event.
   */
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
  stopThread(args: StopThreadArgs): Promise<void>;

  clearThreadGoal(args: ClearThreadGoalArgs): Promise<{ cleared: boolean }>;

  renameThread(args: RenameThreadArgs): Promise<void>;

  archiveThread(args: ArchiveThreadArgs): Promise<void>;

  unarchiveThread(args: UnarchiveThreadArgs): Promise<void>;

  listModels(args: ListModelsArgs): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;

  /**
   * Sends the provider adapter's read-only native-session listing request.
   * The provider-specific discovery source validates and normalizes the raw
   * response immediately after this boundary.
   */
  listNativeSessions(args: ListNativeSessionsArgs): Promise<unknown>;

  listRunningProviders(): string[];

  /** All live provider process incarnations hosted by this runtime. */
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

  /** Current broker-owned execution options for a hosted thread. */
  getThreadExecutionOptions(
    threadId: string,
  ): AgentRuntimeExecutionOptions | null;

  /** Full host-internal configuration evidence for an attached thread. */
  getThreadConfigurationSnapshot(
    threadId: string,
  ): AgentRuntimeThreadConfigurationSnapshot | null;

  /** Process incarnation currently hosting a thread, or `null` when absent. */
  getProviderRuntimeIncarnation(
    threadId: string,
  ): AgentRuntimeProviderProcessIncarnation | null;

  /** OS process id for restart-liveness proof; null when not hosted. */
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

  /** Thread ids with an active turn. */
  getActiveThreadIds(): string[];

  /** Thread ids with an active turn or an accepted turn awaiting its first event. */
  getLiveThreadIds(): string[];

  /**
   * Whether any hosted thread still has an open background task (a workflow or
   * backgrounded command). These outlive their spawning turn, so a runtime with
   * no active turn can still be doing real work that a shutdown would destroy.
   */
  hasOpenBackgroundWork(): boolean;

  /** Whether one hosted thread has an observed open background task. */
  hasOpenBackgroundWorkForThread(threadId: string): boolean;

  /** Fail-closed settlement facts derived from this runtime's event stream. */
  getThreadSettlementState(threadId: string): AgentRuntimeThreadSettlementState;

  shutdown(): Promise<void>;
}
