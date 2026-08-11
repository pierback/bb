#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const caddyfilePath = fileURLToPath(new URL("./Caddyfile", import.meta.url));
const caddyfile = await readFile(caddyfilePath, "utf8");

function tokensOnDirective(name) {
  const line = caddyfile
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${name} `));
  assert.ok(line, `Missing ${name} directive`);
  return line.split(/\s+/u).slice(2);
}

const internalPaths = tokensOnDirective("@bb_internal");
assert.deepEqual(internalPaths, ["/internal", "/internal/*"]);

const enrollmentKeyRejection = caddyfile.indexOf(
  "handle @bb_internal_enroll_key",
);
const daemonAdmission = caddyfile.indexOf("@bb_internal_daemon {");
const internalRejection = caddyfile.indexOf("handle @bb_internal {");
const nativeAdmission = caddyfile.indexOf("@bb_native_client {");
const nativeHandler = caddyfile.indexOf("handle @bb_native_client {");
const authenticatedRoutes = caddyfile.indexOf("handle {");
assert.ok(
  enrollmentKeyRejection >= 0,
  "Missing explicit enrollment-key rejection handler",
);
assert.ok(
  daemonAdmission > enrollmentKeyRejection,
  "Enrollment-key rejection must run before daemon admission",
);
assert.match(
  caddyfile.slice(daemonAdmission, internalRejection),
  /header\s+Authorization\s+"Bearer \*"[\s\S]*header\s+X-Bb-Connect-Machine\s+\*/u,
  "Daemon admission must require both bearer and paired-machine credentials",
);
assert.match(
  caddyfile.slice(daemonAdmission, internalRejection),
  /reverse_proxy\s+127\.0\.0\.1:38886/u,
  "Authenticated daemon requests must reach the coordinator",
);
assert.ok(
  internalRejection > daemonAdmission,
  "Missing explicit /internal rejection handler",
);
assert.ok(
  internalRejection < authenticatedRoutes,
  "/internal rejection must run before the authenticated SPA handler",
);
assert.match(
  caddyfile.slice(internalRejection, authenticatedRoutes),
  /respond\s+404/u,
  "/internal must return 404 instead of the SPA or coordinator response",
);
assert.ok(
  nativeAdmission > internalRejection,
  "Native-client admission must not precede the /internal rejection boundary",
);
assert.ok(
  nativeHandler > nativeAdmission && nativeHandler < authenticatedRoutes,
  "Native-client requests must be handled before browser authentication",
);
const nativeMatcher = caddyfile.slice(nativeAdmission, nativeHandler);
assert.match(
  nativeMatcher,
  /path\s+\/api\s+\/api\/\*\s+\/ws\s+\/ws\/\*\s+\/install\/version\s+\/install\/bb-app\.tgz\s+\/health/u,
  "Native-client admission must expose only API, WebSocket, health, and updater routes",
);
assert.match(
  nativeMatcher,
  /header\s+Authorization\s+"Bearer \*"[\s\S]*header\s+X-Bb-Connect-Machine\s+\*/u,
  "Native-client admission must require both daemon and paired-machine credentials",
);
assert.match(
  caddyfile.slice(nativeHandler, authenticatedRoutes),
  /reverse_proxy\s+127\.0\.0\.1:38886/u,
  "Native-client requests must reach the coordinator",
);

const dynamicPaths = tokensOnDirective("@bb_dynamic");
assert.deepEqual(dynamicPaths, [
  "/api",
  "/api/*",
  "/ws",
  "/ws/*",
  "/install.sh",
  "/install/*",
  "/health",
]);
assert.ok(
  !dynamicPaths.some((path) => path.startsWith("/internal")),
  "Private daemon routes must never be in the public upstream allowlist",
);

const coordinatorProxyDirectives = caddyfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("127.0.0.1:38886"));
assert.deepEqual(coordinatorProxyDirectives, [
  "reverse_proxy 127.0.0.1:38886",
  "reverse_proxy 127.0.0.1:38886",
  "reverse_proxy @bb_dynamic 127.0.0.1:38886",
]);

process.stdout.write("PWA gateway routing boundary is valid.\n");
