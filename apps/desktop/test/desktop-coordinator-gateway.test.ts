import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  startDesktopCoordinatorGateway,
  type DesktopCoordinatorGateway,
} from "../src/desktop-coordinator-gateway.js";

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
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

const resources: Array<TestServer | DesktopCoordinatorGateway> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources.splice(0).map((resource) => resource.close()),
  );
});

describe("desktop coordinator gateway", () => {
  it("keeps renderer routes local and sends only API traffic to the coordinator", async () => {
    const app = await startTestServer((request, response) => {
      response.end(`app:${request.url ?? ""}`);
    });
    resources.push(app);
    const coordinator = await startTestServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "remote=must-not-leak; Path=/");
      response.end(
        JSON.stringify({
          cookie: request.headers.cookie ?? null,
          host: request.headers.host ?? null,
          origin: request.headers.origin ?? null,
          path: request.url,
        }),
      );
    });
    resources.push(coordinator);
    const gateway = await startDesktopCoordinatorGateway({
      appUrl: app.url,
      coordinatorUrl: coordinator.url,
      getCoordinatorCookieHeader: async () => "bb_connect=session",
    });
    resources.push(gateway);

    const settingsResponse = await fetch(`${gateway.url}/settings/server`);
    expect(await settingsResponse.text()).toBe("app:/settings/server");

    const apiResponse = await fetch(`${gateway.url}/api/v1/system/config`);
    expect(await apiResponse.json()).toEqual({
      cookie: "bb_connect=session",
      host: new URL(coordinator.url).host,
      origin: coordinator.url,
      path: "/api/v1/system/config",
    });
    expect(apiResponse.headers.get("set-cookie")).toBeNull();
  });
});
