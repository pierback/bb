import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runCodexAppServerBridge } from "./transport.js";

interface UnixWebSocketServer {
  server: Server;
  socketPath: string;
  webSocketServer: WebSocketServer;
}

const openServers: UnixWebSocketServer[] = [];
const openStalledServers: Array<{ server: Server; sockets: Set<Duplex> }> = [];
const temporaryDirectories: string[] = [];

async function createUnixWebSocketServer(args?: {
  directoryPrefix?: string;
  socketName?: string;
}): Promise<UnixWebSocketServer> {
  const directory = mkdtempSync(
    join(tmpdir(), args?.directoryPrefix ?? "bb-codex-bridge-"),
  );
  const socketPath = join(directory, args?.socketName ?? "app-server.sock");
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  const result = { server, socketPath, webSocketServer };
  openServers.push(result);
  temporaryDirectories.push(directory);
  return result;
}

afterEach(async () => {
  for (const openServer of openServers.splice(0)) {
    for (const client of openServer.webSocketServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) =>
      openServer.webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      openServer.server.close(() => resolve()),
    );
  }
  for (const openServer of openStalledServers.splice(0)) {
    for (const socket of openServer.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) =>
      openServer.server.close(() => resolve()),
    );
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Codex shared app-server bridge", () => {
  it("forwards JSON-RPC requests and responses over the shared socket", async () => {
    const { socketPath, webSocketServer } = await createUnixWebSocketServer();
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding("utf8");
    let outputText = "";
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });

    const receivedRequest = new Promise<string>((resolve) => {
      webSocketServer.once("connection", (socket) => {
        socket.once("message", (data) => {
          resolve(data.toString());
          socket.send('{"jsonrpc":"2.0","id":1,"result":{"ready":true}}');
        });
      });
    });

    const bridgeRun = runCodexAppServerBridge({
      input,
      output,
      socketPath,
    });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

    await expect(receivedRequest).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );
    await vi.waitFor(() => {
      expect(outputText).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"ready":true}}\n',
      );
    });

    input.end();
    await bridgeRun;
  });

  it("connects when the private socket path contains URL-significant characters", async () => {
    const { socketPath, webSocketServer } = await createUnixWebSocketServer({
      directoryPrefix: "bb codex#bridge-",
      socketName: "app:server.sock",
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const connected = new Promise<void>((resolve) => {
      webSocketServer.once("connection", () => resolve());
    });

    const bridgeRun = runCodexAppServerBridge({ input, output, socketPath });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

    await connected;
    input.end();
    await bridgeRun;
  });

  it("rejects an empty socket path before reading input", async () => {
    await expect(
      runCodexAppServerBridge({
        input: new PassThrough(),
        output: new PassThrough(),
        socketPath: " ",
      }),
    ).rejects.toThrow("Codex app-server socket path is required");
  });

  it("rejects oversized input buffered during the WebSocket handshake", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-codex-bridge-stalled-"));
    const socketPath = join(directory, "app-server.sock");
    const server = createServer();
    const sockets = new Set<Duplex>();
    server.on("upgrade", (_request, socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
    openStalledServers.push({ server, sockets });
    temporaryDirectories.push(directory);

    const input = new PassThrough();
    const bridgeRun = runCodexAppServerBridge({
      input,
      output: new PassThrough(),
      socketPath,
    });
    input.write(`${"x".repeat(1024 * 1024 + 1)}\n`);

    await expect(bridgeRun).rejects.toThrow(
      "Codex bridge buffered more than 1048576 bytes before connecting",
    );
  });
});
