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

export interface AgentRuntimeContributedEnvEntry {
  name: string;
  value: string | { serverPath: string };
  source: { plugin: string } | { core: "machine-git" | "machine-environment" };
  reason: string;
}

export type AgentRuntimeExecutionOptions = RuntimeThreadExecutionOptions;

/**
 * Host-enforced provider session overlay. A handoff-restatement session is
 * intentionally read-only even when the destination thread will later run
 * with a more permissive policy.
 */
export type AgentRuntimeExecutionSafety = "standard" | "handoff_restatement";

export type AgentRuntimeSkillRoot = SkillsConfigureRoot;

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

export interface AgentRuntimeOptions {
  workspacePath: string;

  additionalWorkspaceWriteRoots?: readonly string[];

  env?: Record<string, string>;

  shellEnv?: AgentRuntimeShellEnvironment;

  threadStorageRootPath?: string;

  bridgeBundleDir?: string;
  turnStartWatchdog?: { thresholdMs?: number; intervalMs?: number };
  rateLimitRetry?: { delaysMs?: readonly number[] };
  threadCreation?: { requestTimeoutMs?: number };

  skillRoots?: readonly AgentRuntimeSkillRoot[];

  onEvent: (event: ThreadEvent) => void;

  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;

  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;

  onStderr?: (line: string, threadId?: string) => void;

  onProcessExit?: (info: AgentRuntimeProcessExitInfo) => void;

  onProviderRecovery?: (hint: AgentRuntimeProviderRecoveryHint) => void;
}

export interface AgentRuntimeProviderRecoveryHint {
  providerId: string;
  threadId?: string;
  kind: ProviderRecoveryKind;
  message: string;
  retryable: boolean;
}

export interface AgentRuntimeBridgeLaunch {
  pluginId: string;
  dataDir: string;
  source: { kind: "artifact"; digest: string; artifactPath: string };
  capabilities: {
    providerInstallation: boolean;
    supportsServiceTier: boolean;
    permissionModes: PermissionMode[];
    supportsThreadArchive: boolean;
    supportsThreadRename: boolean;
    fork: ProviderFork;
  };
  providerOptions: JsonObject;
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
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
  executionSafety?: AgentRuntimeExecutionSafety;
  clientRequestId?: ClientTurnRequestId;
  input?: PromptInput[];
  options: AgentRuntimeExecutionOptions;
  instructions?: string;
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode?: InstructionMode;
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
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
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
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
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
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
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
  clientRequestId: ClientTurnRequestId;
  options: AgentRuntimeExecutionOptions;
  contributedEnv?: readonly AgentRuntimeContributedEnvEntry[];
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

  providerHealth(args: ProviderMaintenanceArgs): Promise<ProviderHealthResult>;

  providerUsage(args: ProviderMaintenanceArgs): Promise<ProviderUsageResult>;

  providerInstallationStatus(
    args: ProviderInstallationStatusArgs,
  ): Promise<ProviderInstallationStatus>;

  providerInstallationRun(
    args: ProviderMaintenanceArgs & { action: "install" | "update" },
  ): Promise<ProviderInstallationRunResult>;

  listRunningProviders(): string[];

  listProviderRuntimeIncarnations(): AgentRuntimeProviderProcessIncarnation[];

  getActiveTurnId(threadId: string): string | null;

  waitForActiveTurn(
    threadId: string,
    args: WaitForActiveTurnArgs,
  ): Promise<string | null>;

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

  reapIdleProviderSessions(
    args: ReapIdleProviderSessionsArgs,
  ): Promise<ReapIdleProviderSessionsResult>;

  hasThread(threadId: string): boolean;

  getLiveThreadIds(): string[];

  getActiveThreadIds(): string[];

  hasOpenBackgroundWork(): boolean;

  hasOpenBackgroundWorkForThread(threadId: string): boolean;

  getThreadSettlementState(threadId: string): AgentRuntimeThreadSettlementState;

  shutdown(): Promise<void>;
}
