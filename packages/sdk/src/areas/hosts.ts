import { hostProviderCliInstallEventSchema } from "@bb/server-contract";
import type { Host } from "@bb/domain";
import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract/native-client";
import type {
  ApproveNativeClientPairingRequest,
  CreateNativeClientPairingRequest,
  CreateNativeClientPairingResponse,
  CreateHostJoinCodeResponse,
  CreateMachineRequest,
  HostEnrollmentCommandResponse,
  HostCloneDefaultPathQuery,
  HostCloneDefaultPathResponse,
  HostDirectoryListing,
  HostDirectoryQuery,
  HostActionResponse,
  HostPathsExistRequest,
  HostPathsExistResponse,
  HostPickFolderRequest,
  HostPickFolderResponse,
  HostProviderCliInstallEvent,
  HostProviderCliInstallRequest,
  HostProviderCliStatusResponse,
  HostRetryUpdateResponse,
  NativeClientPairingApprovalQuery,
  NativeClientPairingApprovalResponse,
  NativeClientPairingPollResponse,
  PollNativeClientPairingRequest,
  UpdateHostRequest,
  SystemMachineProvider,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface HostGetArgs {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostDeleteArgs {
  hostId: string;
}

export interface HostUpdateArgs extends UpdateHostRequest {
  hostId: string;
}

export interface HostRetryUpdateArgs {
  hostId: string;
}

export interface HostActionArgs {
  hostId: string;
}

export interface HostDirectoryArgs extends HostDirectoryQuery {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostCloneDefaultPathArgs extends HostCloneDefaultPathQuery {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostPathsExistArgs extends HostPathsExistRequest {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostPickFolderArgs extends HostPickFolderRequest {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostProviderCliInstallArgs extends HostProviderCliInstallRequest {
  hostId: string;
}

export interface HostListArgs {
  includeCreating?: boolean;
  signal?: AbortSignal;
}

export interface MachineCreateArgs extends CreateMachineRequest {
  wait?: boolean;
  signal?: AbortSignal;
}

export interface MachineProviderListArgs {
  signal?: AbortSignal;
}

export interface NativeClientPairingCreateArgs extends CreateNativeClientPairingRequest {
  signal?: AbortSignal;
}

export interface NativeClientPairingTargetArgs {
  requestId: string;
  signal?: AbortSignal;
}

export interface NativeClientPairingInspectArgs
  extends NativeClientPairingTargetArgs, NativeClientPairingApprovalQuery {}

export interface NativeClientPairingApproveArgs
  extends NativeClientPairingTargetArgs, ApproveNativeClientPairingRequest {}

export interface NativeClientPairingPollArgs
  extends NativeClientPairingTargetArgs, PollNativeClientPairingRequest {}

function nativePairingRequestArgs(signal: AbortSignal | undefined) {
  return [
    {
      init: {
        headers: {
          [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
          "content-type": "application/json",
        },
        ...(signal === undefined ? {} : { signal }),
      },
    },
  ] as const;
}

export type HostCreateJoinCodeResult = CreateHostJoinCodeResponse;
export type HostDeleteResult = { ok: true };
export type HostDirectoryResult = HostDirectoryListing;
export type HostGetResult = Host & { connectMachineId: string | null };
export type HostEnrollmentCommandResult = HostEnrollmentCommandResponse;
export type HostCloneDefaultPathResult = HostCloneDefaultPathResponse;
export type HostProviderCliInstallResult = HostProviderCliInstallEvent[];
export type HostListResult = Host[];
export type HostPathsExistResult = HostPathsExistResponse;
export type HostPickFolderResult = HostPickFolderResponse;
export type HostProviderCliStatusResult = HostProviderCliStatusResponse;
export type HostRetryUpdateResult = HostRetryUpdateResponse;
export type HostActionResult = HostActionResponse;
export type HostUpdateResult = Host;
export type MachineProviderListResult = SystemMachineProvider[];
export type NativeClientPairingCreateResult = CreateNativeClientPairingResponse;
export type NativeClientPairingInspectResult =
  NativeClientPairingApprovalResponse;
export type NativeClientPairingApproveResult =
  NativeClientPairingApprovalResponse;
export type NativeClientPairingPollResult = NativeClientPairingPollResponse;

export interface HostsArea {
  experimental_create(args: MachineCreateArgs): Promise<Host>;
  experimental_getEnrollmentCommand(
    args: HostGetArgs,
  ): Promise<HostEnrollmentCommandResult>;
  createJoinCode(): Promise<HostCreateJoinCodeResult>;
  delete(args: HostDeleteArgs): Promise<HostDeleteResult>;
  directory(args: HostDirectoryArgs): Promise<HostDirectoryResult>;
  get(args: HostGetArgs): Promise<HostGetResult>;
  cloneDefaultPath(
    args: HostCloneDefaultPathArgs,
  ): Promise<HostCloneDefaultPathResult>;
  installProviderCli(
    args: HostProviderCliInstallArgs,
  ): Promise<HostProviderCliInstallResult>;
  list(args?: HostListArgs): Promise<HostListResult>;
  experimental_listProviders(
    args?: MachineProviderListArgs,
  ): Promise<MachineProviderListResult>;
  createNativeClientPairing(
    args: NativeClientPairingCreateArgs,
  ): Promise<NativeClientPairingCreateResult>;
  inspectNativeClientPairing(
    args: NativeClientPairingInspectArgs,
  ): Promise<NativeClientPairingInspectResult>;
  approveNativeClientPairing(
    args: NativeClientPairingApproveArgs,
  ): Promise<NativeClientPairingApproveResult>;
  pollNativeClientPairing(
    args: NativeClientPairingPollArgs,
  ): Promise<NativeClientPairingPollResult>;
  pathsExist(args: HostPathsExistArgs): Promise<HostPathsExistResult>;
  pickFolder(args: HostPickFolderArgs): Promise<HostPickFolderResult>;
  providerCliStatus(args: HostGetArgs): Promise<HostProviderCliStatusResult>;
  experimental_resume(args: HostActionArgs): Promise<Host>;
  experimental_retryCleanup(args: HostActionArgs): Promise<HostActionResult>;
  retryUpdate(args: HostRetryUpdateArgs): Promise<HostRetryUpdateResult>;
  experimental_suspend(args: HostActionArgs): Promise<Host>;
  update(args: HostUpdateArgs): Promise<HostUpdateResult>;
}

export function createHostsArea(args: CreateSdkAreaArgs): HostsArea {
  const { transport } = args;
  const nativePairings = () => transport.api.v1["native-client-pairings"];
  return {
    async experimental_create(input) {
      let host = await transport.readJson(
        transport.api.v1.hosts.$post(
          {
            json: {
              machineProviderId: input.machineProviderId,
              inputs: input.inputs,
              ...(input.key === undefined ? {} : { key: input.key }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
      if (input.wait === false) return host;
      for (;;) {
        input.signal?.throwIfAborted();
        if (host.lifecycle.phase === "active") return host;
        if (
          host.lifecycle.phase === "removing" ||
          host.lifecycle.phase === "destroyed"
        )
          throw new Error(
            host.lifecycle.message ?? "Machine creation cancelled",
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        host = await this.get({ hostId: host.id, signal: input.signal });
      }
    },
    async experimental_getEnrollmentCommand(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["enrollment-command"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async createJoinCode() {
      return transport.readJson(
        transport.api.v1.hosts["join-codes"].$post({
          json: {},
        }),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.hosts[":id"].$delete({
          param: { id: input.hostId },
        }),
      );
      return { ok: true };
    },
    async directory(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].directory.$get(
          {
            param: { id: input.hostId },
            query: { path: input.path },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async cloneDefaultPath(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["clone-default-path"].$get(
          {
            param: { id: input.hostId },
            query: { projectId: input.projectId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installProviderCli(input) {
      const response = await transport.resolve(
        transport.api.v1.hosts[":id"]["provider-clis"].install.$post({
          param: { id: input.hostId },
          json: {
            provider: input.provider,
            actionKind: input.actionKind,
          },
        }),
      );
      const text: string = await response.text();
      return text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) =>
          hostProviderCliInstallEventSchema.parse(JSON.parse(line)),
        );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.hosts.$get(
          {
            query: {
              ...(input?.includeCreating === undefined
                ? {}
                : {
                    includeCreating: input.includeCreating ? "true" : "false",
                  }),
            },
          },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async experimental_listProviders(input) {
      const response = await transport.readJson(
        transport.api.v1.system["machine-providers"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
      return response.providers;
    },
    async createNativeClientPairing(input) {
      return transport.readJson(
        nativePairings().$post(
          { json: { deviceName: input.deviceName } },
          ...nativePairingRequestArgs(input.signal),
        ),
      );
    },
    async inspectNativeClientPairing(input) {
      return transport.readJson(
        nativePairings()[":id"].$get(
          {
            param: { id: input.requestId },
            query: { code: input.code },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async approveNativeClientPairing(input) {
      return transport.readJson(
        nativePairings()[":id"].approve.$post(
          {
            param: { id: input.requestId },
            json: { code: input.code },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async pollNativeClientPairing(input) {
      return transport.readJson(
        nativePairings()[":id"].poll.$post(
          {
            param: { id: input.requestId },
            json: { requestSecret: input.requestSecret },
          },
          ...nativePairingRequestArgs(input.signal),
        ),
      );
    },
    async pathsExist(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].paths.exist.$post(
          {
            param: { id: input.hostId },
            json: { paths: input.paths },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async pickFolder(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["pick-folder"].$post(
          {
            param: { id: input.hostId },
            json: { clientHostId: input.clientHostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async providerCliStatus(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["provider-clis"].status.$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_resume(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].resume.$post({
          param: { id: input.hostId },
        }),
      );
    },
    async experimental_retryCleanup(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["retry-cleanup"].$post({
          param: { id: input.hostId },
        }),
      );
    },
    async retryUpdate(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["retry-update"].$post({
          param: { id: input.hostId },
        }),
      );
    },
    async experimental_suspend(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].suspend.$post({
          param: { id: input.hostId },
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$patch({
          param: { id: input.hostId },
          json: { name: input.name },
        }),
      );
    },
  };
}
