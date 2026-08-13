import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startDesktopRendererServer,
  type DesktopRendererServer,
} from "../src/desktop-renderer-server.js";

const renderers: DesktopRendererServer[] = [];
const unrelatedServers: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(
    renderers.splice(0).map((renderer) => renderer.close()),
  );
  await Promise.allSettled(
    unrelatedServers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeAllConnections();
        }),
    ),
  );
});

async function createRendererFixture(): Promise<string> {
  const assetsPath = await mkdtemp(join(tmpdir(), "bb-desktop-renderer-"));
  await Promise.all([
    writeFile(join(assetsPath, "index.html"), "<main>bb renderer</main>"),
    writeFile(join(assetsPath, "app.js"), "globalThis.bbLoaded = true;"),
  ]);
  return assetsPath;
}

describe("desktop renderer server", () => {
  it("serves assets and SPA routes without starting a BB coordinator", async () => {
    const occupiedCoordinator = http.createServer((_request, response) => {
      response.end("unrelated coordinator port occupant");
    });
    unrelatedServers.push(occupiedCoordinator);
    await new Promise<void>((resolvePromise) => {
      occupiedCoordinator.listen(0, "127.0.0.1", resolvePromise);
    });
    const occupiedAddress = occupiedCoordinator.address() as AddressInfo;

    const renderer = await startDesktopRendererServer({
      assetsPath: await createRendererFixture(),
    });
    renderers.push(renderer);

    expect(new URL(renderer.url).port).not.toBe(String(occupiedAddress.port));
    expect(await (await fetch(`${renderer.url}/app.js`)).text()).toBe(
      "globalThis.bbLoaded = true;",
    );
    expect(await (await fetch(`${renderer.url}/settings/server`)).text()).toBe(
      "<main>bb renderer</main>",
    );
  });

  it("rejects writes, missing assets, and traversal attempts", async () => {
    const renderer = await startDesktopRendererServer({
      assetsPath: await createRendererFixture(),
    });
    renderers.push(renderer);

    expect(
      (await fetch(`${renderer.url}/app.js`, { method: "POST" })).status,
    ).toBe(405);
    expect((await fetch(`${renderer.url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${renderer.url}/%2e%2e%2foutside.txt`)).status).toBe(
      404,
    );
  });
});
