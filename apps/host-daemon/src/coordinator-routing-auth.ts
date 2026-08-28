import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";

const BB_CONNECT_MACHINE_HEADER_NAME = "x-bb-connect-machine";

export type CoordinatorRoutingAuthentication =
  | {
      credential: string;
      kind: "connect";
      machineId: string;
    }
  | { kind: "direct" }
  | { kind: "native" };

export type CoordinatorGatewayAuthentication = Exclude<
  CoordinatorRoutingAuthentication,
  { kind: "direct" }
>;

export function resolveCoordinatorRoutingAuthentication(args: {
  connectMachineId?: string;
  machineCredential?: string;
  nativeClientAuth?: boolean;
}): CoordinatorRoutingAuthentication {
  const hasCredential = args.machineCredential !== undefined;
  const hasMachineId = args.connectMachineId !== undefined;
  if (args.nativeClientAuth === true) {
    if (hasCredential || hasMachineId) {
      throw new Error(
        "Native coordinator routing cannot be combined with BB Connect credentials",
      );
    }
    return { kind: "native" };
  }
  if (hasCredential !== hasMachineId) {
    throw new Error(
      "BB Connect coordinator routing requires both the machine ID and credential",
    );
  }
  if (
    args.machineCredential !== undefined &&
    args.connectMachineId !== undefined
  ) {
    return {
      credential: args.machineCredential,
      kind: "connect",
      machineId: args.connectMachineId,
    };
  }
  return { kind: "direct" };
}

export function coordinatorRoutingHeaders(
  authentication: CoordinatorRoutingAuthentication,
): Record<string, string> {
  if (authentication.kind === "connect") {
    return {
      [BB_CONNECT_MACHINE_HEADER_NAME]: authentication.credential,
    };
  }
  if (authentication.kind === "native") {
    return {
      [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
    };
  }
  return {};
}

export function connectMachineCredential(
  authentication: CoordinatorRoutingAuthentication,
): string | undefined {
  return authentication.kind === "connect"
    ? authentication.credential
    : undefined;
}

export function connectMachineId(
  authentication: CoordinatorRoutingAuthentication,
): string | undefined {
  return authentication.kind === "connect"
    ? authentication.machineId
    : undefined;
}
