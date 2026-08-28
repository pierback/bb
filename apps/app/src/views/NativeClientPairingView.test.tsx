// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk, BbHttpError } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { NativeClientPairingView } from "./NativeClientPairingView";

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {
    body: unknown;
    code: string | null;
    status: number;

    constructor(args: {
      body: unknown;
      code: string | null;
      message: string;
      status: number;
    }) {
      super(args.message);
      this.body = args.body;
      this.code = args.code;
      this.status = args.status;
    }
  },
  sdk: {
    hosts: {
      approveNativeClientPairing: vi.fn(),
      inspectNativeClientPairing: vi.fn(),
    },
  },
}));

function renderView(path = "/pair-device?requestId=pair_1&code=ABCD-EFGH") {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NativeClientPairingView />
    </MemoryRouter>,
    { wrapper },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeClientPairingView", () => {
  it("explains how to start when the approval link is incomplete", () => {
    renderView("/pair-device");

    expect(
      screen.getByRole("heading", { name: "Open this page from BB Desktop" }),
    ).toBeDefined();
    expect(sdk.hosts.inspectNativeClientPairing).not.toHaveBeenCalled();
  });

  it("shows the device and matching code before explicit approval", async () => {
    vi.mocked(sdk.hosts.inspectNativeClientPairing).mockResolvedValue({
      deviceName: "Ferdinand’s Mac",
      expiresAt: Date.now() + 300_000,
      requestId: "pair_1",
      status: "pending",
      userCode: "ABCD-EFGH",
    });
    vi.mocked(sdk.hosts.approveNativeClientPairing).mockResolvedValue({
      deviceName: "Ferdinand’s Mac",
      expiresAt: Date.now() + 300_000,
      requestId: "pair_1",
      status: "approved",
      userCode: "ABCD-EFGH",
    });

    renderView();

    expect(
      await screen.findByRole("heading", { name: "Approve this Mac?" }),
    ).toBeDefined();
    expect(screen.getByText("Ferdinand’s Mac")).toBeDefined();
    expect(screen.getByText("ABCD-EFGH")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Approve this Mac" }));

    await waitFor(() => {
      expect(sdk.hosts.approveNativeClientPairing).toHaveBeenCalledWith({
        code: "ABCD-EFGH",
        requestId: "pair_1",
      });
    });
    expect(
      await screen.findByRole("heading", { name: "This Mac is connected" }),
    ).toBeDefined();
  });

  it("renders an already-approved request without another action", async () => {
    vi.mocked(sdk.hosts.inspectNativeClientPairing).mockResolvedValue({
      deviceName: "Studio Mac",
      expiresAt: Date.now() + 60_000,
      requestId: "pair_1",
      status: "approved",
      userCode: "ABCD-EFGH",
    });

    renderView();

    expect(
      await screen.findByRole("heading", { name: "This Mac is connected" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Approve this Mac" }),
    ).toBeNull();
  });

  it("explains an expired request", async () => {
    vi.mocked(sdk.hosts.inspectNativeClientPairing).mockRejectedValue(
      new BbHttpError({
        body: null,
        code: "native_pairing_expired",
        message: "expired",
        status: 410,
      }),
    );

    renderView();

    expect(
      await screen.findByRole("heading", {
        name: "This pairing request expired",
      }),
    ).toBeDefined();
  });
});
