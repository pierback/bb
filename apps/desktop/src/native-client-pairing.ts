import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";
import {
  createNativeClientPairingResponseSchema,
  nativeClientPairingPollResponseSchema,
  type CreateNativeClientPairingResponse,
} from "@bb/server-contract";

const MAX_ERROR_DETAIL_LENGTH = 240;

export type NativeClientPairingClientErrorCode =
  | "cancelled"
  | "expired"
  | "invalid_response"
  | "rejected";

export class NativeClientPairingClientError extends Error {
  constructor(
    readonly code: NativeClientPairingClientErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "NativeClientPairingClientError";
  }
}

export interface CreateNativeClientPairingArgs {
  deviceName: string;
  fetchImpl?: typeof fetch;
  serverUrl: string;
  signal?: AbortSignal;
}

export interface WaitForNativeClientPairingArgs {
  fetchImpl?: typeof fetch;
  isCurrent?(): boolean;
  pairing: CreateNativeClientPairingResponse;
  serverUrl: string;
  signal?: AbortSignal;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface NativeClientPairingEnrollment {
  expiresAt: number;
  hostId: string;
  joinCode: string;
}

function nativeClientHeaders(): HeadersInit {
  return {
    [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
    "content-type": "application/json",
  };
}

function pairingUrl(serverUrl: string, path: string): string {
  return new URL(`/api/v1/native-client-pairings${path}`, serverUrl).toString();
}

async function responseError(
  action: string,
  response: Response,
): Promise<NativeClientPairingClientError> {
  const detail = (await response.text()).replace(/\s+/gu, " ").trim();
  const suffix =
    detail.length === 0 ? "" : `: ${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}`;
  return new NativeClientPairingClientError(
    response.status === 410 ? "expired" : "rejected",
    `${action} failed (${response.status} ${response.statusText})${suffix}`,
    response.status,
  );
}

async function defaultWait(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new NativeClientPairingClientError(
      "cancelled",
      "Native pairing was cancelled",
    );
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: NativeClientPairingClientError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolvePromise();
      }
    };
    const onAbort = (): void => {
      finish(
        new NativeClientPairingClientError(
          "cancelled",
          "Native pairing was cancelled",
        ),
      );
    };
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (signal?.aborted) onAbort();
    });
  });
}

export async function createNativeClientPairing(
  args: CreateNativeClientPairingArgs,
): Promise<CreateNativeClientPairingResponse> {
  const response = await (args.fetchImpl ?? fetch)(
    pairingUrl(args.serverUrl, ""),
    {
      body: JSON.stringify({ deviceName: args.deviceName }),
      headers: nativeClientHeaders(),
      method: "POST",
      signal: args.signal,
    },
  );
  if (response.status !== 201) {
    throw await responseError("Creating the native pairing request", response);
  }
  const parsed = createNativeClientPairingResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new NativeClientPairingClientError(
      "invalid_response",
      "The coordination server returned an invalid native pairing request",
      response.status,
    );
  }
  return parsed.data;
}

export function buildNativeClientPairingApprovalUrl(args: {
  pairing: Pick<CreateNativeClientPairingResponse, "requestId" | "userCode">;
  serverUrl: string;
}): string {
  const url = new URL("/pair-device", args.serverUrl);
  url.searchParams.set("requestId", args.pairing.requestId);
  url.searchParams.set("code", args.pairing.userCode);
  return url.toString();
}

export async function waitForNativeClientPairing(
  args: WaitForNativeClientPairingArgs,
): Promise<NativeClientPairingEnrollment> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const wait = args.wait ?? defaultWait;
  while (true) {
    if (args.signal?.aborted || args.isCurrent?.() === false) {
      throw new NativeClientPairingClientError(
        "cancelled",
        "Native pairing was cancelled",
      );
    }
    const response = await fetchImpl(
      pairingUrl(args.serverUrl, `/${args.pairing.requestId}/poll`),
      {
        body: JSON.stringify({
          requestSecret: args.pairing.requestSecret,
        }),
        headers: nativeClientHeaders(),
        method: "POST",
        signal: args.signal,
      },
    );
    if (!response.ok) {
      throw await responseError("Polling the native pairing request", response);
    }
    const parsed = nativeClientPairingPollResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) {
      throw new NativeClientPairingClientError(
        "invalid_response",
        "The coordination server returned an invalid native pairing status",
        response.status,
      );
    }
    if (parsed.data.status === "approved") {
      return {
        expiresAt: parsed.data.expiresAt,
        hostId: parsed.data.hostId,
        joinCode: parsed.data.joinCode,
      };
    }
    const remainingMs = parsed.data.expiresAt - Date.now();
    if (remainingMs <= 0) {
      throw new NativeClientPairingClientError(
        "expired",
        "The native pairing request expired",
      );
    }
    await wait(Math.min(args.pairing.pollIntervalMs, remainingMs), args.signal);
  }
}
