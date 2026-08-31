import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  smokePublicUpdateChannel,
  smokePublicUpdateRoute,
} from "./smoke-public-channel.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/stable`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function artifactResponse(response, length) {
  response.writeHead(200, {
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(length),
  });
  response.end();
}

test("recognizes the BB Mesh artifact matcher without requiring a real file", async () => {
  const fixture = await listen((request, response) => {
    if (request.url === "/stable/bb-mesh-route-probe.dmg") {
      response.writeHead(404, {
        "cache-control": "public, max-age=31536000, immutable",
      });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await smokePublicUpdateRoute(fixture.baseUrl);
  } finally {
    await fixture.close();
  }
});

test("rejects the stale retired-product matcher seen in production", async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(404).end();
  });

  try {
    await assert.rejects(
      smokePublicUpdateRoute(fixture.baseUrl),
      /immutable BB Mesh artifact route/u,
    );
  } finally {
    await fixture.close();
  }
});

test("verifies every checksummed public artifact by status, cache policy, and size", async () => {
  const releaseDirectory = await mkdtemp(
    join(tmpdir(), "bb-mesh-public-smoke-"),
  );
  const artifacts = {
    "bb-mesh-1.2.3-arm64.dmg": "signed-dmg",
    "bb-mesh-1.2.3-arm64.zip": "signed-zip",
    "bb-mesh-1.2.3-arm64.zip.blockmap": "blockmap",
  };
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    Object.entries(artifacts).map(([name, contents]) =>
      writeFile(join(releaseDirectory, name), contents),
    ),
  );
  await writeFile(
    join(releaseDirectory, "SHA256SUMS"),
    `${Object.keys(artifacts)
      .map((name) => `${"a".repeat(64)}  ${name}`)
      .join("\n")}\n`,
  );

  const fixture = await listen((request, response) => {
    if (request.url === "/stable/bb-mesh-route-probe.dmg") {
      response.writeHead(404, {
        "cache-control": "public, max-age=31536000, immutable",
      });
      response.end();
      return;
    }
    const name = request.url?.replace("/stable/", "") ?? "";
    const contents = artifacts[name];
    if (contents === undefined) {
      response.writeHead(404).end();
      return;
    }
    artifactResponse(response, Buffer.byteLength(contents));
  });

  try {
    await smokePublicUpdateChannel(fixture.baseUrl, releaseDirectory);
  } finally {
    await fixture.close();
  }
});
