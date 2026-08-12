// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BbDesktopServerState,
  BbDesktopServerStateChangeHandler,
} from "@bb/desktop-contract";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import {
  ServerSettingsSection,
  ServerSettingsSectionContent,
} from "./ServerSettingsSection";

const serverState: BbDesktopServerState = {
  activeServerId: "builtin",
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

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "bbDesktop");
});

describe("ServerSettingsSectionContent", () => {
  it("makes the BB server explicit and keeps it distinct from execution machines", () => {
    const onOpenCustomServerDialog = vi.fn();
    const onSelect = vi.fn();

    render(
      <MemoryRouter>
        <ServerSettingsSectionContent
          browserServerUrl="http://127.0.0.1:38886"
          error={null}
          isDesktop={true}
          isRefreshing={false}
          onOpenCustomServerDialog={onOpenCustomServerDialog}
          onRefresh={vi.fn()}
          onSelect={onSelect}
          serverState={serverState}
          switchingServerId={null}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Coordination server" }),
    ).toBeDefined();
    expect(screen.getByText("Current coordination server")).toBeDefined();
    expect(screen.getByText("Server coordinates")).toBeDefined();
    expect(screen.getByText("Machines execute")).toBeDefined();
    expect(
      screen.getByText(/keeps execution and filesystem access on this Mac/i),
    ).toBeDefined();
    expect(
      screen.getByText(
        /Adding the NAS as a machine does not make it the server/,
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        /This Mac runs the selected projects, files, terminals/i,
      ),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Use NAS Mac as the coordination server",
      }),
    );
    expect(onSelect).toHaveBeenCalledWith("connect:nas");

    fireEvent.click(screen.getByRole("button", { name: "Set server URL…" }));
    expect(onOpenCustomServerDialog).toHaveBeenCalledOnce();
  });

  it("explains that a browser tab uses the server in its address bar", () => {
    render(
      <MemoryRouter>
        <ServerSettingsSectionContent
          browserServerUrl="https://nas.example"
          error={null}
          isDesktop={false}
          isRefreshing={false}
          onOpenCustomServerDialog={vi.fn()}
          onRefresh={vi.fn()}
          onSelect={vi.fn()}
          serverState={null}
          switchingServerId={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("https://nas.example")).toHaveLength(2);
    expect(
      screen.getByText(
        /browser tab is attached to the server in its address bar/i,
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Set server URL…" }),
    ).toBeNull();
  });

  it("shows an execution-host crash immediately from the desktop push channel", async () => {
    let stateListener: BbDesktopServerStateChangeHandler | null = null;
    const desktopApi = createBbDesktopApi({
      downloadState: "idle",
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updatesEnabled: true,
      updateAvailable: false,
      updateChannel: "stable",
      updateDownloaded: false,
      version: "0.0.0-test",
    });
    desktopApi.server = {
      async getState() {
        return serverState;
      },
      async refresh() {
        return serverState;
      },
      onStateChange(listener) {
        stateListener = listener;
        return () => {
          stateListener = null;
        };
      },
      async select() {},
      openCustomServerDialog() {},
    };
    Object.defineProperty(window, "bbDesktop", {
      configurable: true,
      value: desktopApi,
    });

    render(
      <MemoryRouter>
        <ServerSettingsSection />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(stateListener).not.toBeNull();
    });

    const listener = stateListener as BbDesktopServerStateChangeHandler | null;
    if (listener === null) {
      throw new Error("Expected the settings section to subscribe to pushes");
    }
    act(() => {
      listener({
        ...serverState,
        activeServerId: "connect:nas",
        executionHost: {
          error: "execution helper exited",
          hostId: "host-local",
          port: 39812,
          serverUrl: "https://nas.getbb.app",
          status: "error",
        },
      });
    });

    expect(
      screen.getByText(
        /this mac could not connect as the execution machine: execution helper exited/i,
      ).textContent,
    ).toContain("execution helper exited");
  });

  it("does not let a stale manual refresh overwrite a newer desktop push", async () => {
    let stateListener: BbDesktopServerStateChangeHandler | null = null;
    let refreshCount = 0;
    let resolveManualRefresh:
      | ((state: BbDesktopServerState) => void)
      | undefined;
    const desktopApi = createBbDesktopApi({
      downloadState: "idle",
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updatesEnabled: true,
      updateAvailable: false,
      updateChannel: "stable",
      updateDownloaded: false,
      version: "0.0.0-test",
    });
    desktopApi.server = {
      async getState() {
        return serverState;
      },
      async refresh() {
        refreshCount += 1;
        if (refreshCount === 1) return serverState;
        return new Promise<BbDesktopServerState>((resolve) => {
          resolveManualRefresh = resolve;
        });
      },
      onStateChange(listener) {
        stateListener = listener;
        return () => {
          stateListener = null;
        };
      },
      async select() {},
      openCustomServerDialog() {},
    };
    Object.defineProperty(window, "bbDesktop", {
      configurable: true,
      value: desktopApi,
    });

    render(
      <MemoryRouter>
        <ServerSettingsSection />
      </MemoryRouter>,
    );
    await waitFor(() => expect(refreshCount).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveManualRefresh).toBeDefined());

    const listener = stateListener as BbDesktopServerStateChangeHandler | null;
    if (listener === null || resolveManualRefresh === undefined) {
      throw new Error("Expected a desktop push listener and pending refresh");
    }
    const resolveRefresh = resolveManualRefresh;
    act(() => {
      listener({
        ...serverState,
        activeServerId: "connect:nas",
        executionHost: {
          error: "newer execution state",
          hostId: "host-local",
          port: 39812,
          serverUrl: "https://nas.getbb.app",
          status: "error",
        },
      });
    });
    await act(async () => {
      resolveRefresh(serverState);
    });

    expect(screen.getByText(/newer execution state/i)).toBeDefined();
  });
});
