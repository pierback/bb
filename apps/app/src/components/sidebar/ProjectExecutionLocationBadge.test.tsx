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

  it("uses daemon identity rather than the mutable display name for IP lookup", async () => {
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
              label: "Renamed NAS",
              networkIdentity: {
                hostname: "pierback-nas.local",
                addresses: ["192.168.178.72"],
              },
              path: "/Volumes/2TB_1/projects/PhotoCloud",
              title: "Project runs on Renamed NAS",
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const badge = screen.getByLabelText("Project runs on Renamed NAS");
    fireEvent.pointerMove(badge, { pointerType: "mouse" });

    expect(await screen.findAllByText("192.168.178.72")).not.toHaveLength(0);
    expect(
      screen.getAllByText("/Volumes/2TB_1/projects/PhotoCloud"),
    ).not.toHaveLength(0);
    expect(desktopApi.network.resolveMachineAddresses).toHaveBeenCalledWith({
      hostname: "pierback-nas.local",
    });
  });

  it("shows daemon-reported addresses in the PWA without a desktop resolver", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider delayDuration={0}>
          <ProjectExecutionLocationBadge
            location={{
              connected: true,
              label: "nas",
              networkIdentity: {
                hostname: "nas.local",
                addresses: ["10.0.0.72"],
              },
              path: "/srv/project",
              title: "Project runs on nas",
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.pointerMove(screen.getByLabelText("Project runs on nas"), {
      pointerType: "mouse",
    });
    expect(await screen.findAllByText("10.0.0.72")).not.toHaveLength(0);
  });
});
