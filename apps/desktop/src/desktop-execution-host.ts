import { createHash } from "node:crypto";
import { access, readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { BbDesktopExecutionHostState } from "@bb/desktop-contract";
import { z } from "zod";
import {
  type BbAppProcess,
  type BbAppProcessRuntime,
  startBbAppProcess,
} from "./bb-process.js";

const LOOPBACK_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60_000;
const STATUS_REQUEST_TIMEOUT_MS = 1_000;
const STATUS_RETRY_MS = 200;
export const DESKTOP_EXECUTION_DAEMON_PATH_ENV =
  "BB_DESKTOP_EXECUTION_DAEMON_PATH";

const persistedHostAuthSchema = z
  .object({ hostId: z.string().min(1), hostKey: z.string().min(1) })
  .passthrough();
const hostDaemonStatusSchema = z
  .object({
    connected: z.boolean(),
    hostId: z.string().min(1),
    serverUrl: z.string().min(1),
  })
  .passthrough();

export interface DesktopExecutionHostJoinCode {
  hostId: string;
  joinCode: string;
}

export interface StartDesktopExecutionHostArgs {
  bridgePath: string;
  connectMachineId: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  machineCredential: string | null;
  requestJoinCode(): Promise<DesktopExecutionHostJoinCode>;
  runtime: BbAppProcessRuntime;
  serverUrl: string;
  userDataPath: string;
  onUnexpectedExit?(message: string): void;
}

export interface DesktopExecutionHost {
  hostKey: string;
  state: BbDesktopExecutionHostState;
  stop(): Promise<void>;
}

export interface DesktopExecutionHostAuth {
  hostId: string;
  hostKey: string;
}

function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.hostname === "localhost") url.hostname = LOOPBACK_HOST;
  return url.href.replace(/\/$/u, "");
}

function executionHostDataDir(userDataPath: string, serverUrl: string): string {
  const originHash = createHash("sha256")
    .update(new URL(serverUrl).origin)
    .digest("hex")
    .slice(0, 16);
  return join(userDataPath, "execution-hosts", originHash);
}

async function readPersistedHostAuth(
  dataDir: string,
): Promise<DesktopExecutionHostAuth | null> {
  try {
    const payload: unknown = JSON.parse(
      await readFile(join(dataDir, "auth.json"), "utf8"),
    );
    const auth = persistedHostAuthSchema.parse(payload);
    return { hostId: auth.hostId, hostKey: auth.hostKey };
  } catch {
    return null;
  }
}

export async function readDesktopExecutionHostAuth(args: {
  serverUrl: string;
  userDataPath: string;
}): Promise<DesktopExecutionHostAuth | null> {
  return readPersistedHostAuth(
    executionHostDataDir(args.userDataPath, args.serverUrl),
  );
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolvePromise());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

export function resolveDesktopExecutionDaemonOverride(
  env: NodeJS.ProcessEnv,
): string | null {
  const path = env[DESKTOP_EXECUTION_DAEMON_PATH_ENV]?.trim();
  if (path === undefined || path.length === 0) {
    return null;
  }
  if (!isAbsolute(path)) {
    throw new Error(`${DESKTOP_EXECUTION_DAEMON_PATH_ENV} must be absolute`);
  }
  return path;
}

async function fetchConnectedStatus(args: {
  expectedHostId: string;
  port: number;
  process: BbAppProcess;
  serverUrl: string;
}): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const expectedServerUrl = normalizeServerUrl(args.serverUrl);
  while (Date.now() <= deadline) {
    if (
      args.process.childProcess.exitCode !== null ||
      args.process.childProcess.signalCode !== null
    ) {
      throw new Error(
        `The local execution helper exited before connecting. ${args.process.logs.text()}`.trim(),
      );
    }
    try {
      const response = await fetch(
        `http://${LOOPBACK_HOST}:${args.port}/status`,
        { signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS) },
      );
      if (response.ok) {
        const status = hostDaemonStatusSchema.parse(await response.json());
        if (
          status.connected &&
          status.hostId === args.expectedHostId &&
          normalizeServerUrl(status.serverUrl) === expectedServerUrl
        ) {
          return;
        }
      }
    } catch {}
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, STATUS_RETRY_MS);
    });
  }
  throw new Error(
    `Timed out waiting for this Mac to connect to ${expectedServerUrl}. ${args.process.logs.text()}`.trim(),
  );
}

