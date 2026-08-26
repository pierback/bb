import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  spawnPortableProcess,
  type PortableChildProcess,
  type PortableSpawnRequest,
} from "@bb/process-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createCodexAppServerPool,
  createCodexAppServerSupervisor,
  probeCodexAppServer,
  resolveCodexAppServerGeneration,
  resolveCodexAppServerSocketPath,
  verifyProcessOwnsCodexSocket,
} from "./codex-app-server-supervisor.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
};

const TEST_SOCKET_IDENTITY: Readonly<{ dev: number; ino: number }> =
  Object.freeze({ dev: 1, ino: 1 });

describe("Codex app-server supervisor", () => {
  let dataDir: string;
  const children: PortableChildProcess[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "bb-codex-supervisor-"));
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    rmSync(dataDir, { force: true, recursive: true });
  });

  function spawnPersistentNode(
    request: PortableSpawnRequest,
  ): PortableChildProcess {
    const child = spawnPortableProcess({
      ...request,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
    });
    children.push(child);
    return child;
  }

  async function listenOnUnixSocket(
    server: Server,
    socketPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  }

  it("uses the standard Codex control socket when it fits", () => {
    expect(
      resolveCodexAppServerSocketPath({
        catalogHash: "catalog-a",
        env: { CODEX_HOME: "/Users/test/.codex" },
        generationId: "generation-a",
        homeDir: "/fallback",
      }),
    ).toMatch(
      /^\/Users\/test\/\.codex\/app-server-control\/v\d+\/[a-f0-9]{16}\.sock$/u,
    );
  });

  it("uses a stable short socket path when CODEX_HOME is too deep", () => {
    const socketPath = resolveCodexAppServerSocketPath({
      catalogHash: "catalog-a",
      env: { CODEX_HOME: `/${"deep/".repeat(30)}.codex` },
      generationId: "generation-a",
      shortSocketRoot: "/tmp",
      uid: 501,
    });

    expect(socketPath).toMatch(
      new RegExp(
        `^${realpathSync("/tmp").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\/bb-codex-501\/v\\d+\/[a-f0-9]{16}\\.sock$`,
        "u",
      ),
    );
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(100);
  });

  it("changes socket identity when the executable generation changes", () => {
    const base = {
      catalogHash: "catalog-a",
      env: { CODEX_HOME: "/Users/test/.codex" },
    };

    expect(
      resolveCodexAppServerSocketPath({
        ...base,
        generationId: "generation-a",
      }),
    ).not.toBe(
      resolveCodexAppServerSocketPath({
        ...base,
        generationId: "generation-b",
      }),
    );
  });

  it("refuses a symlinked short-socket control directory", async () => {
    const uid = process.getuid?.() ?? 0;
    const redirectPath = join(dataDir, "redirect");
    mkdirSync(redirectPath);
    symlinkSync(redirectPath, join(dataDir, `bb-codex-${uid}`));
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: `/${"deep/".repeat(30)}.codex` },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      shortSocketRoot: dataDir,
      uid,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /refusing insecure Codex control directory/iu,
    );
  });

  it("refuses a control path beneath a non-owner-writable ancestor", async () => {
    const uid = process.getuid?.() ?? 0;
    const unsafeRoot = join(dataDir, "unsafe-root");
    mkdirSync(unsafeRoot, { mode: 0o777 });
    chmodSync(unsafeRoot, 0o777);
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: `/${"deep/".repeat(30)}.codex` },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      shortSocketRoot: unsafeRoot,
      uid,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /refusing writable Codex control directory ancestor/iu,
    );
  });

  it("allocates a new runtime generation when the Codex executable changes", async () => {
    const binDir = join(dataDir, "bin");
    const codexPath = join(binDir, "codex");
    mkdirSync(binDir);
    writeFileSync(codexPath, "first");
    chmodSync(codexPath, 0o700);
    const pool = createCodexAppServerPool({
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: binDir }),
      lifecycleId: "daemon-a",
      logger,
    });

    const first = pool.forSkillCatalog("catalog-a");
    writeFileSync(codexPath, "second-generation");
    const second = pool.forSkillCatalog("catalog-a");

    expect(second.socketPath).not.toBe(first.socketPath);
    await pool.shutdown();
  });

  it("requires a successful Codex initialize exchange for health", async () => {
    const plainSocketPath = join(dataDir, "plain.sock");
    const plainServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await listenOnUnixSocket(plainServer, plainSocketPath);
    await expect(probeCodexAppServer(plainSocketPath)).resolves.toBe(false);
    await new Promise<void>((resolve) => plainServer.close(() => resolve()));

    const codexSocketPath = join(dataDir, "codex.sock");
    const codexServer = createServer();
    const webSocketServer = new WebSocketServer({ server: codexServer });
    webSocketServer.on("connection", (socket) => {
      socket.once("message", (data) => {
        const request = JSON.parse(data.toString());
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { userAgent: "codex-test" },
          }),
        );
      });
    });
    await listenOnUnixSocket(codexServer, codexSocketPath);
    await expect(probeCodexAppServer(codexSocketPath)).resolves.toBe(true);
    await expect(
      verifyProcessOwnsCodexSocket({
        pid: process.pid,
        socketPath: codexSocketPath,
      }),
    ).resolves.toBe(true);
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) =>
      webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => codexServer.close(() => resolve()));
  });

  it("refuses to attach to a reachable server it does not own", async () => {
    const spawnAppServer = vi.fn(spawnPersistentNode);
    const secureSocket = vi.fn(async () => TEST_SOCKET_IDENTITY);
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => true,
      secureSocket,
      spawnAppServer,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /unowned Codex app-server/u,
    );

    expect(spawnAppServer).not.toHaveBeenCalled();
    expect(secureSocket).not.toHaveBeenCalled();
    await supervisor.shutdown();
    expect(secureSocket).not.toHaveBeenCalled();
  });

  it("allows only one supervisor to start a runtime generation", async () => {
    let reachable = false;
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const options = {
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => (reachable ? TEST_SOCKET_IDENTITY : null),
      spawnAppServer,
      verifySocketOwner: async () => true,
    };
    const first = createCodexAppServerSupervisor(options);
    const second = createCodexAppServerSupervisor(options);

    const results = await Promise.allSettled([
      first.ensureRunning(),
      second.ensureRunning(),
    ]);

    expect(spawnAppServer).toHaveBeenCalledOnce();
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/unowned Codex app-server/u),
      }),
    });

    await Promise.allSettled([first.shutdown(), second.shutdown()]);
  });

  it("deduplicates concurrent startup and passes the shared socket to Codex", async () => {
    let reachable = false;
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => (reachable ? TEST_SOCKET_IDENTITY : null),
      spawnAppServer,
      verifySocketOwner: async () => true,
    });

    await Promise.all([supervisor.ensureRunning(), supervisor.ensureRunning()]);

    expect(spawnAppServer).toHaveBeenCalledOnce();
    expect(spawnAppServer).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["app-server", "--listen", `unix://${supervisor.socketPath}`],
        command: "codex",
        detached: false,
      }),
    );
    await supervisor.shutdown();
    expect(children.at(-1)?.signalCode).toBe("SIGTERM");
  });

  it("keeps socket identity and Codex state on the same initial CODEX_HOME", async () => {
    let reachable = false;
    const initialCodexHome = join(dataDir, "initial-codex-home");
    const canonicalCodexHome = join(
      realpathSync(dataDir),
      "initial-codex-home",
    );
    const runtimeEnv = {
      BB_THREAD_ID: "must-not-leak",
      CODEX_HOME: join(dataDir, "refreshed-codex-home"),
      PATH: "/test/bin",
    };
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: initialCodexHome },
      getEnv: () => runtimeEnv,
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => (reachable ? TEST_SOCKET_IDENTITY : null),
      spawnAppServer,
      verifySocketOwner: async () => true,
    });

    await supervisor.ensureRunning();

    expect(supervisor.socketPath).toBe(
      resolveCodexAppServerSocketPath({
        catalogHash: "catalog-a",
        env: { CODEX_HOME: initialCodexHome },
        generationId: resolveCodexAppServerGeneration({
          env: runtimeEnv,
          lifecycleId: "daemon-a",
        }),
      }),
    );
    expect(spawnAppServer).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: canonicalCodexHome,
          CODEX_SQLITE_HOME: expect.stringContaining("bb-app-server-state"),
          PATH: "/test/bin",
        }),
      }),
    );
    const spawnRequest = spawnAppServer.mock.calls[0]?.[0];
    expect(spawnRequest?.env?.BB_THREAD_ID).toBeUndefined();
    await supervisor.shutdown();
  });

  it("reports provider stderr when the shared server exits during startup", async () => {
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPortableProcess({
        ...request,
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("sqlite unavailable"); process.exit(7)',
        ],
      });
      children.push(child);
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => false,
      secureSocket: async () => null,
      spawnAppServer,
      startupTimeoutMs: 1_000,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /exit code 7[\s\S]*sqlite unavailable/u,
    );
  });

  it("handles an asynchronous spawn error without crashing the daemon", async () => {
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => false,
      secureSocket: async () => null,
      spawnAppServer: (request) =>
        spawnPortableProcess({
          ...request,
          command: join(dataDir, "missing-codex"),
        }),
      startupTimeoutMs: 1_000,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /could not start the isolated Codex app-server.*ENOENT/iu,
    );
  });

  it("removes an unverified socket created during failed startup", async () => {
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      writeFileSync(supervisor.socketPath, "socket-placeholder");
      return spawnPersistentNode(request);
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => false,
      secureSocket: async ({ socketPath }) =>
        existsSync(socketPath) ? TEST_SOCKET_IDENTITY : null,
      spawnAppServer,
      startupTimeoutMs: 20,
      verifySocketOwner: async () => false,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /timed out waiting for the isolated Codex app-server/iu,
    );
    expect(existsSync(supervisor.socketPath)).toBe(false);
  });

  it("refuses to remove a replacement socket during shutdown", async () => {
    let reachable = false;
    let socketIdentity = TEST_SOCKET_IDENTITY;
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => socketIdentity,
      spawnAppServer,
      verifySocketOwner: async () => true,
    });

    await supervisor.ensureRunning();
    socketIdentity = { dev: 1, ino: 2 };

    await expect(supervisor.shutdown()).rejects.toThrow(
      /refusing to remove a replaced Codex app-server socket/iu,
    );
    expect(children.at(-1)?.signalCode).toBe("SIGTERM");
  });

  it("recovers a startup lock left by a dead process", async () => {
    let reachable = false;
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      isProcessAlive: () => false,
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => (reachable ? TEST_SOCKET_IDENTITY : null),
      spawnAppServer,
      verifySocketOwner: async () => true,
    });
    const startupLockPath = `${supervisor.socketPath}.start.lock`;
    mkdirSync(dirname(startupLockPath), { mode: 0o700, recursive: true });
    writeFileSync(startupLockPath, JSON.stringify({ pid: 12345 }), {
      mode: 0o600,
    });

    await supervisor.ensureRunning();

    expect(spawnAppServer).toHaveBeenCalledOnce();
    expect(existsSync(startupLockPath)).toBe(false);
    await supervisor.shutdown();
  });

  it("refuses a published startup lock with incomplete metadata", async () => {
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
    });
    const startupLockPath = `${supervisor.socketPath}.start.lock`;
    mkdirSync(dirname(startupLockPath), { mode: 0o700, recursive: true });
    writeFileSync(startupLockPath, "", { mode: 0o600 });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /startup lock.*invalid metadata/iu,
    );
    expect(existsSync(startupLockPath)).toBe(true);
  });

  it("refuses a healthy socket not owned by the spawned process", async () => {
    let reachable = false;
    const spawnAppServer = vi.fn((request: PortableSpawnRequest) => {
      const child = spawnPersistentNode(request);
      reachable = true;
      return child;
    });
    const supervisor = createCodexAppServerSupervisor({
      catalogHash: "catalog-a",
      dataDir,
      env: { CODEX_HOME: join(dataDir, ".codex") },
      getEnv: () => ({ PATH: "/test/bin" }),
      lifecycleId: "daemon-a",
      logger,
      probeServer: async () => reachable,
      secureSocket: async () => (reachable ? TEST_SOCKET_IDENTITY : null),
      spawnAppServer,
      verifySocketOwner: async () => false,
    });

    await expect(supervisor.ensureRunning()).rejects.toThrow(
      /not owned by the spawned process/iu,
    );
    expect(children.at(-1)?.signalCode).toBe("SIGTERM");
  });
});
