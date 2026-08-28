import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, parse, resolve } from "node:path";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  sanitizeInheritedChildProcessEnv,
  spawnPortableProcess,
  type PortableChildProcess,
  type PortableSpawnRequest,
} from "@bb/process-utils";
import { WebSocket, type RawData } from "ws";
import type { HostDaemonLogger } from "./logger.js";

const CODEX_CONTROL_DIRECTORY = "app-server-control";
const CODEX_STATE_DIRECTORY = "bb-app-server-state";
const CODEX_LOG_DIRECTORY = "bb-app-server-logs";
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const STARTUP_POLL_INTERVAL_MS = 50;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const LOG_TAIL_MAX_BYTES = 4_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SOCKET_MODE = 0o600;
const WRITE_BY_NON_OWNER_MODE = 0o022;
const STICKY_DIRECTORY_MODE = 0o1000;
const ROOT_UID = 0;

export interface CodexAppServerRuntime {
  readonly socketPath: string;
  ensureRunning(): Promise<void>;
}

export interface CodexAppServerPool {
  forSkillCatalog(catalogHash: string): CodexAppServerRuntime;
  shutdown(): Promise<void>;
}

export interface ResolveCodexAppServerSocketPathArgs {
  catalogHash: string;
  env: NodeJS.ProcessEnv;
  generationId: string;
  homeDir?: string;
  shortSocketRoot?: string;
  uid?: number;
}

interface CodexAppServerCommonOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  logger: Pick<HostDaemonLogger, "debug" | "info" | "warn">;
  isProcessAlive?: (pid: number) => boolean;
  probeServer?: (socketPath: string) => Promise<boolean>;
  secureSocket?: (args: {
    socketPath: string;
    uid: number;
  }) => Promise<SocketIdentity | null>;
  shortSocketRoot?: string;
  spawnAppServer?: (request: PortableSpawnRequest) => PortableChildProcess;
  startupTimeoutMs?: number;
  uid?: number;
  verifySocketOwner?: (args: {
    pid: number;
    socketPath: string;
  }) => Promise<boolean>;
}

interface CreateCodexAppServerPoolOptions extends CodexAppServerCommonOptions {
  getEnv: () => NodeJS.ProcessEnv;
  lifecycleId: string;
}

