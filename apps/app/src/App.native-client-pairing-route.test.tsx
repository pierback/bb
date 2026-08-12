// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { useAppTheme } from "./hooks/useAppTheme";
import { useDesktopThemeSync } from "./hooks/useDesktopThemeSync";
import { usePluginFrontendBoot } from "./hooks/usePluginFrontendBoot";
import { useWebSocket } from "./hooks/useWebSocket";
import { useFaviconColorSync } from "./lib/favicon-color-preference";

vi.mock("./views/NativeClientPairingView", () => ({
  NativeClientPairingView: () => <main>Native pairing guide</main>,
}));
vi.mock("./hooks/useAppTheme", () => ({ useAppTheme: vi.fn() }));
vi.mock("./hooks/useDesktopThemeSync", () => ({
  useDesktopThemeSync: vi.fn(),
}));
vi.mock("./hooks/usePluginFrontendBoot", () => ({
  usePluginFrontendBoot: vi.fn(),
}));
vi.mock("./hooks/useWebSocket", () => ({ useWebSocket: vi.fn() }));
vi.mock("./lib/favicon-color-preference", () => ({
  useFaviconColorSync: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("native client pairing route", () => {
  it("does not start the interactive app runtime behind the approval guide", () => {
    render(
      <MemoryRouter
        initialEntries={["/pair-device?requestId=bbnp_1&code=ABCD"]}
      >
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText("Native pairing guide")).toBeDefined();
    expect(useWebSocket).not.toHaveBeenCalled();
    expect(usePluginFrontendBoot).not.toHaveBeenCalled();
    expect(useAppTheme).not.toHaveBeenCalled();
    expect(useDesktopThemeSync).not.toHaveBeenCalled();
    expect(useFaviconColorSync).not.toHaveBeenCalled();
  });
});