export async function startDesktopExecutionHost(
  args: StartDesktopExecutionHostArgs,
): Promise<DesktopExecutionHost> {
  const dataDir = executionHostDataDir(args.userDataPath, args.serverUrl);
  await mkdir(dataDir, { recursive: true });
  const persistedAuth = await readPersistedHostAuth(dataDir);
  const persistedHostId = persistedAuth?.hostId ?? null;
  const joinCode =
    persistedHostId === null ? await args.requestJoinCode() : null;
  const hostId = persistedHostId ?? joinCode?.hostId;
  if (hostId === undefined) {
    throw new Error(
      "The coordination server did not assign this Mac a host ID",
    );
  }
  const port = await reserveLoopbackPort();
  const daemonOverride = resolveDesktopExecutionDaemonOverride(args.env);
  if (daemonOverride !== null) {
    await access(daemonOverride);
    await access(join(dirname(daemonOverride), "bb"));
  }
  const usesDirectDaemon = daemonOverride !== null;
  const cliArgs = usesDirectDaemon
    ? []
    : [
        "host-daemon",
        ...(joinCode === null ? [] : ["join"]),
        "--data-dir",
        dataDir,
        "--server-url",
        args.serverUrl,
        "--host-daemon-port",
        String(port),
        "--host-type",
        "persistent",
        "--host-id",
        hostId,
        ...(joinCode === null ? [] : ["--join-code", joinCode.joinCode]),
      ];
  const process = startBbAppProcess({
    args: cliArgs,
    bridgePath: daemonOverride ?? args.bridgePath,
    cwd: args.cwd,
    env: {
      ...args.env,
      BB_DESKTOP_MANAGED_EXECUTION_HOST: "1",
      ...(usesDirectDaemon
        ? {
            BB_BRIDGE_DIR: dirname(daemonOverride),
            BB_CLI_DIR: dirname(daemonOverride),
            BB_DATA_DIR: dataDir,
            BB_HOST_DAEMON_PORT: String(port),
            BB_HOST_ID: hostId,
            BB_HOST_TYPE: "persistent",
            BB_SERVER_URL: args.serverUrl,
            ...(joinCode === null
              ? {}
              : { BB_HOST_ENROLL_KEY: joinCode.joinCode }),
          }
        : {}),
      ...(args.machineCredential === null
        ? {}
        : { BB_CONNECT_MACHINE_CREDENTIAL: args.machineCredential }),
      ...(args.connectMachineId === null
        ? {}
        : { BB_CONNECT_MACHINE_ID: args.connectMachineId }),
    },
    logLineLimit: 200,
    runtime: args.runtime,
  });
  let stopping = false;
  void process.exit.then((exit) => {
    if (stopping) return;
    const result =
      exit.code === null
        ? `signal ${exit.signal ?? "unknown"}`
        : `exit code ${exit.code}`;
    args.onUnexpectedExit?.(
      `The local execution helper stopped with ${result}. ${process.logs.text()}`.trim(),
    );
  });

  try {
    await fetchConnectedStatus({
      expectedHostId: hostId,
      port,
      process,
      serverUrl: args.serverUrl,
    });
  } catch (error) {
    stopping = true;
    await process.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: 1_000,
      signal: "SIGTERM",
      timeoutMs: 6_000,
    });
    throw error;
  }

  const connectedAuth = await readPersistedHostAuth(dataDir);
  if (connectedAuth === null || connectedAuth.hostId !== hostId) {
    stopping = true;
    await process.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: 1_000,
      signal: "SIGTERM",
      timeoutMs: 6_000,
    });
    throw new Error(
      "The local execution helper connected without persisting its host credential",
    );
  }

  return {
    hostKey: connectedAuth.hostKey,
    state: {
      error: null,
      hostId,
      port,
      serverUrl: args.serverUrl,
      status: "connected",
    },
    async stop(): Promise<void> {
      stopping = true;
      await process.stop({
        killSignal: "SIGKILL",
        killTimeoutMs: 1_000,
        signal: "SIGTERM",
        timeoutMs: 6_000,
      });
    },
  };
}
