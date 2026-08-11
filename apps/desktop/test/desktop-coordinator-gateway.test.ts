import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_COORDINATOR_GATEWAY_CAPABILITY_HEADER,
  startDesktopCoordinatorGateway,
  type DesktopCoordinatorGateway,
} from "../src/desktop-coordinator-gateway.js";

const TEST_CAPABILITY =
  "desktop-gateway-test-capability-4f68cf8bb8514ae89d7c7639fc533e44";

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  onUpgrade?: (request: IncomingMessage, socket: Socket) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  if (onUpgrade !== undefined) {
    server.on("upgrade", onUpgrade);
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function gatewayRequestHeaders(args: {
  gateway: DesktopCoordinatorGateway;
  origin?: string;
}): Record<string, string> {
  return {
    [DESKTOP_COORDINATOR_GATEWAY_CAPABILITY_HEADER]: TEST_CAPABILITY,
    ...(args.origin === undefined ? {} : { origin: args.origin }),
  };
}

async function requestUpgrade(args: {
  gateway: DesktopCoordinatorGateway;
  headers?: Record<string, string>;
}): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const request = http.request(`${args.gateway.url}/ws`, {
      headers: {
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        upgrade: "websocket",
        ...args.headers,
      },
    });
    request.once("response", (response) => {
      response.resume();
      resolvePromise(response.statusCode ?? 0);
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolvePromise(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

async function requestHttpStatus(args: {
  gateway: DesktopCoordinatorGateway;
  headers: Record<string, string>;
  path: string;
}): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const request = http.request(`${args.gateway.url}${args.path}`, {
      headers: args.headers,
    });
    request.once("response", (response) => {
      response.resume();
      resolvePromise(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

const resources: Array<TestServer | DesktopCoordinatorGateway> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources.splice(0).map((resource) => resource.close()),
  );
});

describe("desktop coordinator gateway", () => {
  it("keeps renderer routes local and sends only API traffic to the coordinator", async () => {
    const app = await startTestServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization ?? null,
          machineCredential: request.headers["x-bb-connect-machine"] ?? null,
          path: request.url,
        }),
      );
    });
    resources.push(app);
    const coordinator = await startTestServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "remote=must-not-leak; Path=/");
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization ?? null,
          cookie: request.headers.cookie ?? null,
          host: request.headers.host ?? null,
          machineCredential: request.headers["x-bb-connect-machine"] ?? null,
          origin: request.headers.origin ?? null,
          path: request.url,
        }),
      );
    });
    resources.push(coordinator);
    const gateway = await startDesktopCoordinatorGateway({
      appUrl: app.url,
      capability: TEST_CAPABILITY,
      coordinatorUrl: coordinator.url,
      hostKey: "desktop-host-key",
      machineCredential: "bbcm_desktop",
    });
    resources.push(gateway);

    const settingsResponse = await fetch(`${gateway.url}/settings/server`, {
      headers: {
        ...gatewayRequestHeaders({ gateway }),
        authorization: "Bearer renderer-must-not-reach-assets",
        "x-bb-connect-machine": "renderer-must-not-reach-assets",
      },
    });
    expect(await settingsResponse.json()).toEqual({
      authorization: null,
      machineCredential: null,
      path: "/settings/server",
    });

    const apiResponse = await fetch(`${gateway.url}/api/v1/system/config`, {
      headers: {
        ...gatewayRequestHeaders({
          gateway,
          origin: gateway.url,
        }),
        authorization: "Bearer renderer-must-not-override",
        cookie: "authelia_session=renderer-must-not-forward",
        "x-bb-connect-machine": "renderer-must-not-override",
      },
    });
    expect(await apiResponse.json()).toEqual({
      authorization: "Bearer desktop-host-key",
      cookie: null,
      host: new URL(coordinator.url).host,
      machineCredential: "bbcm_desktop",
      origin: coordinator.url,
      path: "/api/v1/system/config",
    });
    expect(apiResponse.headers.get("set-cookie")).toBeNull();
  });

  it("rejects HTTP requests with a missing capability or foreign browser context", async () => {
    let upstreamRequests = 0;
    const app = await startTestServer((_request, response) => {
      upstreamRequests += 1;
      response.end("app");
    });
    resources.push(app);
    const coordinator = await startTestServer((_request, response) => {
      upstreamRequests += 1;
      response.end("coordinator");
    });
    resources.push(coordinator);
    const gateway = await startDesktopCoordinatorGateway({
      appUrl: app.url,
      capability: TEST_CAPABILITY,
      coordinatorUrl: coordinator.url,
      hostKey: "desktop-host-key",
      machineCredential: "bbcm_desktop",
    });
    resources.push(gateway);

    const missingCapability = await fetch(
      `${gateway.url}/api/v1/system/config`,
      { headers: { origin: gateway.url } },
    );
    expect(missingCapability.status).toBe(403);

    const foreignOrigin = await fetch(`${gateway.url}/api/v1/system/config`, {
      headers: gatewayRequestHeaders({
        gateway,
        origin: "https://attacker.example",
      }),
    });
    expect(foreignOrigin.status).toBe(403);

    const foreignFetchSite = await fetch(`${gateway.url}/assets/app.js`, {
      headers: {
        ...gatewayRequestHeaders({ gateway }),
        "sec-fetch-site": "cross-site",
      },
    });
    expect(foreignFetchSite.status).toBe(403);

    const wrongHost = await requestHttpStatus({
      gateway,
      headers: {
        ...gatewayRequestHeaders({ gateway }),
        host: "attacker.example",
      },
      path: "/settings/server",
    });
    expect(wrongHost).toBe(421);
    expect(upstreamRequests).toBe(0);
  });

  it("rejects unauthorized WebSockets and forwards an authorized upgrade", async () => {
    let coordinatorUpgradeHeaders: IncomingMessage["headers"] | null = null;
    const app = await startTestServer((_request, response) => {
      response.writeHead(404).end();
    });
    resources.push(app);
    const coordinator = await startTestServer(
      (_request, response) => {
        response.writeHead(404).end();
      },
      (request, socket) => {
        coordinatorUpgradeHeaders = request.headers;
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      },
    );
    resources.push(coordinator);
    const gateway = await startDesktopCoordinatorGateway({
      appUrl: app.url,
      capability: TEST_CAPABILITY,
      coordinatorUrl: coordinator.url,
      hostKey: "desktop-host-key",
      machineCredential: "bbcm_desktop",
    });
    resources.push(gateway);

    expect(
      await requestUpgrade({
        gateway,
        headers: { origin: gateway.url },
      }),
    ).toBe(403);
    expect(
      await requestUpgrade({
        gateway,
        headers: gatewayRequestHeaders({
          gateway,
          origin: "https://attacker.example",
        }),
      }),
    ).toBe(403);
    expect(coordinatorUpgradeHeaders).toBeNull();

    expect(
      await requestUpgrade({
        gateway,
        headers: gatewayRequestHeaders({
          gateway,
          origin: gateway.url,
        }),
      }),
    ).toBe(101);
    expect(coordinatorUpgradeHeaders).toMatchObject({
      authorization: "Bearer desktop-host-key",
      host: new URL(coordinator.url).host,
      origin: coordinator.url,
      "x-bb-connect-machine": "bbcm_desktop",
    });
    expect(coordinatorUpgradeHeaders).not.toHaveProperty("cookie");
    expect(coordinatorUpgradeHeaders).not.toHaveProperty(
      DESKTOP_COORDINATOR_GATEWAY_CAPABILITY_HEADER,
    );
  });
});