interface CreateCodexAppServerSupervisorOptions extends CodexAppServerCommonOptions {
  catalogHash: string;
  generationId: string;
  runtimeEnv: NodeJS.ProcessEnv;
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface StartupLock {
  readonly identity: SocketIdentity;
}

interface StartupLockMetadata {
  readonly pid: number;
}

function resolveCodexHome(args: {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  return canonicalizePathFromExistingAncestor(
    args.env.CODEX_HOME?.trim() || join(args.homeDir ?? homedir(), ".codex"),
  );
}

function canonicalizePathFromExistingAncestor(path: string): string {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cursor), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Could not resolve an existing ancestor for ${path}`);
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

function runtimeFingerprint(args: {
  catalogHash: string;
  generationId: string;
}): string {
  const catalogHash = args.catalogHash.trim();
  if (catalogHash.trim().length === 0) {
    throw new Error("Codex app-server skill catalog hash is required");
  }
  const generationId = args.generationId.trim();
  if (generationId.length === 0) {
    throw new Error("Codex app-server generation identity is required");
  }
  return createHash("sha256")
    .update(generationId)
    .update("\0")
    .update(catalogHash)
    .digest("hex")
    .slice(0, 16);
}

function resolveCodexExecutableIdentity(env: NodeJS.ProcessEnv): string {
  const executableNames =
    process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex"]
      : ["codex"];
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName);
      try {
        accessSync(candidate, fsConstants.X_OK);
        const executablePath = realpathSync(candidate);
        const stats = statSync(executablePath);
        return [
          executablePath,
          stats.dev,
          stats.ino,
          stats.size,
          stats.mtimeMs,
        ].join(":");
      } catch {
        // Continue searching the exact PATH the app-server will inherit.
      }
    }
  }
  return `unresolved:${pathValue}`;
}

export function resolveCodexAppServerGeneration(args: {
  env: NodeJS.ProcessEnv;
  lifecycleId: string;
}): string {
  const lifecycleId = args.lifecycleId.trim();
  if (lifecycleId.length === 0) {
    throw new Error("Codex app-server lifecycle identity is required");
  }
  return createHash("sha256")
    .update(lifecycleId)
    .update("\0")
    .update(resolveCodexExecutableIdentity(args.env))
    .digest("hex");
}

function protocolDirectory(): string {
  return `v${HOST_DAEMON_PROTOCOL_VERSION}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExistingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function childHasExited(child: PortableChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function formatChildExit(child: PortableChildProcess): string {
  if (child.signalCode !== null) {
    return `signal ${child.signalCode}`;
  }
  if (child.exitCode !== null) {
    return `exit code ${child.exitCode}`;
  }
  return "an unknown status";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function waitForChildExit(
  child: PortableChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

async function ensurePrivateDirectory(args: {
  path: string;
  uid: number;
}): Promise<void> {
  const absolutePath = resolve(args.path);
  const pathComponents: string[] = [];
  for (
    let current = absolutePath;
    current !== parse(current).root;
    current = dirname(current)
  ) {
    pathComponents.unshift(current);
  }

  for (const component of pathComponents) {
    let stats;
    try {
      stats = await lstat(component);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      try {
        await mkdir(component, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (mkdirError) {
        if (!isExistingPathError(mkdirError)) {
          throw mkdirError;
        }
      }
      stats = await lstat(component);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Refusing insecure Codex control directory ${component}`);
    }
    if (stats.uid !== ROOT_UID && stats.uid !== args.uid) {
      throw new Error(
        `Refusing Codex control directory ancestor ${component} owned by uid ${stats.uid}`,
      );
    }
    if (
      (stats.mode & WRITE_BY_NON_OWNER_MODE) !== 0 &&
      (stats.mode & STICKY_DIRECTORY_MODE) === 0
    ) {
      throw new Error(
        `Refusing writable Codex control directory ancestor ${component}`,
      );
    }
  }

  const stats = await lstat(absolutePath);
  if (stats.uid !== args.uid) {
    throw new Error(
      `Refusing Codex control directory ${absolutePath} owned by uid ${stats.uid}`,
    );
  }
  await chmod(absolutePath, PRIVATE_DIRECTORY_MODE);
}

async function secureSocketIfPresent(args: {
  socketPath: string;
  uid: number;
}): Promise<SocketIdentity | null> {
  let stats;
  try {
    stats = await lstat(args.socketPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isSocket()) {
    throw new Error(
      `Refusing insecure Codex control socket ${args.socketPath}`,
    );
  }
  if (stats.uid !== args.uid) {
    throw new Error(
      `Refusing Codex control socket ${args.socketPath} owned by uid ${stats.uid}`,
    );
  }
  await chmod(args.socketPath, PRIVATE_SOCKET_MODE);
  return { dev: stats.dev, ino: stats.ino };
}

function sameSocketIdentity(
  left: SocketIdentity,
  right: SocketIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function verifySocketOwnerWithLsof(args: {
  pid: number;
  socketPath: string;
}): Promise<boolean> {
  return new Promise((resolveOwner, reject) => {
    execFile(
      "/usr/sbin/lsof",
      [
        "-a",
        "-n",
        "-P",
        "-U",
        "-p",
        String(args.pid),
        "-Fn",
        "--",
        args.socketPath,
      ],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error === null) {
          resolveOwner(
            stdout.split("\n").some((line) => line === `n${args.socketPath}`),
          );
          return;
        }
        if (
          "code" in error &&
          typeof error.code === "number" &&
          error.code === 1
        ) {
          resolveOwner(false);
          return;
        }
        reject(
          new Error(
            `Could not inspect Codex app-server socket ownership: ${error.message}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

async function verifySocketOwnerWithProc(args: {
  pid: number;
  socketPath: string;
}): Promise<boolean> {
  const unixSockets = await readFile("/proc/net/unix", "utf8");
  let socketInode: string | null = null;
  for (const line of unixSockets.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length >= 8 && fields.slice(7).join(" ") === args.socketPath) {
      socketInode = fields[6] ?? null;
      break;
    }
  }
  if (socketInode === null) {
    return false;
  }

  let descriptors: string[];
  try {
    descriptors = await readdir(`/proc/${args.pid}/fd`);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  for (const descriptor of descriptors) {
    try {
      if (
        (await readlink(`/proc/${args.pid}/fd/${descriptor}`)) ===
        `socket:[${socketInode}]`
      ) {
        return true;
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  return false;
}

export function verifyProcessOwnsCodexSocket(args: {
  pid: number;
  socketPath: string;
}): Promise<boolean> {
  if (process.platform === "darwin") {
    return verifySocketOwnerWithLsof(args);
  }
  if (process.platform === "linux") {
    return verifySocketOwnerWithProc(args);
  }
  throw new Error(
    `Codex app-server Unix socket ownership is unsupported on ${process.platform}`,
  );
}

function parseStartupLockMetadata(
  contents: string,
): StartupLockMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    return null;
  }
  return { pid: value.pid };
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const bytes = await readFile(logPath);
    return bytes
      .subarray(Math.max(0, bytes.length - LOG_TAIL_MAX_BYTES))
      .toString("utf8");
  } catch {
    return "";
  }
}

export function resolveCodexAppServerSocketPath(
  args: ResolveCodexAppServerSocketPathArgs,
): string {
  const codexHome = resolveCodexHome(args);
  const fingerprint = runtimeFingerprint({
    catalogHash: args.catalogHash,
    generationId: args.generationId,
  });
  const preferredPath = join(
    codexHome,
    CODEX_CONTROL_DIRECTORY,
    protocolDirectory(),
    `${fingerprint}.sock`,
  );
  if (Buffer.byteLength(preferredPath, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferredPath;
  }

  const uid = args.uid ?? process.getuid?.() ?? 0;
  const pathFingerprint = createHash("sha256")
    .update(preferredPath)
    .digest("hex")
    .slice(0, 16);
  return join(
    canonicalizePathFromExistingAncestor(args.shortSocketRoot ?? "/tmp"),
    `bb-codex-${uid}`,
    protocolDirectory(),
    `${pathFingerprint}.sock`,
  );
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function isSuccessfulHealthResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    "id" in value &&
    value.id === "bb-health" &&
    "result" in value &&
    typeof value.result === "object" &&
    value.result !== null
  );
}

export function probeCodexAppServer(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const websocket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(socketPath),
      handshakeTimeout: HEALTH_PROBE_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    let settled = false;
    const settle = (healthy: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      websocket.terminate();
      resolve(healthy);
    };
    const timer = setTimeout(() => settle(false), HEALTH_PROBE_TIMEOUT_MS);
    timer.unref();
    websocket.once("open", () => {
      try {
        websocket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "bb-health",
            method: "initialize",
            params: {
              capabilities: { experimentalApi: true },
              clientInfo: {
                name: "bb-health",
                title: null,
                version: "1.0.0",
              },
            },
          }),
          (error) => {
            if (error) settle(false);
          },
        );
      } catch {
        settle(false);
      }
    });
    websocket.on("message", (data) => {
      try {
        if (isSuccessfulHealthResponse(JSON.parse(rawDataText(data)))) {
          settle(true);
        }
      } catch {
        settle(false);
      }
    });
    websocket.once("error", () => settle(false));
    websocket.once("close", () => settle(false));
  });
}

class CodexAppServerSupervisor implements CodexAppServerRuntime {
  readonly socketPath: string;
  private readonly probeServer: (socketPath: string) => Promise<boolean>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly spawnAppServer: (
    request: PortableSpawnRequest,
  ) => PortableChildProcess;
  private readonly startupTimeoutMs: number;
  private readonly secureSocket: (args: {
    socketPath: string;
    uid: number;
  }) => Promise<SocketIdentity | null>;
  private readonly codexHome: string;
  private readonly codexSqliteHome: string;
  private readonly logPath: string;
  private readonly startupLockPath: string;
  private readonly uid: number;
  private readonly verifySocketOwner: (args: {
    pid: number;
    socketPath: string;
  }) => Promise<boolean>;
  private ownedChild: PortableChildProcess | null = null;
  private ownedSocketIdentity: SocketIdentity | null = null;
  private starting: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly options: CreateCodexAppServerSupervisorOptions) {
    const fingerprint = runtimeFingerprint({
      catalogHash: options.catalogHash,
      generationId: options.generationId,
    });
    this.codexHome = resolveCodexHome({
      env: options.env,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
    this.codexSqliteHome = join(
      this.codexHome,
      CODEX_STATE_DIRECTORY,
      protocolDirectory(),
      fingerprint,
    );
    this.logPath = join(
      this.codexHome,
      CODEX_LOG_DIRECTORY,
      protocolDirectory(),
      `${fingerprint}.log`,
    );
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.socketPath = resolveCodexAppServerSocketPath({
      catalogHash: options.catalogHash,
      env: options.env,
      generationId: options.generationId,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.shortSocketRoot !== undefined
        ? { shortSocketRoot: options.shortSocketRoot }
        : {}),
      uid: this.uid,
    });
    this.startupLockPath = `${this.socketPath}.start.lock`;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.probeServer = options.probeServer ?? probeCodexAppServer;
    this.secureSocket = options.secureSocket ?? secureSocketIfPresent;
    this.spawnAppServer = options.spawnAppServer ?? spawnPortableProcess;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.verifySocketOwner =
      options.verifySocketOwner ?? verifyProcessOwnsCodexSocket;
  }

  async ensureRunning(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error("Codex app-server supervisor is shutting down");
    }
    if (this.starting !== null) {
      await this.starting;
      return;
    }

    const starting = this.ensureRunningOnce();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) {
        this.starting = null;
      }
    }
  }

  private async ensureRunningOnce(): Promise<void> {
    await ensurePrivateDirectory({
      path: dirname(this.socketPath),
      uid: this.uid,
    });
    const startupLock = await this.acquireStartupLock();
    try {
      await this.ensureRunningWhileLocked();
    } finally {
      await this.removeStartupLockWithIdentity(startupLock.identity, false);
    }
  }

  private async acquireStartupLock(): Promise<StartupLock> {
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (this.shuttingDown) {
        throw new Error("Codex app-server supervisor is shutting down");
      }
      const startupLock = await this.tryPublishStartupLock();
      if (startupLock !== null) {
        return startupLock;
      }
      if (await this.recoverStaleStartupLock()) {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for Codex app-server startup ownership at ${this.startupLockPath}`,
        );
      }
      await delay(STARTUP_POLL_INTERVAL_MS);
    }
  }

  private async tryPublishStartupLock(): Promise<StartupLock | null> {
    const temporaryPath = `${this.startupLockPath}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryFile: FileHandle | null = null;
    let identity: SocketIdentity | null = null;
    let published = false;
    try {
      temporaryFile = await open(temporaryPath, "wx", PRIVATE_SOCKET_MODE);
      const stats = await temporaryFile.stat();
      if (stats.uid !== this.uid) {
        throw new Error(
          `Refusing Codex app-server startup lock temporary file ${temporaryPath} owned by uid ${stats.uid}`,
        );
      }
      identity = { dev: stats.dev, ino: stats.ino };
      await temporaryFile.writeFile(JSON.stringify({ pid: process.pid }));
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      try {
        await link(temporaryPath, this.startupLockPath);
        published = true;
      } catch (error) {
        if (!isExistingPathError(error)) {
          throw error;
        }
        await unlink(temporaryPath);
        return null;
      }
      await unlink(temporaryPath);
      return { identity };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (temporaryFile !== null) {
        try {
          await temporaryFile.close();
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      try {
        await unlinkIfPresent(temporaryPath);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
      if (published && identity !== null) {
        try {
          await this.removeStartupLockWithIdentity(identity, true);
        } catch (lockCleanupError) {
          cleanupErrors.push(lockCleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Failed to publish and clean up a Codex app-server startup lock",
        );
      }
      throw error;
    }
  }

  private async recoverStaleStartupLock(): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(this.startupLockPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return true;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(
        `Refusing insecure Codex app-server startup lock ${this.startupLockPath}`,
      );
    }
    if (stats.uid !== this.uid) {
      throw new Error(
        `Refusing Codex app-server startup lock ${this.startupLockPath} owned by uid ${stats.uid}`,
      );
    }
    if ((stats.mode & 0o777) !== PRIVATE_SOCKET_MODE) {
      throw new Error(
        `Refusing Codex app-server startup lock ${this.startupLockPath} with mode ${(stats.mode & 0o777).toString(8)}`,
      );
    }
    const identity = { dev: stats.dev, ino: stats.ino };
    const metadata = parseStartupLockMetadata(
      await readFile(this.startupLockPath, "utf8"),
    );
    if (metadata === null) {
      throw new Error(
        `Refusing Codex app-server startup lock ${this.startupLockPath} with invalid metadata`,
      );
    }
    if (this.isProcessAlive(metadata.pid)) {
      return false;
    }
    return this.removeStartupLockWithIdentity(identity, true);
  }

  private async removeStartupLockWithIdentity(
    expected: SocketIdentity,
    allowMissing: boolean,
  ): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(this.startupLockPath);
    } catch (error) {
      if (allowMissing && isMissingPathError(error)) {
        return true;
      }
      throw error;
    }
    const current = { dev: stats.dev, ino: stats.ino };
    if (!sameSocketIdentity(current, expected)) {
      if (allowMissing) {
        return false;
      }
      throw new Error(
        `Refusing to remove a replaced Codex app-server startup lock at ${this.startupLockPath}`,
      );
    }
    await unlinkIfPresent(this.startupLockPath);
    return true;
  }

  private async ensureRunningWhileLocked(): Promise<void> {
    if (await this.probeServer(this.socketPath)) {
      const expectedSocketIdentity = this.ownedSocketIdentity;
      const ownedChild = this.ownedChild;
      if (
        expectedSocketIdentity === null ||
        ownedChild === null ||
        childHasExited(ownedChild)
      ) {
        throw new Error(
          `Refusing to attach to an unowned Codex app-server at ${this.socketPath}`,
        );
      }
      if (
        !(await this.socketBelongsToChild(ownedChild, expectedSocketIdentity))
      ) {
        this.ownedSocketIdentity = null;
        if (!childHasExited(ownedChild)) {
          await this.stopChild(ownedChild);
        }
        throw new Error(
          `Refusing a Codex app-server socket not owned by process ${ownedChild.pid ?? "unknown"} at ${this.socketPath}`,
        );
      }
      this.options.logger.debug(
        { socketPath: this.socketPath },
        "Using owned isolated Codex app-server",
      );
      return;
    }

    if (
      this.ownedSocketIdentity === null &&
      (await pathExists(this.socketPath))
    ) {
      throw new Error(
        `Refusing to replace an unowned Codex app-server socket at ${this.socketPath}`,
      );
    }

    if (this.ownedSocketIdentity !== null) {
      const expectedSocketIdentity = this.ownedSocketIdentity;
      const ownedChild = this.ownedChild;
      if (ownedChild !== null && !childHasExited(ownedChild)) {
        await this.stopChild(ownedChild);
      }
      this.ownedSocketIdentity = null;
      await this.removeSocketWithIdentity(expectedSocketIdentity);
    }

    await ensurePrivateDirectory({ path: this.codexSqliteHome, uid: this.uid });
    await ensurePrivateDirectory({
      path: dirname(this.logPath),
      uid: this.uid,
    });
    const log = await open(this.logPath, "a", PRIVATE_SOCKET_MODE);
    let child: PortableChildProcess;
    let spawnError: Error | null = null;
    try {
      child = this.spawnAppServer({
        command: "codex",
        args: ["app-server", "--listen", `unix://${this.socketPath}`],
        cwd: this.options.dataDir,
        detached: false,
        env: {
          ...sanitizeInheritedChildProcessEnv({ env: process.env }),
          ...sanitizeInheritedChildProcessEnv({ env: this.options.runtimeEnv }),
          CODEX_HOME: this.codexHome,
          CODEX_SQLITE_HOME: this.codexSqliteHome,
        },
        stdio: ["ignore", log.fd, log.fd],
      });
      this.ownedChild = child;
      child.unref();
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("exit", (code, signal) => {
        if (this.ownedChild === child) {
          this.ownedChild = null;
        }
        this.options.logger.warn(
          { code, signal, socketPath: this.socketPath },
          "Isolated Codex app-server exited",
        );
      });
    } finally {
      await log.close();
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let startupSocketIdentity: SocketIdentity | null = null;
    let verifiedStartupSocketIdentity: SocketIdentity | null = null;
    try {
      while (Date.now() <= deadline) {
        if (this.shuttingDown) {
          throw new Error("Codex app-server supervisor is shutting down");
        }
        startupSocketIdentity = await this.observeStartupSocket(
          startupSocketIdentity,
        );
        if (
          startupSocketIdentity !== null &&
          (await this.socketBelongsToChild(child, startupSocketIdentity))
        ) {
          verifiedStartupSocketIdentity = startupSocketIdentity;
        }
        const reachable = await this.probeServer(this.socketPath);
        startupSocketIdentity = await this.observeStartupSocket(
          startupSocketIdentity,
        );
        if (reachable) {
          if (childHasExited(child) || this.ownedChild !== child) {
            throw new Error(
              `Refusing a Codex app-server socket not owned by the spawned child at ${this.socketPath}`,
            );
          }
          if (startupSocketIdentity === null) {
            throw new Error(
              `Codex app-server socket disappeared during startup: ${this.socketPath}`,
            );
          }
          if (
            !(await this.socketBelongsToChild(child, startupSocketIdentity))
          ) {
            throw new Error(
              `Refusing a Codex app-server socket not owned by the spawned process ${child.pid ?? "unknown"} at ${this.socketPath}`,
            );
          }
          verifiedStartupSocketIdentity = startupSocketIdentity;
          this.ownedSocketIdentity = verifiedStartupSocketIdentity;
          this.options.logger.info(
            {
              codexSqliteHome: this.codexSqliteHome,
              pid: child.pid,
              socketPath: this.socketPath,
            },
            "Started isolated Codex app-server",
          );
          return;
        }
        if (spawnError !== null) {
          throw new Error(
            `Could not start the isolated Codex app-server: ${errorMessage(spawnError)}`,
            { cause: spawnError },
          );
        }
        if (childHasExited(child)) {
          const detail = (await readLogTail(this.logPath)).trim();
          throw new Error(
            `Isolated Codex app-server exited during startup with ${formatChildExit(child)}` +
              (detail ? `\nlog tail: ${detail}` : ""),
          );
        }
        await delay(STARTUP_POLL_INTERVAL_MS);
      }
      throw new Error(
        `Timed out waiting for the isolated Codex app-server at ${this.socketPath}`,
      );
    } catch (error) {
      this.ownedSocketIdentity = null;
      try {
        await this.stopChild(child);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Failed to stop an unsuccessful Codex app-server startup",
        );
      }
      if (this.ownedChild === child) {
        this.ownedChild = null;
      }
      const cleanupSocketIdentity =
        verifiedStartupSocketIdentity ??
        startupSocketIdentity ??
        (await this.secureSocket({
          socketPath: this.socketPath,
          uid: this.uid,
        }));
      if (cleanupSocketIdentity !== null) {
        try {
          await this.removeSocketWithIdentity(cleanupSocketIdentity);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Failed to clean up an unsuccessful Codex app-server startup",
          );
        }
      }
      throw error;
    }
  }

  private async socketBelongsToChild(
    child: PortableChildProcess,
    expected: SocketIdentity,
  ): Promise<boolean> {
    const pid = child.pid;
    if (pid === undefined || childHasExited(child)) {
      return false;
    }
    const before = await this.secureSocket({
      socketPath: this.socketPath,
      uid: this.uid,
    });
    if (before === null || !sameSocketIdentity(before, expected)) {
      return false;
    }
    if (
      !(await this.verifySocketOwner({
        pid,
        socketPath: this.socketPath,
      }))
    ) {
      return false;
    }
    const after = await this.secureSocket({
      socketPath: this.socketPath,
      uid: this.uid,
    });
    return (
      after !== null &&
      sameSocketIdentity(after, expected) &&
      !childHasExited(child)
    );
  }

  private async observeStartupSocket(
    expected: SocketIdentity | null,
  ): Promise<SocketIdentity | null> {
    const current = await this.secureSocket({
      socketPath: this.socketPath,
      uid: this.uid,
    });
    if (current === null) {
      if (expected !== null) {
        throw new Error(
          `Codex app-server socket disappeared during startup: ${this.socketPath}`,
        );
      }
      return null;
    }
    if (expected !== null && !sameSocketIdentity(current, expected)) {
      throw new Error(
        `Refusing a replaced Codex app-server socket at ${this.socketPath}`,
      );
    }
    return current;
  }

  private async removeSocketWithIdentity(
    expected: SocketIdentity,
  ): Promise<void> {
    const current = await this.secureSocket({
      socketPath: this.socketPath,
      uid: this.uid,
    });
    if (current === null) {
      return;
    }
    if (!sameSocketIdentity(current, expected)) {
      throw new Error(
        `Refusing to remove a replaced Codex app-server socket at ${this.socketPath}`,
      );
    }
    await unlinkIfPresent(this.socketPath);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.starting;
    } catch {
      // Startup already performed its own child cleanup.
    }
    const ownedChild = this.ownedChild;
    if (ownedChild !== null) {
      await this.stopChild(ownedChild);
      if (this.ownedChild === ownedChild) {
        this.ownedChild = null;
      }
    }
    if (this.ownedSocketIdentity !== null) {
      const expectedSocketIdentity = this.ownedSocketIdentity;
      this.ownedSocketIdentity = null;
      await this.removeSocketWithIdentity(expectedSocketIdentity);
    }
  }

  private async stopChild(child: PortableChildProcess): Promise<void> {
    if (childHasExited(child)) {
      return;
    }
    child.kill("SIGTERM");
    if (await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    child.kill("SIGKILL");
    if (!(await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS))) {
      throw new Error(
        `Could not stop the isolated Codex app-server process ${child.pid ?? "unknown"}`,
      );
    }
  }
}

class CatalogScopedCodexAppServerPool implements CodexAppServerPool {
  private readonly runtimes = new Map<string, CodexAppServerSupervisor>();
  private shuttingDown = false;

  constructor(private readonly options: CreateCodexAppServerPoolOptions) {}

  forSkillCatalog(catalogHash: string): CodexAppServerRuntime {
    if (this.shuttingDown) {
      throw new Error("Codex app-server pool is shutting down");
    }
    const key = catalogHash.trim();
    if (key.length === 0) {
      throw new Error("Codex app-server skill catalog hash is required");
    }
    const runtimeEnv = this.options.getEnv();
    const generationId = resolveCodexAppServerGeneration({
      env: runtimeEnv,
      lifecycleId: this.options.lifecycleId,
    });
    const runtimeKey = `${key}\0${generationId}`;
    const existing = this.runtimes.get(runtimeKey);
    if (existing !== undefined) {
      return existing;
    }
    const runtime = new CodexAppServerSupervisor({
      ...this.options,
      catalogHash: key,
      generationId,
      runtimeEnv,
    });
    this.runtimes.set(runtimeKey, runtime);
    return runtime;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.shutdown()),
    );
  }
}

export function createCodexAppServerSupervisor(
  options: CreateCodexAppServerPoolOptions & { catalogHash: string },
): CodexAppServerRuntime & { shutdown(): Promise<void> } {
  const runtimeEnv = options.getEnv();
  return new CodexAppServerSupervisor({
    ...options,
    generationId: resolveCodexAppServerGeneration({
      env: runtimeEnv,
      lifecycleId: options.lifecycleId,
    }),
    runtimeEnv,
  });
}

export function createCodexAppServerPool(
  options: CreateCodexAppServerPoolOptions,
): CodexAppServerPool {
  return new CatalogScopedCodexAppServerPool(options);
}
