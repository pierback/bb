import assert from "node:assert/strict";
import test from "node:test";
import { parseBbMeshReleaseManifest } from "./release-manifest.mjs";
import { verifyCoordinatorVersionResponse } from "./verify-coordinator-response.mjs";

const validManifest = {
  applicationId: "de.staufingers.bb-mesh.desktop",
  applicationName: "BB Mesh",
  desktopVersion: "1.2.3",
  hostDaemonProtocolVersion: 94,
  primaryZip: "bb-mesh-1.2.3-arm64.zip",
  schemaVersion: 1,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
};

test("accepts the strict BB Mesh release manifest", () => {
  assert.deepEqual(parseBbMeshReleaseManifest(validManifest), validManifest);
});

test("rejects unknown fields and unsafe artifacts", () => {
  assert.throws(
    () => parseBbMeshReleaseManifest({ ...validManifest, legacyFeed: true }),
    /strict schema/u,
  );
  assert.throws(
    () =>
      parseBbMeshReleaseManifest({
        ...validManifest,
        primaryZip: "../official-bb.zip",
      }),
    /primaryZip was unsafe/u,
  );
});

test("requires the NAS response to match both version and protocol", () => {
  assert.doesNotThrow(() =>
    verifyCoordinatorVersionResponse(
      { protocolVersion: 94, version: "1.2.3" },
      "1.2.3",
      94,
    ),
  );
  assert.throws(
    () =>
      verifyCoordinatorVersionResponse(
        { protocolVersion: 93, version: "1.2.3" },
        "1.2.3",
        94,
      ),
    /mismatch/u,
  );
});
