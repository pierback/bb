// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { WorktreeThreadSwitcher } from "./WorktreeThreadSwitcher";

const queryState = vi.hoisted(() => ({
  activeThreads: [
    {
      id: "thr-current",
      status: "idle" as const,
      title: "Current thread",
      titleFallback: null,
    },
    {
      id: "thr-open",
      status: "active" as const,
      title: "Open thread",
      titleFallback: null,
    },
    {
      id: "thr-not-open",
      status: "idle" as const,
      title: "Not open",
      titleFallback: null,
    },
  ],
  connections: [] as Array<Record<string, unknown>>,
  threadIds: ["thr-open"] as string[],
}));

const syncMocks = vi.hoisted(() => ({
  schedule: vi.fn(),
}));

const connectionMocks = vi.hoisted(() => ({
  connectThread: vi.fn(),
  refetch: vi.fn(),
}));

const CONNECTED_CONVERSATION = {
  adoptionStatus: "enabled" as const,
  bindingId: "binding-current",
  controlEpoch: 1,
  effectiveModel: null,
  environmentId: "env-worktree",
  isActiveAuthority: true,
  mutationPolicy: "enabled" as const,
  nativeConversation: {
    catalogConversationId: "conversation-current",
    cwd: "/repo/.worktrees/current",
    hostId: "host-1",
    lastObservedAt: 1,
    nativeConversationId: "native-current",
    providerId: "codex",
    providerInstanceId: "codex-default",
    providerState: "idle",
    title: "Native Codex session",
  },
  openedAt: 1,
  ownership: "owned_exclusive" as const,
  phase: "idle" as const,
  reasoningLevel: null,
  runtime: { id: "runtime-current", status: "live" as const },
  serviceTier: null,
  threadId: "thr-current",
  updatedAt: 1,
};

vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironmentThreadTabs: () => ({
    data: { revision: 3, threadIds: queryState.threadIds },
  }),
}));

vi.mock("@/hooks/queries/session-fabric-queries", () => ({
  useEnvironmentSessionConnections: () => ({
    data: { connections: queryState.connections },
    isSuccess: true,
    refetch: connectionMocks.refetch,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreads: (filters: { archived: boolean }) => ({
    data: filters.archived ? [] : queryState.activeThreads,
  }),
}));

vi.mock("@/lib/environment-thread-tabs-sync", () => ({
  scheduleEnvironmentThreadTabsUpdate: syncMocks.schedule,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    sessionFabric: { connectThread: connectionMocks.connectThread },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn(), success: vi.fn() },
}));

const navigateInPane = vi.fn();
const PANE_CONTEXT: PaneContextValue = {
  paneId: "main",
  isFocused: true,
  isSplitPane: false,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: false,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane,
};

function renderSwitcher(onCreateThread = vi.fn(), isCompactViewport = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onCreateThread,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
          <PaneContext.Provider value={PANE_CONTEXT}>
            <WorktreeThreadSwitcher
              currentThread={queryState.activeThreads[0]}
              environmentId="env-worktree"
              environmentLabel="feature/tabs"
              onCreateThread={onCreateThread}
              projectId="project-1"
            />
          </PaneContext.Provider>
        </CompactViewportOverrideProvider>
      </QueryClientProvider>,
    ),
  };
}

function openSwitcher() {
  fireEvent.click(
    screen.getByRole("button", { name: "Open threads in feature/tabs" }),
  );
}

beforeEach(() => {
  queryState.connections = [];
  queryState.threadIds = ["thr-open"];
  connectionMocks.connectThread.mockReset();
  connectionMocks.connectThread.mockResolvedValue({
    connection: CONNECTED_CONVERSATION,
  });
  connectionMocks.refetch.mockReset();
  connectionMocks.refetch.mockResolvedValue(undefined);
  navigateInPane.mockReset();
  syncMocks.schedule.mockReset();
});

afterEach(cleanup);

describe("WorktreeThreadSwitcher", () => {
  it("keeps the thread chrome compact and lists the explicit open set plus the routed thread", async () => {
    renderSwitcher();

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Current thread")).toBeNull();
    openSwitcher();

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Current thread")).not.toBeNull();
    expect(screen.getByText("Open thread")).not.toBeNull();
    expect(screen.queryByText("Not open")).toBeNull();
    await waitFor(() => expect(syncMocks.schedule).toHaveBeenCalled());
    const update = syncMocks.schedule.mock.calls[0]?.[0].update as (
      ids: readonly string[],
    ) => readonly string[];
    expect(update(["thr-open"])).toEqual(["thr-open", "thr-current"]);
  });

  it("switches the active pane from the vertical list", () => {
    queryState.threadIds = ["thr-current", "thr-open"];
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByText("Open thread"));
    expect(navigateInPane).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thr-open",
    });
  });

  it("keeps the compact drawer controls above the bottom safe area", async () => {
    renderSwitcher(vi.fn(), true);
    openSwitcher();

    expect(
      (await screen.findByTestId("worktree-thread-switcher")).className,
    ).toContain("pb-[max(1rem,env(safe-area-inset-bottom))]");
  });

  it("closes only the view and leaves thread lifecycle untouched", () => {
    queryState.threadIds = ["thr-current", "thr-open"];
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: "Close Open thread" }));
    expect(syncMocks.schedule).toHaveBeenCalledOnce();
    const update = syncMocks.schedule.mock.calls[0]?.[0].update as (
      ids: readonly string[],
    ) => readonly string[];
    expect(update(["thr-current", "thr-open"])).toEqual(["thr-current"]);
    expect(navigateInPane).not.toHaveBeenCalled();
  });

  it("shows the real provider-native conversation bound to a thread", () => {
    queryState.connections = [CONNECTED_CONVERSATION];
    renderSwitcher();
    openSwitcher();

    const currentThreadButton = screen
      .getByText("Native Codex session")
      .closest("button");
    expect(currentThreadButton?.getAttribute("aria-current")).toBe("page");
    expect(currentThreadButton?.textContent).toContain("Current thread");
    expect(
      screen.queryByRole("button", {
        name: "Connect Current thread to its provider conversation",
      }),
    ).toBeNull();
  });

  it("connects an unbound thread through Session Fabric", async () => {
    renderSwitcher();
    openSwitcher();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Connect Current thread to its provider conversation",
      }),
    );

    await waitFor(() =>
      expect(connectionMocks.connectThread).toHaveBeenCalledWith({
        threadId: "thr-current",
      }),
    );
    await waitFor(() => expect(connectionMocks.refetch).toHaveBeenCalledOnce());
  });
});
