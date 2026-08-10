import { lookup as nodeLookup } from "node:dns/promises";

interface LookupAddress {
  address: string;
  family: number;
}

type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export interface MachineNetworkAddresses {
  addresses: string[];
  resolvedHostname: string | null;
}

interface ResolveMachineNetworkAddressesArgs {
  hostname: string;
  lookup?: Lookup;
}

function hostnameCandidates(hostname: string): string[] {
  const normalized = hostname.trim();
  if (normalized.length === 0) return [];
  if (normalized.includes(".")) return [normalized];
  return [normalized, `${normalized}.local`];
}

function uniqueSortedAddresses(addresses: readonly LookupAddress[]): string[] {
  return [...addresses]
    .sort((left, right) => left.family - right.family)
    .map(({ address }) => address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

/** Resolve the address visible from this desktop, including Bonjour/mDNS names. */
export async function resolveMachineNetworkAddresses({
  hostname,
  lookup = nodeLookup,
}: ResolveMachineNetworkAddressesArgs): Promise<MachineNetworkAddresses> {
  for (const candidate of hostnameCandidates(hostname)) {
    try {
      const addresses = uniqueSortedAddresses(
        await lookup(candidate, { all: true, verbatim: true }),
      );
      if (addresses.length > 0) {
        return { addresses, resolvedHostname: candidate };
      }
    } catch {
      // A bare local hostname commonly fails DNS and succeeds through mDNS.
    }
  }
  return { addresses: [], resolvedHostname: null };
}
