import assert from "node:assert/strict";
import test from "node:test";
import { parsePierbackReleaseManifest } from "./release-manifest.mjs";
import { verifyCoordinatorVersionResponse } from "./verify-coordinator-response.mjs";

const validManifest = {
  applicationId: "de.staufingers.pierback.desktop",
  applicationName: "Pierback",
  desktopVersion: "1.2.3",
  hostDaemonProtocolVersion: 94,
  primaryZip: "pierback-1.2.3-arm64.zip",
  schemaVersion: 1,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
};

test("accepts the strict Pierback release manifest", () => {
  assert.deepEqual(parsePierbackReleaseManifest(validManifest), validManifest);
});

test("rejects unknown fields and unsafe artifacts", () => {
  assert.throws(
    () => parsePierbackReleaseManifest({ ...validManifest, legacyFeed: true }),
    /strict schema/u,
  );
  assert.throws(
    () =>
      parsePierbackReleaseManifest({
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
