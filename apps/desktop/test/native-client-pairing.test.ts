import { describe, expect, it, vi } from "vitest";
import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";
import {
  buildNativeClientPairingApprovalUrl,
  createNativeClientPairing,
  NativeClientPairingClientError,
  waitForNativeClientPairing,
} from "../src/native-client-pairing.js";

const SERVER_URL = "https://bb.example.test";
const PAIRING = {
  expiresAt: Date.now() + 60_000,
  pollIntervalMs: 2_000,
  requestId: "bbnp_request",
  requestSecret: "bbns_secret",
  userCode: "ABCD-2345",
};

describe("native client pairing", () => {
  it("creates a marked request and builds the owner approval guide URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(PAIRING, { status: 201 }));

    await expect(
      createNativeClientPairing({
        deviceName: "studio-mac",
        fetchImpl,
        serverUrl: SERVER_URL,
      }),
    ).resolves.toEqual(PAIRING);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bb.example.test/api/v1/native-client-pairings",
      expect.objectContaining({
        body: JSON.stringify({ deviceName: "studio-mac" }),
        headers: expect.objectContaining({
          [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
        }),
        method: "POST",
      }),
    );
    expect(
      buildNativeClientPairingApprovalUrl({
        pairing: PAIRING,
        serverUrl: SERVER_URL,
      }),
    ).toBe(
      "https://bb.example.test/pair-device?requestId=bbnp_request&code=ABCD-2345",
    );
  });

  it("polls until the coordinator returns the one-time host enrollment", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ expiresAt: PAIRING.expiresAt, status: "pending" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          expiresAt: PAIRING.expiresAt,
          hostId: "host_local",
          joinCode: "join_once",
          status: "approved",
        }),
      );
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForNativeClientPairing({
        fetchImpl,
        pairing: PAIRING,
        serverUrl: SERVER_URL,
        wait,
      }),
    ).resolves.toEqual({
      expiresAt: PAIRING.expiresAt,
      hostId: "host_local",
      joinCode: "join_once",
    });
    expect(wait).toHaveBeenCalledWith(PAIRING.pollIntervalMs, undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ requestSecret: PAIRING.requestSecret }),
        headers: expect.objectContaining({
          [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
        }),
      }),
    );
  });

  it("fails closed on an invalid coordinator response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "approved" }));

    await expect(
      waitForNativeClientPairing({
        fetchImpl,
        pairing: PAIRING,
        serverUrl: SERVER_URL,
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      name: NativeClientPairingClientError.name,
    });
  });
});
