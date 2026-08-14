import type {
  HostDaemonCommand,
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResponseMessage,
  HostDaemonOnlineRpcResultForCommand,
  HostDaemonOnlineRpcCommand,
  HostDaemonCommandResultForCommand,
  HostDaemonRpcCommand,
  HostDaemonRpcResultForCommand,
  HostDaemonCommandEnvironmentLane,
} from "@bb/host-daemon-contract";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { environmentMigrationSourceFenceDirectory } from "./environment-migration-storage.js";
import { performance } from "node:perf_hooks";
import {
  hostDaemonEnvironmentLaneForCommand,
  hostDaemonOnlineRpcResponseMessageSchema,
  isHostDaemonCommand,
  parseHostDaemonCommandResultForCommand,
  parseHostDaemonOnlineRpcResultForCommand,
  shouldFlushEventsBeforeReportingCommandResult,
} from "@bb/host-daemon-contract";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch.js";
import {
  ExpectedCommandDispatchError,
  isExpectedOnlineRpcFailureError,
} from "./command-dispatch-support.js";
import type { HostDaemonLogger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";

interface CommandRouterLogger extends Pick<HostDaemonLogger, "warn"> {
  debug?: HostDaemonLogger["debug"];
}

type EnvironmentLaneMode = HostDaemonCommandEnvironmentLane;
type ThreadStartCommand = Extract<HostDaemonCommand, { type: "thread.start" }>;
type ThreadStopCommand = Extract<HostDaemonCommand, { type: "thread.stop" }>;
type TurnSubmitCommand = Extract<HostDaemonCommand, { type: "turn.submit" }>;
type ThreadStartOrTurnSubmitCommand = ThreadStartCommand | TurnSubmitCommand;

interface ReadWriteLaneState {
  /** All admitted read and write work. Writes wait on this tail. */
  tail: Promise<void>;
  /** Last admitted write. Reads wait on this tail, then join `tail`. */
  writeTail: Promise<void>;
}

interface ReadWriteLaneArgs<T> {
  key: string;
  lanes: Map<string, ReadWriteLaneState>;
  mode: EnvironmentLaneMode;
  work: () => Promise<T>;
}

interface SerialLaneArgs<T> {
  key: string;
  lanes: Map<string, Promise<void>>;
  work: () => Promise<T>;
}

interface ReadWriteLaneIdleArgs {
  key: string;
  lanes: Map<string, ReadWriteLaneState>;
  state: ReadWriteLaneState;
  tail: Promise<void>;
}

interface ProviderExecutionLane {
  processKey: string;
  processMode: EnvironmentLaneMode;
  sessionKey: string;
}

interface ProviderProcessLaneKeyArgs {
  environmentId: string;
  providerId: string | null;
  threadId: string;
}

interface CreateProviderExecutionLaneArgs extends ProviderProcessLaneKeyArgs {
  processMode: EnvironmentLaneMode;
  sessionId: string;
}

interface ThreadProviderLaneIdentity {
  environmentId: string;
  providerId: string | null;
  providerThreadId: string | null;
  threadId: string;
}

interface ThreadProviderLaneTarget {
  environmentId: string;
  threadId: string;
}

interface InFlightThreadProviderLane {
  count: number;
  lane: ProviderExecutionLane;
}

type CommandRouterTask = Promise<HostDaemonCommandResultForCommand>;

export interface CommandRouterOptions {
  dataDir: CommandDispatchOptions["dataDir"];
  fetchProjectAttachment: CommandDispatchOptions["fetchProjectAttachment"];
  fetchSkillTree?: CommandDispatchOptions["fetchSkillTree"];
  runtimeManager: RuntimeManager;
  sessionDiscoveryCatalog: CommandDispatchOptions["sessionDiscoveryCatalog"];
  sessionRuntimeBroker: CommandDispatchOptions["sessionRuntimeBroker"];
  terminalManager?: CommandDispatchOptions["terminalManager"];
  eventSink: CommandDispatchOptions["eventSink"];
  listModels?: CommandDispatchOptions["listModels"];
  resolveInteractiveRequest?: CommandDispatchOptions["resolveInteractiveRequest"];
  caffeinateManager?: CommandDispatchOptions["caffeinateManager"];
  ensureConnectTunnelIdentity?: CommandDispatchOptions["ensureConnectTunnelIdentity"];
  threadStorageRootPath: string;
  logger: CommandRouterLogger;
}

const HOST_COMMAND_LIFECYCLE_LOG_THRESHOLD_MS = 1_000;
const CODEX_PROVIDER_ID = "codex";

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function elapsedMs(startedAtMs: number): number {
  return performance.now() - startedAtMs;
}

export class CommandRouter {
  private readonly logger;
  private readonly environmentLanes = new Map<string, ReadWriteLaneState>();
  private readonly environmentMigrationFences = new Map<string, string>();
  private readonly environmentMigrationFencesLoaded: Promise<void>;
  private environmentMigrationFenceMutationTail = Promise.resolve();
  // Per-thread barrier keyed by threadId. A turn submission
  // (turn.submit/thread.start) waits for an in-flight thread.unarchive of the
  // same thread so it cannot resume a still-archived provider session.
  private readonly threadUnarchiveBarriers = new Map<string, Promise<void>>();
  // Provider process lanes protect commands that share one provider process,
  // while session lanes serialize commands for one provider thread/session.
  private readonly providerProcessLanes = new Map<string, ReadWriteLaneState>();
  private readonly providerSessionLaneTails = new Map<string, Promise<void>>();
  private readonly threadTurnLaneTails = new Map<string, Promise<void>>();
  private readonly inFlightThreadProviderLanes = new Map<
    string,
    InFlightThreadProviderLane
  >();

  constructor(private readonly options: CommandRouterOptions) {
    this.logger = options.logger;
    this.environmentMigrationFencesLoaded =
      this.loadEnvironmentMigrationFences();
  }

  async handleOnlineRpcRequest(
    message: HostDaemonOnlineRpcRequestMessage,
  ): Promise<HostDaemonOnlineRpcResponseMessage> {
    const handlerStartedAtMs = performance.now();
    try {
      const result = await this.executeHostRpcCommand(message.command);
      this.logOnlineRpc({
        commandType: message.command.type,
        handlerMs: elapsedMs(handlerStartedAtMs),
        ok: true,
      });
      return hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        requestId: message.requestId,
        commandType: message.command.type,
        ok: true,
        result,
      });
    } catch (error) {
      const errorCode = getErrorCode(error);
      if (!isExpectedOnlineRpcFailureError(error)) {
        this.logger.warn(
          {
            type: message.command.type,
            err: error,
          },
          "online host RPC failed",
        );
      }
      this.logOnlineRpc({
        commandType: message.command.type,
        errorCode,
        handlerMs: elapsedMs(handlerStartedAtMs),
        ok: false,
      });
      return {
        type: "host-rpc.response",
        requestId: message.requestId,
        commandType: message.command.type,
        ok: false,
        errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeHostRpcCommand(
    command: HostDaemonRpcCommand,
  ): Promise<HostDaemonRpcResultForCommand> {
    await this.enforceEnvironmentMigrationFence(command);
    if (isHostDaemonCommand(command)) {
      return this.executeLiveDaemonCommand(command);
    }
    return this.executeOnlineRpcCommand(command);
  }

  private executeOnlineRpcCommand(
    command: HostDaemonOnlineRpcCommand,
  ): Promise<HostDaemonOnlineRpcResultForCommand> {
    const environmentLaneMode = this.getEnvironmentLaneMode(command);
    const providerLane = this.resolveProviderLane(command);
    return this.runInExecutionLanes(
      command,
      environmentLaneMode,
      providerLane,
      () => this.executeOnlineRpcCommandBody(command),
    );
  }

  private async executeOnlineRpcCommandBody(
    command: HostDaemonOnlineRpcCommand,
  ): Promise<HostDaemonOnlineRpcResultForCommand> {
    const result = await dispatchOnlineRpcCommand(
      command,
      this.createDispatchOptions(),
    );
    if (shouldFlushEventsBeforeReportingCommandResult(command)) {
      await this.options.eventSink.flush();
    }
    const parsed = parseHostDaemonOnlineRpcResultForCommand(command, result);
    if (
      (command.type === "environment.migration.source_abort" ||
        command.type === "environment.migration.source_complete") &&
      this.environmentMigrationFences.get(command.environmentId) ===
        command.migrationId
    ) {
      await this.releaseEnvironmentMigrationFence(command.environmentId);
    }
    return parsed;
  }

  private async enforceEnvironmentMigrationFence(
    command: HostDaemonRpcCommand,
  ): Promise<void> {
    await this.environmentMigrationFencesLoaded;
    if (!("environmentId" in command) || !command.environmentId) {
      return;
    }
    if (command.type === "environment.migration.source_fence") {
      await this.mutateEnvironmentMigrationFences(async () => {
        const existing = this.environmentMigrationFences.get(
          command.environmentId,
        );
        if (existing !== undefined && existing !== command.migrationId) {
          throw new ExpectedCommandDispatchError(
            "environment_migrating",
            `Environment ${command.environmentId} is already fenced by migration ${existing}`,
          );
        }
        if (existing === command.migrationId) {
          return;
        }
        this.environmentMigrationFences.set(
          command.environmentId,
          command.migrationId,
        );
        try {
          await this.persistEnvironmentMigrationFence({
            environmentId: command.environmentId,
            migrationId: command.migrationId,
          });
        } catch (error) {
          if (
            this.environmentMigrationFences.get(command.environmentId) ===
            command.migrationId
          ) {
            this.environmentMigrationFences.delete(command.environmentId);
          }
          throw error;
        }
      });
      return;
    }
    await this.environmentMigrationFenceMutationTail;
    if (!this.environmentMigrationFences.has(command.environmentId)) {
      return;
    }
    const migrationId = this.environmentMigrationFences.get(
      command.environmentId,
    );
    if (command.type.startsWith("environment.migration.")) {
      if (!("migrationId" in command) || command.migrationId !== migrationId) {
        throw new ExpectedCommandDispatchError(
          "environment_migrating",
          `Environment ${command.environmentId} is fenced by migration ${migrationId}`,
        );
      }
      return;
    }
    if (
      command.type === "interactive.resolve" ||
      command.type === "thread.stop" ||
      command.type === "thread.plan.cancel" ||
      command.type === "environment.provision.cancel"
    ) {
      return;
    }
    throw new ExpectedCommandDispatchError(
      "environment_migrating",
      `Environment ${command.environmentId} is migrating and cannot accept ${command.type}`,
    );
  }

  private environmentMigrationFenceDirectory(): string {
    return environmentMigrationSourceFenceDirectory(this.options.dataDir);
  }

  private environmentMigrationFencePath(environmentId: string): string {
    const key = createHash("sha256").update(environmentId).digest("hex");
    return path.join(this.environmentMigrationFenceDirectory(), `${key}.json`);
  }

  private async loadEnvironmentMigrationFences(): Promise<void> {
    const directory = this.environmentMigrationFenceDirectory();
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(directory, entry);
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
        environmentId?: unknown;
        migrationId?: unknown;
      };
      if (
        typeof parsed.environmentId !== "string" ||
        parsed.environmentId.length === 0 ||
        typeof parsed.migrationId !== "string" ||
        parsed.migrationId.length === 0
      ) {
        throw new Error(`Invalid environment migration fence: ${filePath}`);
      }
      const existing = this.environmentMigrationFences.get(
        parsed.environmentId,
      );
      if (existing !== undefined && existing !== parsed.migrationId) {
        throw new Error(
          `Conflicting migration fences for environment ${parsed.environmentId}`,
        );
      }
      this.environmentMigrationFences.set(
        parsed.environmentId,
        parsed.migrationId,
      );
    }
  }

  private async persistEnvironmentMigrationFence(fence: {
    environmentId: string;
    migrationId: string;
  }): Promise<void> {
    const directory = this.environmentMigrationFenceDirectory();
    const filePath = this.environmentMigrationFencePath(fence.environmentId);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, JSON.stringify(fence), "utf8");
    await fs.rename(temporaryPath, filePath);
  }

  private async releaseEnvironmentMigrationFence(
    environmentId: string,
  ): Promise<void> {
    await this.mutateEnvironmentMigrationFences(async () => {
      await fs.rm(this.environmentMigrationFencePath(environmentId), {
        force: true,
      });
      this.environmentMigrationFences.delete(environmentId);
    });
  }

  private mutateEnvironmentMigrationFences<T>(
    mutation: () => Promise<T>,
  ): Promise<T> {
    const task = this.environmentMigrationFenceMutationTail
      .catch(() => undefined)
      .then(mutation);
    this.environmentMigrationFenceMutationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private executeLiveDaemonCommand(
    command: HostDaemonCommand,
  ): Promise<HostDaemonCommandResultForCommand> {
    const environmentLaneMode = this.getEnvironmentLaneMode(command);
    const providerLane = this.resolveProviderLane(command);
    const task = this.runAfterThreadUnarchiveBarrier(command, () =>
      this.runInThreadTurnLane(command, () =>
        this.runInExecutionLanes(
          command,
          environmentLaneMode,
          providerLane,
          () => this.executeLiveDaemonCommandBody(command),
        ),
      ),
    );
    this.registerThreadUnarchiveBarrier(command, task);
    this.registerInFlightThreadProviderLane(command, task);
    return task;
  }

  private async executeLiveDaemonCommandBody(
    command: HostDaemonCommand,
  ): Promise<HostDaemonCommandResultForCommand> {
    const result = await dispatchCommand(command, this.createDispatchOptions());
    // Commands that emit thread events before completing preserve the previous
    // event-before-result ordering under live RPC.
    if (shouldFlushEventsBeforeReportingCommandResult(command)) {
      await this.options.eventSink.flush();
    }
    return parseHostDaemonCommandResultForCommand(command, result);
  }

  private runInEnvironmentLane<T>(
    environmentId: string,
    mode: EnvironmentLaneMode,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.runInReadWriteLane({
      key: environmentId,
      lanes: this.environmentLanes,
      mode,
      work,
    });
  }

  private runInExecutionLanes<T>(
    command: HostDaemonRpcCommand,
    environmentLaneMode: EnvironmentLaneMode | null,
    providerLane: ProviderExecutionLane | null,
    work: () => Promise<T>,
  ): Promise<T> {
    const providerWork = providerLane
      ? () => this.runInProviderLane(providerLane, work)
      : work;
    if (!environmentLaneMode) {
      return providerWork();
    }
    if (!("environmentId" in command) || !command.environmentId) {
      throw new Error(`Command ${command.type} is missing environmentId`);
    }
    return this.runInEnvironmentLane(
      command.environmentId,
      environmentLaneMode,
      providerWork,
    );
  }

  private runInThreadTurnLane<T>(
    command: HostDaemonCommand,
    work: () => Promise<T>,
  ): Promise<T> {
    if (command.type !== "thread.start" && command.type !== "turn.submit") {
      return work();
    }
    return this.runInSerialLane({
      key: command.threadId,
      lanes: this.threadTurnLaneTails,
      work,
    });
  }

  private runInProviderLane<T>(
    lane: ProviderExecutionLane,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.runInProviderProcessLane(
      lane.processKey,
      lane.processMode,
      () => this.runInProviderSessionLane(lane.sessionKey, work),
    );
  }

  private createDispatchOptions(): CommandDispatchOptions {
    return {
      fetchProjectAttachment: this.options.fetchProjectAttachment,
      fetchSkillTree: this.options.fetchSkillTree,
      runtimeManager: this.options.runtimeManager,
      sessionDiscoveryCatalog: this.options.sessionDiscoveryCatalog,
      sessionRuntimeBroker: this.options.sessionRuntimeBroker,
      terminalManager: this.options.terminalManager,
      dataDir: this.options.dataDir,
      eventSink: this.options.eventSink,
      listModels: this.options.listModels,
      resolveInteractiveRequest: this.options.resolveInteractiveRequest,
      caffeinateManager: this.options.caffeinateManager,
      ensureConnectTunnelIdentity: this.options.ensureConnectTunnelIdentity,
      threadStorageRootPath: this.options.threadStorageRootPath,
    };
  }

  private logOnlineRpc(args: {
    commandType: HostDaemonRpcCommand["type"];
    errorCode?: string;
    handlerMs: number;
    ok: boolean;
  }): void {
    const shouldLog =
      args.handlerMs >= HOST_COMMAND_LIFECYCLE_LOG_THRESHOLD_MS || !args.ok;
    if (!shouldLog) {
      return;
    }

    this.logger.debug?.(
      {
        commandType: args.commandType,
        ...(args.errorCode ? { errorCode: args.errorCode } : {}),
        handlerMs: roundDurationMs(args.handlerMs),
        ok: args.ok,
      },
      "Online host RPC",
    );
  }

  private getOrCreateReadWriteLane(
    key: string,
    lanes: Map<string, ReadWriteLaneState>,
  ): ReadWriteLaneState {
    const existing = lanes.get(key);
    if (existing) {
      return existing;
    }
    const resolved = Promise.resolve();
    const state: ReadWriteLaneState = {
      tail: resolved,
      writeTail: resolved,
    };
    lanes.set(key, state);
    return state;
  }

  /**
   * Order a turn submission after any in-flight unarchive for the same thread.
   * thread.unarchive runs on the provider maintenance runtime while turn.submit
   * resumes the thread runtime, so the two are otherwise unordered and a turn
   * can reach the provider before the session is unarchived.
   */
  private async runAfterThreadUnarchiveBarrier<T>(
    command: HostDaemonCommand,
    work: () => Promise<T>,
  ): Promise<T> {
    if (command.type === "turn.submit" || command.type === "thread.start") {
      const barrier = this.threadUnarchiveBarriers.get(command.threadId);
      if (barrier) {
        await barrier;
      }
    }
    return work();
  }

  private registerThreadUnarchiveBarrier(
    command: HostDaemonCommand,
    task: CommandRouterTask,
  ): void {
    if (command.type !== "thread.unarchive") {
      return;
    }
    const { threadId } = command;
    const barrier = task.then(
      () => undefined,
      () => undefined,
    );
    this.threadUnarchiveBarriers.set(threadId, barrier);
    void barrier.then(() => {
      if (this.threadUnarchiveBarriers.get(threadId) === barrier) {
        this.threadUnarchiveBarriers.delete(threadId);
      }
    });
  }

  private runInProviderProcessLane<T>(
    key: string,
    mode: EnvironmentLaneMode,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.runInReadWriteLane({
      key,
      lanes: this.providerProcessLanes,
      mode,
      work,
    });
  }

  private runInProviderSessionLane<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.runInSerialLane({
      key,
      lanes: this.providerSessionLaneTails,
      work,
    });
  }

  private runInSerialLane<T>({
    key,
    lanes,
    work,
  }: SerialLaneArgs<T>): Promise<T> {
    const previousTail = lanes.get(key) ?? Promise.resolve();
    const next = previousTail.catch(() => undefined).then(work);
    const done = next.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(key, done);
    void done.then(() => {
      if (lanes.get(key) === done) {
        lanes.delete(key);
      }
    });
    return next;
  }

  private runInReadWriteLane<T>({
    key,
    lanes,
    mode,
    work,
  }: ReadWriteLaneArgs<T>): Promise<T> {
    const state = this.getOrCreateReadWriteLane(key, lanes);
    if (mode === "read") {
      const previousWrite = state.writeTail;
      const next = previousWrite.catch(() => undefined).then(work);
      const done = next.then(
        () => undefined,
        () => undefined,
      );
      const previousTail = state.tail;
      // Reads only wait for earlier writes, so adjacent reads can run together.
      // They still join the full tail so later writes wait for every active read.
      const tail = Promise.all([
        previousTail.catch(() => undefined),
        done,
      ]).then(() => undefined);
      state.tail = tail;
      this.deleteReadWriteLaneWhenIdle({ key, lanes, state, tail });
      return next;
    }

    const next = state.tail.catch(() => undefined).then(work);
    const done = next.then(
      () => undefined,
      () => undefined,
    );
    state.tail = done;
    state.writeTail = done;
    this.deleteReadWriteLaneWhenIdle({ key, lanes, state, tail: done });
    return next;
  }

  private deleteReadWriteLaneWhenIdle({
    key,
    lanes,
    state,
    tail,
  }: ReadWriteLaneIdleArgs): void {
    void tail.then(() => {
      if (lanes.get(key) === state && state.tail === tail) {
        lanes.delete(key);
      }
    });
  }

  private getProviderProcessLaneKey(args: ProviderProcessLaneKeyArgs): string {
    // Legacy or thread.stop paths can lack provider ownership. Bucket them
    // together per environment so unknown ownership stays conservative without
    // serializing unrelated environments.
    const providerKey = args.providerId ?? "unknown-provider";
    if (providerKey !== CODEX_PROVIDER_ID) {
      return `${args.environmentId}\0${providerKey}`;
    }
    return `${args.environmentId}\0${providerKey}\0thread:${args.threadId}`;
  }

  private getProviderSessionLaneKey(
    processKey: string,
    sessionId: string,
  ): string {
    return `${processKey}\0${sessionId}`;
  }

  private createProviderExecutionLane(
    args: CreateProviderExecutionLaneArgs,
  ): ProviderExecutionLane {
    const processKey = this.getProviderProcessLaneKey({
      environmentId: args.environmentId,
      providerId: args.providerId,
      threadId: args.threadId,
    });
    return {
      processKey,
      processMode: args.processMode,
      sessionKey: this.getProviderSessionLaneKey(processKey, args.sessionId),
    };
  }

  private getThreadProviderLaneIdentityKey(
    args: ThreadProviderLaneTarget,
  ): string {
    return `${args.environmentId}\0${args.threadId}`;
  }

  private createThreadProviderExecutionLane(
    identity: ThreadProviderLaneIdentity,
    processMode: EnvironmentLaneMode,
  ): ProviderExecutionLane {
    const sessionId =
      identity.providerThreadId === null
        ? `thread:${identity.threadId}`
        : `provider-thread:${identity.providerThreadId}`;
    return this.createProviderExecutionLane({
      environmentId: identity.environmentId,
      processMode,
      providerId: identity.providerId,
      sessionId,
      threadId: identity.threadId,
    });
  }

  private createInFlightThreadStopLane(
    command: ThreadStartOrTurnSubmitCommand,
  ): ProviderExecutionLane {
    if (command.type === "thread.start") {
      return this.createThreadProviderExecutionLane(
        {
          environmentId: command.environmentId,
          providerId: command.providerId,
          providerThreadId: null,
          threadId: command.threadId,
        },
        "write",
      );
    }

    return this.createThreadProviderExecutionLane(
      {
        environmentId: command.environmentId,
        providerId: command.resumeContext.providerId,
        providerThreadId: command.resumeContext.providerThreadId,
        threadId: command.threadId,
      },
      "write",
    );
  }

  private getInFlightThreadStopProviderLane(
    command: ThreadStopCommand,
  ): ProviderExecutionLane | null {
    const entry = this.inFlightThreadProviderLanes.get(
      this.getThreadProviderLaneIdentityKey(command),
    );
    return entry?.lane ?? null;
  }

  private registerInFlightThreadProviderLane(
    command: HostDaemonCommand,
    task: CommandRouterTask,
  ): void {
    if (command.type !== "thread.start" && command.type !== "turn.submit") {
      return;
    }

    const key = this.getThreadProviderLaneIdentityKey(command);
    const existing = this.inFlightThreadProviderLanes.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.inFlightThreadProviderLanes.set(key, {
        count: 1,
        lane: this.createInFlightThreadStopLane(command),
      });
    }

    void task.then(
      () => this.unregisterInFlightThreadProviderLane(key),
      () => this.unregisterInFlightThreadProviderLane(key),
    );
  }

  private unregisterInFlightThreadProviderLane(key: string): void {
    const existing = this.inFlightThreadProviderLanes.get(key);
    if (!existing) {
      return;
    }
    if (existing.count > 1) {
      existing.count -= 1;
      return;
    }
    this.inFlightThreadProviderLanes.delete(key);
  }

  private resolveProviderLane(
    command: HostDaemonRpcCommand,
  ): ProviderExecutionLane | null {
    switch (command.type) {
      case "session.runtime.inspect":
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId: command.expectedProviderId,
            providerThreadId: command.expectedProviderThreadId,
            threadId: command.threadId,
          },
          "read",
        );
      case "session.runtime.bind":
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId: command.expectedProviderId,
            providerThreadId: command.expectedProviderThreadId,
            threadId: command.threadId,
          },
          "read",
        );
      case "session.runtime.recover":
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId: command.providerId,
            providerThreadId: command.expectedProviderThreadId,
            threadId: command.threadId,
          },
          "read",
        );
      case "session.handoff.stage_destination":
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId: command.providerId,
            providerThreadId: null,
            threadId: command.threadId,
          },
          "read",
        );
      case "session.runtime.set_mutation_policy":
      case "session.handoff.fence_source":
      case "session.handoff.inspect_source":
      case "session.handoff.restore_source":
      case "session.handoff.restate_destination":
      case "session.handoff.enable_destination": {
        const session = this.options.runtimeManager
          .get(command.environmentId)
          ?.runtime.getProviderSession(command.threadId);
        const control = this.options.sessionRuntimeBroker.get(
          command.bindingId,
        );
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId:
              session?.providerId ?? control?.incarnation.providerId ?? null,
            providerThreadId: session?.providerThreadId ?? null,
            threadId: command.threadId,
          },
          "read",
        );
      }
      case "session.handoff.discard_destination":
      case "session.handoff.retire_source": {
        const session = this.options.runtimeManager
          .get(command.environmentId)
          ?.runtime.getProviderSession(command.threadId);
        const control = this.options.sessionRuntimeBroker.get(
          command.bindingId,
        );
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId:
              session?.providerId ?? control?.incarnation.providerId ?? null,
            providerThreadId: session?.providerThreadId ?? null,
            threadId: command.threadId,
          },
          "write",
        );
      }
      case "thread.start":
        return this.createProviderExecutionLane({
          environmentId: command.environmentId,
          processMode: "read",
          providerId: command.providerId,
          sessionId: `thread:${command.threadId}`,
          threadId: command.threadId,
        });
      case "turn.submit":
        return this.createProviderExecutionLane({
          environmentId: command.environmentId,
          processMode: "read",
          providerId: command.resumeContext.providerId,
          sessionId: `provider-thread:${command.resumeContext.providerThreadId}`,
          threadId: command.threadId,
        });
      case "session.model_change":
        return this.createProviderExecutionLane({
          environmentId: command.environmentId,
          processMode: "read",
          providerId: command.requestedModel.providerId,
          sessionId: `thread:${command.threadId}`,
          threadId: command.threadId,
        });
      case "thread.archive":
        return this.createProviderExecutionLane({
          environmentId: command.environmentId,
          processMode: "read",
          providerId: command.providerId,
          sessionId: `provider-thread:${command.providerThreadId}`,
          threadId: command.threadId,
        });
      case "interactive.resolve":
        return this.createProviderExecutionLane({
          environmentId: command.environmentId,
          processMode: "read",
          providerId: command.providerId,
          sessionId: `provider-thread:${command.providerThreadId}`,
          threadId: command.threadId,
        });
      case "thread.stop":
      case "thread.plan.cancel": {
        const session = this.options.runtimeManager
          .get(command.environmentId)
          ?.runtime.getProviderSession(command.threadId);
        if (session) {
          return this.createThreadProviderExecutionLane(
            {
              environmentId: command.environmentId,
              providerId: session.providerId,
              providerThreadId: session.providerThreadId,
              threadId: command.threadId,
            },
            "write",
          );
        }
        return command.type === "thread.stop"
          ? this.getInFlightThreadStopProviderLane(command)
          : null;
      }
      case "thread.goal.clear": {
        const session = this.options.runtimeManager
          .get(command.environmentId)
          ?.runtime.getProviderSession(command.threadId);
        return this.createThreadProviderExecutionLane(
          {
            environmentId: command.environmentId,
            providerId: session?.providerId ?? command.resumeContext.providerId,
            providerThreadId:
              session?.providerThreadId ??
              command.resumeContext.providerThreadId,
            threadId: command.threadId,
          },
          "write",
        );
      }
      default:
        return null;
    }
  }

  private getEnvironmentLaneMode(
    command: HostDaemonCommand | HostDaemonOnlineRpcCommand,
  ): EnvironmentLaneMode | null {
    return hostDaemonEnvironmentLaneForCommand(command);
  }
}
