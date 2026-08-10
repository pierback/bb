// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { ProjectExecutionLocationBadge } from "./ProjectExecutionLocationBadge";

describe("ProjectExecutionLocationBadge", () => {
  afterEach(() => {
    cleanup();
    delete window.bbDesktop;
  });

  it("shows the machine IP and project path when the badge is hovered", async () => {
    const desktopApi = createBbDesktopApi({
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    });
    desktopApi.network.resolveMachineAddresses = vi.fn().mockResolvedValue({
      addresses: ["192.168.178.72"],
      resolvedHostname: "nas.local",
    });
    window.bbDesktop = desktopApi;

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TooltipProvider delayDuration={0}>
          <ProjectExecutionLocationBadge
            location={{
              connected: true,
              label: "nas",
              machineName: "nas",
              path: "/Volumes/2TB_1/projects/PhotoCloud",
              title: "Project runs on nas",
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const badge = screen.getByLabelText("Project runs on nas");
    fireEvent.pointerMove(badge, { pointerType: "mouse" });

    expect(await screen.findAllByText("192.168.178.72")).not.toHaveLength(0);
    expect(
      screen.getAllByText("/Volumes/2TB_1/projects/PhotoCloud"),
    ).not.toHaveLength(0);
    expect(desktopApi.network.resolveMachineAddresses).toHaveBeenCalledWith({
      hostname: "nas",
    });
  });
});
