import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface DesktopRendererServer {
  url: string;
  close(): Promise<void>;
}

export interface StartDesktopRendererServerArgs {
  assetsPath: string;
  port?: number;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return (
    candidateRelativePath === "" ||
    (!candidateRelativePath.startsWith(`..${sep}`) &&
      candidateRelativePath !== ".." &&
      !candidateRelativePath.startsWith(sep))
  );
}

function writeEmptyResponse(
  response: ServerResponse,
  statusCode: number,
): void {
  response.writeHead(statusCode, {
    "content-length": "0",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

async function resolveAssetPath(
  assetsPath: string,
  request: IncomingMessage,
): Promise<{ cacheControl: string; filePath: string } | null> {
  if (request.url === undefined || !request.url.startsWith("/")) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(
      new URL(request.url, "http://desktop.invalid").pathname,
    );
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return null;
  }

  const requestedPath = resolve(assetsPath, `.${pathname}`);
  if (!isWithinRoot(assetsPath, requestedPath)) {
    return null;
  }

  try {
    const requestedStats = await stat(requestedPath);
    if (requestedStats.isFile()) {
      return {
        cacheControl:
          pathname === "/index.html" ? "no-store" : "public, max-age=3600",
        filePath: requestedPath,
      };
    }
  } catch {
    // Client-side routes intentionally fall through to the SPA entry point.
  }

  if (extname(pathname).length > 0) {
    return null;
  }
  return {
    cacheControl: "no-store",
    filePath: join(assetsPath, "index.html"),
  };
}

async function serveRendererRequest(args: {
  assetsPath: string;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  if (args.request.method !== "GET" && args.request.method !== "HEAD") {
    writeEmptyResponse(args.response, 405);
    return;
  }

  const asset = await resolveAssetPath(args.assetsPath, args.request);
  if (asset === null) {
    writeEmptyResponse(args.response, 404);
    return;
  }

  let assetStats;
  try {
    assetStats = await stat(asset.filePath);
    if (!assetStats.isFile()) {
      writeEmptyResponse(args.response, 404);
      return;
    }
  } catch {
    writeEmptyResponse(args.response, 404);
    return;
  }

  args.response.writeHead(200, {
    "cache-control": asset.cacheControl,
    "content-length": String(assetStats.size),
    "content-type":
      CONTENT_TYPES[extname(asset.filePath).toLowerCase()] ??
      "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  if (args.request.method === "HEAD") {
    args.response.end();
    return;
  }
  createReadStream(asset.filePath).pipe(args.response);
}

/**
 * Serve only the packaged renderer bundle. This is deliberately not a BB
 * coordinator: it owns no chats, database, host registry, or execution state.
 */
export async function startDesktopRendererServer(
  args: StartDesktopRendererServerArgs,
): Promise<DesktopRendererServer> {
  const assetsPath = resolve(args.assetsPath);
  const indexStats = await stat(join(assetsPath, "index.html"));
  if (!indexStats.isFile()) {
    throw new Error(`Missing desktop renderer entry point: ${assetsPath}`);
  }

  const server = http.createServer((request, response) => {
    void serveRendererRequest({ assetsPath, request, response }).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(args.port ?? 0, LOOPBACK_HOST, () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
        server.closeAllConnections();
      }),
  };
}
