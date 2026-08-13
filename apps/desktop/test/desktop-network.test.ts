import { describe, expect, it, vi } from "vitest";
import { resolveMachineNetworkAddresses } from "../src/desktop-network.js";

describe("resolveMachineNetworkAddresses", () => {
  it("falls back to the machine's mDNS name and returns unique IPv4 addresses first", async () => {
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "nas") {
        throw new Error("not found");
      }
      return [
        { address: "fe80::1", family: 6 as const },
        { address: "192.168.178.72", family: 4 as const },
        { address: "192.168.178.72", family: 4 as const },
      ];
    });

    await expect(
      resolveMachineNetworkAddresses({ hostname: "nas", lookup }),
    ).resolves.toEqual({
      addresses: ["192.168.178.72", "fe80::1"],
      resolvedHostname: "nas.local",
    });
    expect(lookup).toHaveBeenNthCalledWith(1, "nas", {
      all: true,
      verbatim: true,
    });
    expect(lookup).toHaveBeenNthCalledWith(2, "nas.local", {
      all: true,
      verbatim: true,
    });
  });
});
