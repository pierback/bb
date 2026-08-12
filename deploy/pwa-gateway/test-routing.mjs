#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const caddyfilePath = fileURLToPath(new URL("./Caddyfile", import.meta.url));
const caddyfile = await readFile(caddyfilePath, "utf8");

function index(label) {
  const offset = caddyfile.indexOf(label);
  assert.notEqual(offset, -1, `Missing ${label}`);
  return offset;
}

function slice(start, end) {
  return caddyfile.slice(index(start), index(end));
}

function assertNativeAdmission(block, label, { bearer = true } = {}) {
  assert.match(
    block,
    /header\s+X-Bb-Native-Client\s+host-key-v1/u,
    `${label} must require the exact native-client marker`,
  );
  if (bearer) {
    assert.match(
      block,
      /header\s+Authorization\s+"Bearer \*"/u,
      `${label} must require a bearer credential`,
    );
  } else {
    assert.doesNotMatch(
      block,
      /header\s+Authorization/u,
      `${label} must work before a host bearer key exists`,
    );
  }
  assert.doesNotMatch(
    block,
    /header\s+X-Bb-Connect-Machine/u,
    `${label} must not admit the retired BB Connect credential`,
  );
}

function assertNativeProxy(block, label) {
  assert.match(
    block,
    /reverse_proxy\s+127\.0\.0\.1:38886/u,
    `${label} must reach the NAS coordinator`,
  );
  for (const header of [
    "Cookie",
    "Proxy-Authorization",
    "X-Bb-Connect-Machine",
    "X-Bb-Gate-Auth",
    "X-Bb-Gate-Machine-Id",
    "Remote-Email",
    "Remote-Groups",
    "Remote-Name",
    "Remote-User",
  ]) {
    assert.match(
      block,
      new RegExp(`header_up\\s+-${header}`, "u"),
      `${label} must strip spoofable ${header}`,
    );
  }
}

const enrollmentKeyRejection = index("handle @bb_internal_enroll_key");
const pairingAdmission = index("@bb_native_pairing_bootstrap {");
const enrollmentAdmission = index("@bb_native_enroll {");
const internalAdmission = index("@bb_internal_native {");
const internalRejection = index("handle @bb_internal {");
const nativeAdmission = index("@bb_native_client {");
const browserHandler = index("\thandle {");

assert.ok(
  enrollmentKeyRejection < pairingAdmission &&
    pairingAdmission < enrollmentAdmission &&
    enrollmentAdmission < internalAdmission &&
    internalAdmission < internalRejection &&
    internalRejection < nativeAdmission &&
    nativeAdmission < browserHandler,
  "Gateway handlers must preserve enrollment, internal, native, then browser boundaries",
);

const pairingMatcher = slice(
  "@bb_native_pairing_bootstrap {",
  "handle @bb_native_pairing_bootstrap {",
);
assert.match(pairingMatcher, /method\s+POST/u);
assert.match(
  pairingMatcher,
  /path\s+\/api\/v1\/native-client-pairings\s+\/api\/v1\/native-client-pairings\/\*\/poll/u,
  "Unauthenticated native bootstrap must expose only pairing creation and polling",
);
assertNativeAdmission(pairingMatcher, "Native pairing bootstrap", {
  bearer: false,
});
assertNativeProxy(
  slice("handle @bb_native_pairing_bootstrap {", "@bb_native_enroll {"),
  "Native pairing bootstrap",
);
assert.match(
  slice("handle @bb_native_pairing_bootstrap {", "@bb_native_enroll {"),
  /header_up\s+-Authorization/u,
  "Native pairing bootstrap must discard caller-supplied authorization",
);

const enrollmentMatcher = slice(
  "@bb_native_enroll {",
  "handle @bb_native_enroll {",
);
assert.match(enrollmentMatcher, /method\s+POST/u);
assert.match(enrollmentMatcher, /path\s+\/internal\/hosts\/enroll/u);
assertNativeAdmission(enrollmentMatcher, "Native enrollment");
assertNativeProxy(
  slice("handle @bb_native_enroll {", "@bb_internal_native {"),
  "Native enrollment",
);

const internalMatcher = slice(
  "@bb_internal_native {",
  "handle @bb_internal_native {",
);
assert.match(internalMatcher, /path\s+\/internal\s+\/internal\/\*/u);
assertNativeAdmission(internalMatcher, "Native internal transport");
assertNativeProxy(
  slice("handle @bb_internal_native {", "@bb_internal path"),
  "Native internal transport",
);

const internalRejectionBlock = slice(
  "handle @bb_internal {",
  "@bb_native_client {",
);
assert.match(internalRejectionBlock, /respond\s+404/u);

const nativeMatcher = slice(
  "@bb_native_client {",
  "handle @bb_native_client {",
);
assert.match(
  nativeMatcher,
  /path\s+\/api\s+\/api\/\*\s+\/ws\s+\/ws\/\*\s+\/install\/version\s+\/install\/bb-app\.tgz\s+\/health/u,
);
assertNativeAdmission(nativeMatcher, "Enrolled native client");
assertNativeProxy(
  slice("handle @bb_native_client {", "@bb_dynamic path"),
  "Enrolled native client",
);

const browserBlock = caddyfile.slice(browserHandler);
assert.match(browserBlock, /forward_auth\s+127\.0\.0\.1:9091/u);
assert.match(
  browserBlock,
  /header_up\s+-X-Bb-Native-Client/u,
  "Browser requests must not spoof native admission",
);
assert.match(
  browserBlock,
  /header_up\s+-X-Bb-Connect-Machine/u,
  "Browser requests must not send the retired BB Connect credential",
);
for (const header of [
  "Authorization",
  "Cookie",
  "Proxy-Authorization",
  "Remote-Email",
  "Remote-Groups",
  "Remote-Name",
  "Remote-User",
]) {
  assert.match(
    browserBlock,
    new RegExp(`header_up\\s+-${header}`, "u"),
    `Browser requests must strip spoofable ${header}`,
  );
}
assert.match(
  browserBlock,
  /header_up\s+X-Bb-Gate-Auth\s+session/u,
  "Authelia-approved browser requests must receive trusted session evidence",
);

const dynamicLine = caddyfile
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.startsWith("@bb_dynamic path "));
assert.equal(
  dynamicLine,
  "@bb_dynamic path /api /api/* /ws /ws/* /install.sh /install/* /health",
);
assert.doesNotMatch(dynamicLine, /\/internal/u);

const coordinatorProxies = caddyfile.match(
  /reverse_proxy(?:\s+@bb_dynamic)?\s+127\.0\.0\.1:38886/gu,
);
assert.equal(
  coordinatorProxies?.length,
  5,
  "Exactly four native boundaries and one browser boundary may proxy to the coordinator",
);

process.stdout.write("PWA gateway routing boundary is valid.\n");
