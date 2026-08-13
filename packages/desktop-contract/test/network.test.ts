import { describe, expect, it } from "vitest";
import {
  bbDesktopMachineAddressRequestSchema,
  bbDesktopMachineAddressResponseSchema,
} from "../src/network.js";

describe("desktop machine address contract", () => {
  it("accepts a machine hostname and a resolved address list", () => {
    expect(
      bbDesktopMachineAddressRequestSchema.parse({ hostname: "nas" }),
    ).toEqual({ hostname: "nas" });
    expect(
      bbDesktopMachineAddressResponseSchema.parse({
        addresses: ["192.168.178.72", "fd00::72"],
        resolvedHostname: "nas.local",
      }),
    ).toEqual({
      addresses: ["192.168.178.72", "fd00::72"],
      resolvedHostname: "nas.local",
    });
  });
});
