import os from "node:os";
import {
  hostNetworkIdentitySchema,
  type HostNetworkIdentity,
} from "@bb/domain";

type NetworkInterfaces = typeof os.networkInterfaces;

interface ResolveHostNetworkIdentityOptions {
  hostname?: () => string;
  networkInterfaces?: NetworkInterfaces;
}

/** Snapshot the OS identity advertised for one daemon connection attempt. */
export function resolveHostNetworkIdentity(
  options: ResolveHostNetworkIdentityOptions = {},
): HostNetworkIdentity {
  const hostname = (options.hostname ?? os.hostname)().trim();
  const interfaces = (options.networkInterfaces ?? os.networkInterfaces)();
  const addresses = new Set<string>();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.add(entry.address);
    }
  }

  return hostNetworkIdentitySchema.parse({
    hostname,
    addresses: [...addresses].sort((left, right) => left.localeCompare(right)),
  });
}
