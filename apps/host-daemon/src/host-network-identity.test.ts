import { describe, expect, it } from "vitest";
import { resolveHostNetworkIdentity } from "./host-network-identity.js";

describe("resolveHostNetworkIdentity", () => {
  it("reports the canonical hostname with unique current non-loopback addresses", () => {
    expect(
      resolveHostNetworkIdentity({
        hostname: () => "pierback-nas.local",
        networkInterfaces: () => ({
          en0: [
            {
              address: "192.168.178.72",
              netmask: "255.255.255.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "192.168.178.72/24",
            },
            {
              address: "192.168.178.72",
              netmask: "255.255.255.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "192.168.178.72/24",
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              netmask: "255.0.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: true,
              cidr: "127.0.0.1/8",
            },
          ],
        }),
      }),
    ).toEqual({
      hostname: "pierback-nas.local",
      addresses: ["192.168.178.72"],
    });
  });
});
