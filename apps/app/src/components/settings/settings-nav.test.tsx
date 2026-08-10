// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ToolsHubExperimentProvider } from "@/components/tools/tools-experiment-context";
import { useSettingsNavState } from "./settings-nav";

const mocks = vi.hoisted(() => ({
  plugins: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/queries/plugin-settings-queries", () => ({
  usePluginList: () => ({ data: { plugins: mocks.plugins } }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
}));

function wrapperFor(path: string, toolsHubEnabled = false) {
  const { wrapper: QueryWrapper } = createQueryClientTestHarness();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <MemoryRouter initialEntries={[path]}>
          <ToolsHubExperimentProvider enabled={toolsHubEnabled}>
            {children}
          </ToolsHubExperimentProvider>
        </MemoryRouter>
      </QueryWrapper>
    );
  };
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.clearAllMocks();
  mocks.plugins = [];
});

describe("useSettingsNavState", () => {
  it("resolves Codex and Claude Code as separate provider pages", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/providers/claude-code"),
    });

    expect(result.current.activeProviderId).toBe("claude-code");
    expect(result.current.activeSection).toBeNull();
    expect(
      result.current.providerEntries.map((provider) => provider.id),
    ).toEqual(["codex", "claude-code"]);
  });

  it("puts Coordination server and Machines first and resolves both sections", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/machines"),
    });

    expect(
      result.current.sections.slice(0, 2).map((section) => section.id),
    ).toEqual(["server", "machines"]);
    expect(result.current.activeSection).toBe("machines");

    const serverResult = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/server"),
    });
    expect(serverResult.result.current.activeSection).toBe("server");
  });

  it("resolves archived threads as a settings section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/archived"),
    });

    expect(result.current.activeSection).toBe("archived");
    expect(result.current.sections.map((section) => section.id)).toContain(
      "archived",
    );
  });

  it("keeps legacy plugin management in Settings while Extensions is disabled", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings"),
    });

    expect(result.current.sections.map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("hides legacy plugin management but preserves registered plugin settings while Extensions is enabled", () => {
    mocks.plugins = [
      {
        id: "workflows",
        enabled: true,
        hasSettings: true,
      },
    ];
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings", true),
    });

    expect(result.current.sections.map((section) => section.id)).not.toContain(
      "plugins",
    );
    expect(result.current.pluginEntries.map((plugin) => plugin.id)).toEqual([
      "workflows",
    ]);
  });
});
