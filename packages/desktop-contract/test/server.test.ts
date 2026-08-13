import { describe, expect, it } from "vitest";
import {
  bbDesktopSelectServerRequestSchema,
  bbDesktopServerStateSchema,
} from "../src/server.js";

const validState = {
  activeServerId: "connect:nas",
  executionHost: null,
  servers: [
    {
      id: "builtin",
      kind: "builtin",
      name: "This Mac",
      url: "http://127.0.0.1:38886",
    },
    {
      handle: "nas",
      id: "connect:nas",
      kind: "connect",
      name: "NAS Mac",
      url: "https://nas.getbb.app",
    },
  ],
};

describe("bbDesktopServerStateSchema", () => {
  it("accepts an explicit active server from the available server list", () => {
    expect(bbDesktopServerStateSchema.parse(validState)).toEqual(validState);
  });

  it("rejects a dangling active server id", () => {
    expect(
      bbDesktopServerStateSchema.safeParse({
        ...validState,
        activeServerId: "connect:missing",
      }).success,
    ).toBe(false);
  });

  it("rejects fields outside the desktop server contract", () => {
    expect(
      bbDesktopServerStateSchema.safeParse({
        ...validState,
        activeServerId: "builtin",
        servers: [{ ...validState.servers[0], token: "secret" }],
      }).success,
    ).toBe(false);
  });
});

describe("bbDesktopSelectServerRequestSchema", () => {
  it("accepts only a non-empty server id", () => {
    expect(
      bbDesktopSelectServerRequestSchema.parse({ serverId: "builtin" }),
    ).toEqual({ serverId: "builtin" });
    expect(
      bbDesktopSelectServerRequestSchema.safeParse({ serverId: "" }).success,
    ).toBe(false);
    expect(
      bbDesktopSelectServerRequestSchema.safeParse({
        serverId: "builtin",
        url: "https://unexpected.example",
      }).success,
    ).toBe(false);
  });
});
