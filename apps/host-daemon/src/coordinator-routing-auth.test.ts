import { describe, expect, it } from "vitest";
import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";
import {
  coordinatorRoutingHeaders,
  resolveCoordinatorRoutingAuthentication,
} from "./coordinator-routing-auth.js";

describe("coordinator routing authentication", () => {
  it("resolves direct, native, and Connect modes without mixing them", () => {
    expect(resolveCoordinatorRoutingAuthentication({})).toEqual({
      kind: "direct",
    });
    const native = resolveCoordinatorRoutingAuthentication({
      nativeClientAuth: true,
    });
    expect(native).toEqual({ kind: "native" });
    expect(coordinatorRoutingHeaders(native)).toEqual({
      [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
    });

    const connect = resolveCoordinatorRoutingAuthentication({
      connectMachineId: "machine_1",
      machineCredential: "bbcm_secret",
    });
    expect(connect).toEqual({
      credential: "bbcm_secret",
      kind: "connect",
      machineId: "machine_1",
    });
    expect(coordinatorRoutingHeaders(connect)).toEqual({
      "x-bb-connect-machine": "bbcm_secret",
    });
  });

  it("rejects ambiguous or incomplete routing identity", () => {
    expect(() =>
      resolveCoordinatorRoutingAuthentication({
        machineCredential: "bbcm_secret",
      }),
    ).toThrow("requires both the machine ID and credential");
    expect(() =>
      resolveCoordinatorRoutingAuthentication({
        connectMachineId: "machine_1",
        machineCredential: "bbcm_secret",
        nativeClientAuth: true,
      }),
    ).toThrow("cannot be combined");
  });
});
