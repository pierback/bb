import type { Host, HostNetworkIdentity, ProjectSource } from "@bb/domain";

export interface ProjectExecutionLocation {
  label: string;
  title: string;
  connected: boolean;
  /** OS identity from the currently connected daemon, not the mutable label. */
  networkIdentity: HostNetworkIdentity | null;
  /** Filesystem root used by this project on the selected machine. */
  path: string;
}

interface ResolveProjectExecutionLocationArgs {
  hosts: readonly Host[];
  localDaemonHostId: string | null;
  preferredHostId: string | null;
  sources: readonly ProjectSource[];
}

function uniqueSourceHostIds(sources: readonly ProjectSource[]): string[] {
  const hostIds = new Set<string>();
  for (const source of sources) {
    hostIds.add(source.hostId);
  }
  return [...hostIds];
}

/**
 * Resolves the compact project-level machine summary shown in the sidebar.
 * The desktop's preferred execution host wins when that project exists there;
 * otherwise the project's persisted default source remains authoritative.
 */
export function resolveProjectExecutionLocation({
  hosts,
  localDaemonHostId,
  preferredHostId,
  sources,
}: ResolveProjectExecutionLocationArgs): ProjectExecutionLocation | null {
  const sourceHostIds = uniqueSourceHostIds(sources);
  if (sourceHostIds.length === 0) return null;

  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const defaultHostId =
    sources.find((source) => source.isDefault)?.hostId ?? sourceHostIds[0];
  const primaryHostId =
    preferredHostId !== null && sourceHostIds.includes(preferredHostId)
      ? preferredHostId
      : defaultHostId;
  const orderedHostIds = [
    primaryHostId,
    ...sourceHostIds.filter((hostId) => hostId !== primaryHostId),
  ];
  const resolvedHosts = orderedHostIds.flatMap((hostId) => {
    const host = hostsById.get(hostId);
    return host ? [host] : [];
  });
  const primaryHost = resolvedHosts[0];
  if (!primaryHost) return null;
  const primarySource = sources.find(
    (source) => source.hostId === primaryHost.id,
  );
  if (!primarySource) return null;

  const machineNames = resolvedHosts.map((host) =>
    host.id === localDaemonHostId ? "This Mac" : host.name,
  );
  const primaryName = machineNames[0];
  const additionalMachineCount = machineNames.length - 1;
  const label =
    additionalMachineCount > 0
      ? `${primaryName} +${additionalMachineCount}`
      : primaryName;
  const statusSuffix = primaryHost.status === "connected" ? "" : " (offline)";
  const title =
    machineNames.length === 1
      ? `Project runs on ${primaryName}${statusSuffix}`
      : `Project can run on ${machineNames.join(", ")}. New threads default to ${primaryName}${statusSuffix}.`;

  return {
    label,
    title,
    connected: primaryHost.status === "connected",
    networkIdentity: primaryHost.networkIdentity,
    path: primarySource.path,
  };
}
