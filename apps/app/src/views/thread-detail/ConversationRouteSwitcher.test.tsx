// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ConversationRouteSwitcher } from "./ConversationRouteSwitcher";

const routeState = vi.hoisted(() => ({
  data: {
    currentThreadId: "thread-fork",
    rootThreadId: "thread-root",
    routes: [] as Array<{
      archivedAt: number | null;
      createdAt: number;
      path: Array<{
        threadId: string;
        title: string | null;
        titleFallback: string | null;
      }>;
      sourceSeqEnd: number | null;
      sourceThreadId: string | null;
      status: "idle" | "active" | "error";
      threadId: string;
      title: string | null;
      titleFallback: string | null;
    }>,
  },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadConversationRoutes: () => ({ data: routeState.data }),
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

const ROOT_ROUTE = {
  archivedAt: null,
  createdAt: 1,
  path: [
    {
      threadId: "thread-root",
      title: "Original route",
      titleFallback: null,
    },
  ],
  sourceSeqEnd: null,
  sourceThreadId: null,
  status: "idle" as const,
  threadId: "thread-root",
  title: "Original route",
  titleFallback: null,
};

const FORK_ROUTE = {
  archivedAt: null,
  createdAt: 2,
  path: [
    ...ROOT_ROUTE.path,
    {
      threadId: "thread-fork",
      title: "Current route",
      titleFallback: null,
    },
  ],
  sourceSeqEnd: 24,
  sourceThreadId: "thread-root",
  status: "active" as const,
  threadId: "thread-fork",
  title: "Current route",
  titleFallback: null,
};

function renderSwitcher(isCompactViewport = false) {
  return render(
    <TooltipProvider>
      <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
        <PaneContext.Provider value={PANE_CONTEXT}>
          <div data-testid="app-root">
            <ConversationRouteSwitcher
              projectId="project-1"
              threadId="thread-fork"
            />
          </div>
        </PaneContext.Provider>
      </CompactViewportOverrideProvider>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  routeState.data = {
    currentThreadId: "thread-fork",
    rootThreadId: "thread-root",
    routes: [ROOT_ROUTE, FORK_ROUTE],
  };
  navigateInPane.mockReset();
});

afterEach(cleanup);

describe("ConversationRouteSwitcher", () => {
  it("keeps a single conversation route out of the persistent header", () => {
    routeState.data = {
      currentThreadId: "thread-root",
      rootThreadId: "thread-root",
      routes: [ROOT_ROUTE],
    };

    renderSwitcher();

    expect(
      screen.queryByRole("button", { name: /choose conversation route/i }),
    ).toBeNull();
  });

  it("opens the route hierarchy on demand and navigates in the current pane", async () => {
    renderSwitcher();

    fireEvent.click(
      screen.getByRole("button", { name: /route 2 of 2 selected/i }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Choose conversation route" }),
    ).not.toBeNull();
    expect(screen.getByRole("list", { name: "Conversation routes" })).toBe(
      screen.getByRole("list"),
    );
    expect(
      screen
        .getByRole("button", {
          name: "Current route, Working, current route",
        })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText("Working")).not.toBeNull();
    expect(screen.getByText("Idle")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Original route, Idle" }),
    );

    expect(navigateInPane).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-root",
    });
  });

  it("uses the persistent compact drawer without hiding the app root", async () => {
    renderSwitcher(true);

    fireEvent.click(
      screen.getByRole("button", { name: /route 2 of 2 selected/i }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Choose conversation route" }),
    ).not.toBeNull();
    expect(screen.getByTestId("app-root").hasAttribute("aria-hidden")).toBe(
      false,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });
});
