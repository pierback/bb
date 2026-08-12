import {
  NATIVE_CLIENT_PAIRING_POLL_INTERVAL_MS,
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";
import { isLoopbackAddress } from "@bb/config/loopback";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  getGateAuthKind,
  getTrustedRemoteAddress,
  type TrustedRemoteAddressReader,
} from "../request-context.js";
import {
  NativeClientPairingError,
  type NativeClientPairingService,
} from "../services/hosts/native-client-pairing.js";

function assertNativeClientRequest(context: {
  req: { header(name: string): string | undefined };
}): void {
  if (
    context.req.header(BB_NATIVE_CLIENT_HEADER_NAME) !==
    BB_NATIVE_CLIENT_HEADER_VALUE
  ) {
    throw new ApiError(
      403,
      "native_pairing_client_required",
      "Native client pairing is available only to BB Desktop",
    );
  }
}

function assertOwnerApproval(
  context: TrustedRemoteAddressReader & {
    req: { header(name: string): string | undefined };
  },
): void {
  const gateAuthKind = getGateAuthKind(context);
  const trustedRemoteAddress = getTrustedRemoteAddress(context);
  const trustedLoopbackCli =
    gateAuthKind === null &&
    trustedRemoteAddress !== undefined &&
    isLoopbackAddress(trustedRemoteAddress);
  if (
    context.req.header(BB_NATIVE_CLIENT_HEADER_NAME) !==
      BB_NATIVE_CLIENT_HEADER_VALUE &&
    (gateAuthKind === "session" || trustedLoopbackCli)
  ) {
    return;
  }
  throw new ApiError(
    403,
    "native_pairing_approval_forbidden",
    "Native pairing must be approved by the owner",
  );
}

function rethrowPairingError(error: unknown): never {
  if (!(error instanceof NativeClientPairingError)) {
    throw error;
  }
  switch (error.code) {
    case "capacity_exceeded":
      throw new ApiError(
        429,
        "native_pairing_capacity_exceeded",
        "Too many native pairing requests are pending",
      );
    case "expired":
      throw new ApiError(
        410,
        "native_pairing_expired",
        "The native pairing request expired",
      );
    case "invalid_approval":
      throw new ApiError(
        404,
        "native_pairing_not_found",
        "Native pairing request not found",
      );
    case "invalid_request_secret":
      throw new ApiError(401, "unauthorized", "Unauthorized");
  }
}

export function registerNativeClientPairingRoutes(
  app: Hono,
  pairing: NativeClientPairingService,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.nativeClientPairings;

  post(routes.create, (context, payload) => {
    assertNativeClientRequest(context);
    try {
      return context.json(
        {
          ...pairing.create(payload.deviceName),
          pollIntervalMs: NATIVE_CLIENT_PAIRING_POLL_INTERVAL_MS,
        },
        201,
      );
    } catch (error) {
      return rethrowPairingError(error);
    }
  });

  get(routes.inspect, (context, query) => {
    assertOwnerApproval(context);
    try {
      return context.json(
        pairing.inspect({
          requestId: context.req.param("id"),
          userCode: query.code,
        }),
      );
    } catch (error) {
      return rethrowPairingError(error);
    }
  });

  post(routes.approve, async (context, payload) => {
    assertOwnerApproval(context);
    try {
      return context.json(
        await pairing.approve({
          requestId: context.req.param("id"),
          userCode: payload.code,
        }),
      );
    } catch (error) {
      return rethrowPairingError(error);
    }
  });

  post(routes.poll, (context, payload) => {
    assertNativeClientRequest(context);
    try {
      return context.json(
        pairing.poll({
          requestId: context.req.param("id"),
          requestSecret: payload.requestSecret,
        }),
      );
    } catch (error) {
      return rethrowPairingError(error);
    }
  });
}
