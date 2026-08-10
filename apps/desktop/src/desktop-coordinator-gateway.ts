import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK_HOST = "127.0.0.1";
const REMOTE_API_PREFIX = "/api/";
const REMOTE_WEBSOCKET_PATH = "/ws";
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

export interface StartDesktopCoordinatorGatewayArgs {
  appUrl: string;
  coordinatorUrl: string;
  getCoordinatorCookieHeader(): Promise<string>;
  port?: number;
}

export interface DesktopCoordinatorGateway {
  url: string;
  close(): Promise<void>;
}

function parseHttpTarget(label: string, value: string): URL {
  const target = new URL(value);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return target;
}

function isOriginFormTarget(target: string | undefined): target is string {
  return (
    target !== undefined && target.startsWith("/") && !target.startsWith("//")
  );
}

function isRemoteRequest(target: string): boolean {
  const pathname = new URL(target, "http://desktop.invalid").pathname;
  return pathname === "/api" || pathname.startsWith(REMOTE_API_PREFIX);
}

function isRemoteUpgrade(target: string): boolean {
  return (
    new URL(target, "http://desktop.invalid").pathname === REMOTE_WEBSOCKET_PATH
  );
}

function writeRejectedSocket(socket: Duplex, status: 400 | 405): void {
  const message = status === 405 ? "Method Not Allowed" : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function createUpstreamHeaders(args: {
  cookieHeader: string;
  headers: IncomingHttpHeaders;
  remote: boolean;
  target: URL;
  websocket: boolean;
}): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(args.headers)) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  headers.host = args.target.host;
  if (args.websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = args.headers.upgrade ?? "websocket";
  }
  if (args.remote) {
    headers.origin = args.target.origin;
    if (args.cookieHeader.length > 0) {
      headers.cookie = args.cookieHeader;
    }
  }
  return headers;
}

function rewriteRemoteResponseHeaders(args: {
  gatewayOrigin: string;
  headers: IncomingHttpHeaders;
  remoteOrigin: string;
}): IncomingHttpHeaders {
  const headers = { ...args.headers };
  delete headers["set-cookie"];
  const location = headers.location;
  if (typeof location === "string" && location.startsWith(args.remoteOrigin)) {
    headers.location = `${args.gatewayOrigin}${location.slice(args.remoteOrigin.length)}`;
  }
  return headers;
}

async function proxyRequest(args: {
  appTarget: URL;
  coordinatorTarget: URL;
  gatewayOrigin: string;
  getCoordinatorCookieHeader(): Promise<string>;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  if (!isOriginFormTarget(args.request.url)) {
    args.response.writeHead(400).end();
    return;
  }

  const remote = isRemoteRequest(args.request.url);
  const target = remote ? args.coordinatorTarget : args.appTarget;
  const cookieHeader = remote ? await args.getCoordinatorCookieHeader() : "";
  const requestFn = target.protocol === "https:" ? https.request : http.request;
  const upstream = requestFn(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: args.request.method,
      path: args.request.url,
      headers: createUpstreamHeaders({
        cookieHeader,
        headers: args.request.headers,
        remote,
        target,
        websocket: false,
      }),
    },
    (upstreamResponse) => {
      const headers = remote
        ? rewriteRemoteResponseHeaders({
            gatewayOrigin: args.gatewayOrigin,
            headers: upstreamResponse.headers,
            remoteOrigin: args.coordinatorTarget.origin,
          })
        : upstreamResponse.headers;
      args.response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        headers,
      );
      upstreamResponse.pipe(args.response);
    },
  );
  upstream.on("error", () => {
    if (!args.response.headersSent) args.response.writeHead(502);
    args.response.end();
  });
  args.request.pipe(upstream);
}

async function proxyUpgrade(args: {
  appTarget: URL;
  clientSocket: Duplex;
  coordinatorTarget: URL;
  getCoordinatorCookieHeader(): Promise<string>;
  head: Buffer;
  request: IncomingMessage;
}): Promise<void> {
  if (!isOriginFormTarget(args.request.url)) {
    writeRejectedSocket(args.clientSocket, 400);
    return;
  }

  const remote = isRemoteUpgrade(args.request.url);
  const target = remote ? args.coordinatorTarget : args.appTarget;
  const cookieHeader = remote ? await args.getCoordinatorCookieHeader() : "";
  const requestFn = target.protocol === "https:" ? https.request : http.request;
  const upstreamRequest = requestFn({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: args.request.method,
    path: args.request.url,
    headers: createUpstreamHeaders({
      cookieHeader,
      headers: args.request.headers,
      remote,
      target,
      websocket: true,
    }),
  });
  upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
    const headerLines = response.rawHeaders
      .reduce<string[]>((lines, value, index) => {
        if (index % 2 === 0) {
          lines.push(`${value}: ${response.rawHeaders[index + 1] ?? ""}\r\n`);
        }
        return lines;
      }, [])
      .join("");
    args.clientSocket.write(`${statusLine}${headerLines}\r\n`);
    if (upstreamHead.length > 0) args.clientSocket.write(upstreamHead);
    if (args.head.length > 0) upstreamSocket.write(args.head);
    upstreamSocket.pipe(args.clientSocket).pipe(upstreamSocket);
  });
  upstreamRequest.on("response", () =>
    writeRejectedSocket(args.clientSocket, 400),
  );
  upstreamRequest.on("error", () => args.clientSocket.destroy());
  upstreamRequest.end();
}

export async function startDesktopCoordinatorGateway(
  args: StartDesktopCoordinatorGatewayArgs,
): Promise<DesktopCoordinatorGateway> {
  const appTarget = parseHttpTarget("Desktop app URL", args.appUrl);
  const coordinatorTarget = parseHttpTarget(
    "Coordination server URL",
    args.coordinatorUrl,
  );
  const sockets = new Set<Socket>();
  let gatewayOrigin = "";
  const server = http.createServer((request, response) => {
    void proxyRequest({
      appTarget,
      coordinatorTarget,
      gatewayOrigin,
      getCoordinatorCookieHeader: args.getCoordinatorCookieHeader,
      request,
      response,
    }).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on("connect", (_request, socket) => writeRejectedSocket(socket, 405));
  server.on("upgrade", (request, socket, head) => {
    void proxyUpgrade({
      appTarget,
      clientSocket: socket,
      coordinatorTarget,
      getCoordinatorCookieHeader: args.getCoordinatorCookieHeader,
      head,
      request,
    }).catch(() => socket.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(args.port ?? 0, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  gatewayOrigin = `http://${LOOPBACK_HOST}:${address.port}`;
  return {
    url: gatewayOrigin,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
