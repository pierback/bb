// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import type { Host } from "@bb/domain";
import type { ProviderCliKey } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliIssue } from "@/components/provider-cli/provider-cli-install";
import type {
  UpdateInventory,
  UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";

const useUpdateInventoryMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useUpdateInventory", () => ({
  useUpdateInventory: useUpdateInventoryMock,
}));

afterEach(() => {
  cleanup();
  useUpdateInventoryMock.mockReset();
});

function providerIssue(
  provider: ProviderCliKey,
  displayName: string,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: `/usr/local/bin/${provider}`,
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      minimumSupportedVersion: "1.0.0",
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: "1.0.0",
      installAction: null,
      needsUpdate: true,
      versionUnsupported: false,
    },
    action: null,
    title: `${displayName} update available`,
    description: "1.0.0 -> 1.1.0",
    fingerprint: `${provider}:outdated`,
  };
}

function missingInstallIssue(
  provider: ProviderCliKey,
  displayName: string,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      latestVersion: "1.1.0",
      minimumSupportedVersion: null,
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: null,
      installAction: null,
      needsUpdate: false,
      versionUnsupported: false,
    },
    action: null,
    title: `${displayName} CLI not installed`,
    description: `Install ${displayName} so bb can start ${displayName} sessions.`,
    fingerprint: `${provider}:missing:1.1.0`,
  };
}

function host(id: string): Host {
  return {
    id,
    name: id,
    type: "persistent",
    status: "connected",
    networkIdentity: null,
    lastSeenAt: null,
    maxPermissionMode: "full",
    lastRejectedProtocolVersion: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function machine(
  overrides: Partial<UpdateInventoryMachine>,
): UpdateInventoryMachine {
  return {
    host: host("host-1"),
    isPrimary: true,
    providerStatus: null,
    statusPending: false,
    statusError: false,
    issues: [],
    canRetryDaemonUpdate: false,
    ...overrides,
  };
}

function renderBadge(inventory: Partial<UpdateInventory>) {
  useUpdateInventoryMock.mockReturnValue({
    isLoading: false,
    systemVersion: undefined,
    desktopInfo: null,
    desktopUpdateReady: false,
    machines: [],
    actionableCount: 0,
    hasAttention: false,
    ...inventory,
  });
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SidebarUpdatesBadge />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("SidebarUpdatesBadge", () => {
  it("renders nothing when no update needs attention", () => {
    const result = renderBadge({});
    expect(result.container.innerHTML).toBe("");
  });

  it("shows a relaunch action when a Pierback desktop update is downloaded", () => {
    renderBadge({ desktopUpdateReady: true });

    const desktopChip = screen.getByTestId("sidebar-updates-badge-desktop");
    expect(desktopChip.textContent).toContain("Relaunch");
    expect(desktopChip.getAttribute("aria-label")).toBe(
      "Open Updates to relaunch and install Pierback",
    );
    expect(screen.queryByTestId("sidebar-updates-badge-machines")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("shows a retry action for a daemon stuck on an old protocol", () => {
    renderBadge({ machines: [machine({ canRetryDaemonUpdate: true })] });

    const machinesChip = screen.getByTestId("sidebar-updates-badge-machines");
    expect(machinesChip.textContent).toContain("Retry 1");
    expect(machinesChip.getAttribute("aria-label")).toBe(
      "Open Updates to retry the Pierback agent update on 1 machine",
    );
    expect(screen.queryByTestId("sidebar-updates-badge-desktop")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("keeps desktop relaunch and machine retry as separate actions", () => {
    renderBadge({
      desktopUpdateReady: true,
      machines: [
        machine({ host: host("host-1"), canRetryDaemonUpdate: true }),
        machine({ host: host("host-2"), canRetryDaemonUpdate: true }),
      ],
    });

    expect(screen.getByTestId("sidebar-updates-badge-desktop")).toBeTruthy();
    const machinesChip = screen.getByTestId("sidebar-updates-badge-machines");
    expect(machinesChip.textContent).toContain("Retry 2");
    expect(machinesChip.getAttribute("aria-label")).toBe(
      "Open Updates to retry the Pierback agent update on 2 machines",
    );
  });

  it("shows only the provider chip when bb itself is current", () => {
    renderBadge({
      machines: [
        machine({ issues: [providerIssue("claudeCode", "Claude Code")] }),
      ],
    });

    expect(screen.queryByTestId("sidebar-updates-badge-desktop")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-machines")).toBeNull();
    expect(
      screen
        .getByTestId("sidebar-updates-badge-providers")
        .getAttribute("aria-label"),
    ).toBe("Claude Code update available");
  });

  it("renders no provider chip when a CLI is not installed", () => {
    renderBadge({
      machines: [
        machine({
          issues: [missingInstallIssue("claudeCode", "Claude Code")],
        }),
      ],
    });

    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-desktop")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-machines")).toBeNull();
  });

  it("still shows the relaunch action when the only provider issue is a missing CLI", () => {
    renderBadge({
      desktopUpdateReady: true,
      machines: [
        machine({
          issues: [missingInstallIssue("codex", "Codex")],
        }),
      ],
    });

    expect(screen.getByTestId("sidebar-updates-badge-desktop")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-machines")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("keeps simultaneous actions inside the sidebar and orders provider marks stably", () => {
    renderBadge({
      desktopUpdateReady: true,
      machines: [
        machine({
          host: host("host-1"),
          canRetryDaemonUpdate: true,
          issues: [providerIssue("claudeCode", "Claude Code")],
        }),
        machine({
          host: host("host-2"),
          issues: [
            providerIssue("claudeCode", "Claude Code"),
            providerIssue("codex", "Codex"),
          ],
        }),
      ],
    });

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    // Codex leads regardless of which machine surfaced the issue first.
    expect(providerChip.getAttribute("aria-label")).toBe(
      "Codex and Claude Code updates available",
    );
    expect(providerChip.querySelectorAll("svg[viewBox]").length).toBe(3);
    expect(screen.getByTestId("sidebar-updates-badge-desktop")).toBeTruthy();
    expect(screen.getByTestId("sidebar-updates-badge-machines")).toBeTruthy();

    const chipGroup = providerChip.closest("li");
    expect(chipGroup?.classList.contains("max-w-full")).toBe(true);
    expect(chipGroup?.classList.contains("flex-wrap")).toBe(true);
  });
});
