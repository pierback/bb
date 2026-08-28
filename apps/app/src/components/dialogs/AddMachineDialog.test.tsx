// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Host } from "@bb/domain";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostsQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AddMachineDialog } from "./AddMachineDialog";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...original,
    sdk: {
      hosts: {
        createJoinCode: vi.fn(),
        list: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

function host(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return {
    type: "persistent",
    status: "connected",
    networkIdentity: null,
    lastSeenAt: null,
    maxPermissionMode: "full",
    lastRejectedProtocolVersion: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const existingHost = host({ id: "host_primary", name: "MacBook Pro" });
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: writeTextMock },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddMachineDialog", () => {
  it("pairs directly through the selected coordinator and detects the new machine", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="https://bb.staufingers.de"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const command = await screen.findByText(/--join-code jc_test123/);
    expect(command.textContent).toContain("--host-id host_new");
    expect(command.textContent).toContain(
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 https://bb.staufingers.de/install.sh",
    );
    expect(command.textContent).toContain("--server https://bb.staufingers.de");
    expect(command.textContent).not.toContain("--machine-code");
    expect(command.textContent).not.toContain("getbb.app");
    expect(command.closest("[data-add-machine-command]")).not.toBeNull();
    expect(
      screen.getByText(
        /It installs bb and keeps the machine connected to this server/u,
      ),
    ).toBeDefined();
    expect(screen.getByText(/Code expires in \d+:\d{2}/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(command.textContent);
      expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(1);
    });
    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        host({ id: "host_new", name: "Mac Studio" }),
      ]);
    });

    expect(await screen.findByText("Mac Studio connected")).toBeDefined();
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("does not mistake a known machine reconnecting for the new machine", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    const offlineHost = host({
      id: "host_offline",
      name: "dev-vm",
      status: "disconnected",
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost, offlineHost]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="https://bb.staufingers.de"
        />
      </MemoryRouter>,
      { wrapper },
    );

    await screen.findByText(/--join-code jc_test123/);
    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(2);
    });
    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        { ...offlineHost, status: "connected" },
      ]);
    });

    expect(
      await screen.findByText("Waiting for the machine to connect…"),
    ).toBeDefined();
    expect(screen.queryByText("dev-vm connected")).toBeNull();
  });

  it("routes loopback users to coordination server settings", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://127.0.0.1:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "Another machine cannot use this address.",
    );
    expect(notice.textContent).toContain("http://127.0.0.1:38886");
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
    const link = screen.getByRole("link", {
      name: "Choose coordination server",
    });
    expect(link.getAttribute("href")).toBe("/settings/server");
    expect(notice.textContent).not.toContain("Connect");
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("retries coordinator join-code creation after a transient failure", async () => {
    vi.mocked(sdk.hosts.createJoinCode)
      .mockRejectedValueOnce(new Error("coordinator unavailable"))
      .mockResolvedValueOnce({
        joinCode: "jc_retry",
        hostId: "host_retry",
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="https://bb.staufingers.de"
        />
      </MemoryRouter>,
      { wrapper },
    );

    expect(await screen.findByText("coordinator unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/--join-code jc_retry/)).toBeDefined();
    expect(sdk.hosts.createJoinCode).toHaveBeenCalledTimes(2);
  });
});
