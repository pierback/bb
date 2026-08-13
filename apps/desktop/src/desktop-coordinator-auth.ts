import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";

export const BB_CONNECT_MACHINE_HEADER_NAME = "x-bb-connect-machine";

export type DesktopCoordinatorAuthentication =
  | {
      credential: string;
      kind: "connect";
      machineId: string;
    }
  | { kind: "native" };

export type DesktopCoordinatorHostKeyStatus = "accepted" | "rejected";

export interface ValidateDesktopCoordinatorHostKeyArgs {
  authentication: DesktopCoordinatorAuthentication;
  fetchImpl: typeof fetch;
  hostKey: string;
  serverUrl: string;
}

export function desktopCoordinatorRoutingHeaders(
  authentication: DesktopCoordinatorAuthentication,
): Record<string, string> {
  if (authentication.kind === "connect") {
    return {
      [BB_CONNECT_MACHINE_HEADER_NAME]: authentication.credential,
    };
  }
  return {
    [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
  };
}

export function desktopExecutionHostAuthenticationEnv(
  authentication: DesktopCoordinatorAuthentication,
): NodeJS.ProcessEnv {
  if (authentication.kind === "connect") {
    return {
      BB_CONNECT_MACHINE_CREDENTIAL: authentication.credential,
      BB_CONNECT_MACHINE_ID: authentication.machineId,
    };
  }
  return { BB_NATIVE_CLIENT_AUTH: "1" };
}

export async function validateDesktopCoordinatorHostKey(
  args: ValidateDesktopCoordinatorHostKeyArgs,
): Promise<DesktopCoordinatorHostKeyStatus> {
  const response = await args.fetchImpl(new URL("/health", args.serverUrl), {
    headers: {
      authorization: `Bearer ${args.hostKey}`,
      ...desktopCoordinatorRoutingHeaders(args.authentication),
    },
    method: "GET",
    redirect: "manual",
  });
  if (response.status === 401 || response.status === 403) {
    return "rejected";
  }
  if (response.status !== 200) {
    throw new Error(
      `Could not validate this Mac with the coordination server (${response.status} ${response.statusText})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "The coordination server returned an invalid host-key validation response",
    );
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("ok" in payload) ||
    payload.ok !== true
  ) {
    throw new Error(
      "The coordination server returned an invalid host-key validation response",
    );
  }
  return "accepted";
}
