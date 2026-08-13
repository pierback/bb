import { describe, expect, it, vi } from "vitest";
import {
  NativeClientPairingError,
  NativeClientPairingService,
} from "../../src/services/hosts/native-client-pairing.js";

function createService(
  overrides: {
    issueEnrollment?: () => Promise<{
      expiresAt: number;
      hostId: string;
      joinCode: string;
    }>;
    maxPendingRequests?: number;
    maxPendingRequestsPerSource?: number;
    maxSecretFailures?: number;
    now?: () => number;
  } = {},
) {
  let requestSequence = 0;
  return new NativeClientPairingService({
    createRequestId: () => `request-${(requestSequence += 1)}`,
    createRequestSecret: () => `secret-${requestSequence}`,
    createUserCode: () => `CODE-${requestSequence}`,
    issueEnrollment:
      overrides.issueEnrollment ??
      (async () => ({
        expiresAt: 20_000,
        hostId: "host-native",
        joinCode: "bbde_native",
      })),
    maxPendingRequests: overrides.maxPendingRequests,
    maxPendingRequestsPerSource: overrides.maxPendingRequestsPerSource,
    maxSecretFailures: overrides.maxSecretFailures,
    now: overrides.now ?? (() => 1_000),
    requestTtlMs: 10_000,
  });
}

describe("NativeClientPairingService", () => {
  it("keeps bootstrap material behind both browser approval and the request secret", async () => {
    const service = createService();
    const request = service.create({
      deviceName: "Ferdinand's Mac",
      sourceKey: "203.0.113.10",
    });

    expect(service.inspect(request)).toEqual({
      deviceName: "Ferdinand's Mac",
      expiresAt: 11_000,
      requestId: "request-1",
      status: "pending",
      userCode: "CODE-1",
    });
    expect(
      service.poll({
        requestId: request.requestId,
        requestSecret: request.requestSecret,
      }),
    ).toEqual({ expiresAt: 11_000, status: "pending" });

    await service.approve(request);

    expect(
      service.poll({
        requestId: request.requestId,
        requestSecret: request.requestSecret,
      }),
    ).toEqual({
      expiresAt: 20_000,
      hostId: "host-native",
      joinCode: "bbde_native",
      status: "approved",
    });
  });

  it("issues one enrollment when browser approvals race or retry", async () => {
    let resolveEnrollment!: (value: {
      expiresAt: number;
      hostId: string;
      joinCode: string;
    }) => void;
    const issueEnrollment = vi.fn(
      () =>
        new Promise<{
          expiresAt: number;
          hostId: string;
          joinCode: string;
        }>((resolve) => {
          resolveEnrollment = resolve;
        }),
    );
    const service = createService({ issueEnrollment });
    const request = service.create({
      deviceName: "This Mac",
      sourceKey: "203.0.113.10",
    });

    const first = service.approve(request);
    const second = service.approve(request);
    resolveEnrollment({
      expiresAt: 20_000,
      hostId: "host-race",
      joinCode: "bbde_race",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "approved" }),
      expect.objectContaining({ status: "approved" }),
    ]);
    expect(issueEnrollment).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a wrong browser code and repeated secret guesses", () => {
    const service = createService({ maxSecretFailures: 2 });
    const request = service.create({
      deviceName: "This Mac",
      sourceKey: "203.0.113.10",
    });

    expect(() =>
      service.inspect({ requestId: request.requestId, userCode: "WRONG" }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientPairingError>>({
        code: "invalid_approval",
      }),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() =>
        service.poll({
          requestId: request.requestId,
          requestSecret: "wrong-secret",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<NativeClientPairingError>>({
          code: "invalid_request_secret",
        }),
      );
    }
    expect(() => service.inspect(request)).toThrowError(
      expect.objectContaining<Partial<NativeClientPairingError>>({
        code: "invalid_approval",
      }),
    );
  });

  it("expires requests and frees their bounded capacity", () => {
    let now = 1_000;
    const service = createService({ maxPendingRequests: 1, now: () => now });
    const request = service.create({
      deviceName: "First Mac",
      sourceKey: "203.0.113.10",
    });
    expect(() =>
      service.create({
        deviceName: "Second Mac",
        sourceKey: "203.0.113.11",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientPairingError>>({
        code: "capacity_exceeded",
      }),
    );

    now = 11_000;
    expect(() => service.inspect(request)).toThrowError(
      expect.objectContaining<Partial<NativeClientPairingError>>({
        code: "expired",
      }),
    );
    expect(
      service.create({
        deviceName: "Second Mac",
        sourceKey: "203.0.113.11",
      }),
    ).toMatchObject({
      requestId: "request-2",
    });
  });

  it("bounds unauthenticated pending allocations per trusted source", () => {
    const service = createService({
      maxPendingRequests: 3,
      maxPendingRequestsPerSource: 2,
    });
    service.create({ deviceName: "First Mac", sourceKey: "203.0.113.10" });
    service.create({ deviceName: "Second Mac", sourceKey: "203.0.113.10" });

    expect(() =>
      service.create({
        deviceName: "Third Mac",
        sourceKey: "203.0.113.10",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientPairingError>>({
        code: "source_capacity_exceeded",
      }),
    );
    expect(
      service.create({
        deviceName: "Other network Mac",
        sourceKey: "198.51.100.20",
      }),
    ).toMatchObject({ requestId: "request-3" });
  });
});
