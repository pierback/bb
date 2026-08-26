import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WebSocket, type RawData } from "ws";

const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 5_000;

export interface RunCodexAppServerBridgeArgs {
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  socketPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function assertPrivateCodexControlSocket(socketPath: string): Promise<void> {
  const directoryStats = await lstat(dirname(socketPath));
  const socketStats = await lstat(socketPath);
  const uid = process.getuid?.();
  if (
    directoryStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    (directoryStats.mode & 0o777) !== 0o700 ||
    (uid !== undefined && directoryStats.uid !== uid)
  ) {
    throw new Error(
      `Codex app-server control directory is not private: ${dirname(socketPath)}`,
    );
  }
  if (
    socketStats.isSymbolicLink() ||
    !socketStats.isSocket() ||
    (socketStats.mode & 0o777) !== 0o600 ||
    (uid !== undefined && socketStats.uid !== uid)
  ) {
    throw new Error(`Codex app-server control socket is not private: ${socketPath}`);
  }
}

function createCodexControlWebSocket(socketPath: string): WebSocket {
  return new WebSocket("ws://localhost/", {
    createConnection: () => createConnection(socketPath),
    handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    perMessageDeflate: false,
  });
}

/**
 * Proxies BB's newline-delimited JSON-RPC stream to one connection on the
 * host-owned Codex app-server. Each BB runtime process remains thread-scoped,
 * while the shared app-server is the sole owner of Codex's SQLite state.
 */
export async function runCodexAppServerBridge(
  args: RunCodexAppServerBridgeArgs,
): Promise<void> {
  const socketPath = args.socketPath.trim();
  if (socketPath.length === 0) {
    throw new Error("Codex app-server socket path is required");
  }
  await assertPrivateCodexControlSocket(socketPath);
  const pendingLines: string[] = [];
  let pendingInputBytes = 0;
  let requestedStop = args.signal?.aborted === true;
  let terminalError: Error | null = null;
  let websocket: WebSocket | null = null;
  let rejectConnection: ((error: Error) => void) | null = null;
  let handleOutputError: ((error: Error) => void) | null = null;

  const inputLines = createInterface({ input: args.input, terminal: false });

  const stop = (): void => {
    if (requestedStop) {
      return;
    }
    requestedStop = true;
    inputLines.close();
    websocket?.terminate();
  };

  const handleInputLine = (line: string): void => {
    if (requestedStop || line.trim().length === 0) {
      return;
    }
    if (websocket?.readyState === WebSocket.OPEN) {
      try {
        websocket.send(line, (error) => {
          if (error) {
            rejectConnection?.(
              new Error(
                `Could not forward a request to Codex: ${errorMessage(error)}`,
                { cause: error },
              ),
            );
          }
        });
      } catch (error) {
        rejectConnection?.(
          new Error(
            `Could not forward a request to Codex: ${errorMessage(error)}`,
            { cause: error },
          ),
        );
      }
      return;
    }

    pendingInputBytes += Buffer.byteLength(line, "utf8");
    if (pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
      terminalError = new Error(
        `Codex bridge buffered more than ${MAX_PENDING_INPUT_BYTES} bytes before connecting`,
      );
      rejectConnection?.(terminalError);
      stop();
      return;
    }
    pendingLines.push(line);
  };

  const handleInputClose = (): void => {
    requestedStop = true;
    websocket?.terminate();
  };

  inputLines.on("line", handleInputLine);
  inputLines.once("close", handleInputClose);
  args.signal?.addEventListener("abort", stop, { once: true });

  try {
    if (terminalError) {
      throw terminalError;
    }
    if (requestedStop) {
      return;
    }

    websocket = createCodexControlWebSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
        websocket?.terminate();
      };
      rejectConnection = rejectOnce;

      websocket?.once("open", () => {
        if (requestedStop) {
          websocket?.terminate();
          return;
        }
        for (const line of pendingLines.splice(0)) {
          handleInputLine(line);
        }
        pendingInputBytes = 0;
      });

      websocket?.on("message", (data, isBinary) => {
        if (isBinary) {
          rejectOnce(
            new Error("Codex app-server sent an unexpected binary message"),
          );
          return;
        }
        if (!args.output.write(`${rawDataText(data)}\n`)) {
          websocket?.pause();
          args.output.once("drain", () => websocket?.resume());
        }
      });

      websocket?.once("error", (error) => {
        if (terminalError) {
          rejectOnce(terminalError);
          return;
        }
        if (requestedStop) {
          resolveOnce();
          return;
        }
        rejectOnce(
          new Error(
            `Could not connect to the shared Codex app-server at ${socketPath}: ${errorMessage(error)}`,
            { cause: error },
          ),
        );
      });

      websocket?.once("close", (code, reason) => {
        if (terminalError) {
          rejectOnce(terminalError);
          return;
        }
        if (requestedStop) {
          resolveOnce();
          return;
        }
        rejectOnce(
          new Error(
            `Shared Codex app-server connection closed unexpectedly (${code}${
              reason.length > 0 ? `: ${reason.toString("utf8")}` : ""
            })`,
          ),
        );
      });

      handleOutputError = (error) => {
        rejectOnce(
          new Error(
            `Could not write Codex bridge output: ${errorMessage(error)}`,
            {
              cause: error,
            },
          ),
        );
      };
      args.output.once("error", handleOutputError);
    });
  } finally {
    args.signal?.removeEventListener("abort", stop);
    inputLines.off("line", handleInputLine);
    inputLines.off("close", handleInputClose);
    inputLines.close();
    if (handleOutputError) {
      args.output.off("error", handleOutputError);
    }
    rejectConnection = null;
    websocket?.terminate();
  }
}
