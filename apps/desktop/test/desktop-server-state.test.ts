import { describe, expect, it } from "vitest";
import {
  buildDesktopServerState,
  connectServerId,
} from "../src/desktop-server-state.js";

describe("buildDesktopServerState", () => {
  it("builds one explicit picker model for local, Connect, and custom servers", () => {
    expect(
      buildDesktopServerState({
        builtinServerUrl: "http://127.0.0.1:38886",
        connectServers: [
          {
            handle: "nas",
            name: "NAS Mac",
            url: "https://nas.getbb.app",
          },
        ],
        customServerUrl: "https://studio.example:38886",
        executionHost: null,
        savedConnectServer: {
          handle: "nas",
          name: "NAS Mac",
          url: "https://nas.getbb.app",
        },
        target: {
          kind: "connect",
          server: {
            handle: "nas",
            name: "NAS Mac",
            url: "https://nas.getbb.app",
          },
        },
      }),
    ).toEqual({
      activeServerId: connectServerId("nas"),
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
        {
          id: "custom",
          kind: "custom",
          name: "studio.example:38886",
          url: "https://studio.example:38886",
        },
      ],
    });
  });

  it("retains the selected Connect server when account sync omits it", () => {
    const state = buildDesktopServerState({
      builtinServerUrl: "http://127.0.0.1:38886",
      connectServers: [],
      customServerUrl: null,
      executionHost: null,
      savedConnectServer: {
        handle: "nas",
        name: "NAS Mac",
        url: "https://nas.getbb.app",
      },
      target: {
        kind: "connect",
        server: {
          handle: "nas",
          name: "NAS Mac",
          url: "https://nas.getbb.app",
        },
      },
    });

    expect(state.activeServerId).toBe("connect:nas");
    expect(state.servers).toContainEqual({
      handle: "nas",
      id: "connect:nas",
      kind: "connect",
      name: "NAS Mac",
      url: "https://nas.getbb.app",
    });
  });

  it("retains a saved Connect server while the builtin server is active", () => {
    const state = buildDesktopServerState({
      builtinServerUrl: "http://127.0.0.1:38886",
      connectServers: [],
      customServerUrl: null,
      executionHost: null,
      savedConnectServer: {
        handle: "nas",
        name: "NAS Mac",
        url: "https://nas.getbb.app",
      },
      target: { kind: "builtin" },
    });

    expect(state.activeServerId).toBe("builtin");
    expect(state.servers).toContainEqual({
      handle: "nas",
      id: "connect:nas",
      kind: "connect",
      name: "NAS Mac",
      url: "https://nas.getbb.app",
    });
  });
});
