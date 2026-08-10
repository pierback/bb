// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopServerState } from "@bb/desktop-contract";
import { ServerSettingsSectionContent } from "./ServerSettingsSection";

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

afterEach(cleanup);

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
});
