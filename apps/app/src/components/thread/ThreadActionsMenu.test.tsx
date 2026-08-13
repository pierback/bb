// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionFabricConnection } from "@bb/server-contract";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThread } from "../../../.ladle/story-fixtures";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";
import { ThreadActionsMenu } from "./ThreadActionsMenu";

const sessionState = vi.hoisted(() => ({
  connection: null as SessionFabricConnection | null,
  isSuccess: true,
}));
const connectThreadSession = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));
const copyToClipboardWithToast = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("@/hooks/queries/session-fabric-queries", () => ({
  useThreadSessionConnection: () => ({
    connection: sessionState.connection,
    isSuccess: sessionState.isSuccess,
  }),
}));

vi.mock("@/hooks/mutations/session-fabric-mutations", () => ({
  useConnectThreadSession: () => connectThreadSession,
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboardWithToast }));

vi.mock("./ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    archiveThreadAndChildren: vi.fn(),
    requestDelete: vi.fn(),
    requestRename: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

function makeConnection(): SessionFabricConnection {
  return {
    adoptionStatus: "enabled",
    bindingId: "binding_test",
    controlEpoch: 1,
    effectiveModel: null,
    environmentId: "env_actions",
    isActiveAuthority: true,
    mutationPolicy: "enabled",
    nativeConversation: {
      catalogConversationId: "catalog_test",
      cwd: "/repo/.worktrees/test",
      hostId: "host_test",
      lastObservedAt: 1,
      nativeConversationId: "session_test",
      providerId: "codex",
      providerInstanceId: "codex_default",
      providerState: "idle",
      title: "Native Codex session",
    },
    openedAt: 1,
    ownership: "owned_exclusive",
    phase: "idle",
    reasoningLevel: null,
    runtime: { id: "runtime_test", status: "live" },
    serviceTier: null,
    threadId: "thr_actions",
    updatedAt: 1,
  };
}

async function openThreadActions() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Thread actions" }),
    { button: 0 },
  );
  await screen.findByRole("menuitem", { name: "Copy thread ID" });
}

afterEach(() => {
  cleanup();
  sessionState.connection = null;
  sessionState.isSuccess = true;
  connectThreadSession.isPending = false;
  vi.clearAllMocks();
});

describe("ThreadActionsMenu", () => {
  const thread = makeThread({
    id: "thr_actions",
    projectId: "proj_actions",
    environmentId: "env_actions",
    title: "Menu actions",
  });

  it("connects an unbound thread from its actions menu", async () => {
    render(
      <MemoryRouter>
        <ThreadActionsMenu thread={thread} />
      </MemoryRouter>,
    );

    await openThreadActions();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Connect agent session" }),
    );

    expect(connectThreadSession.mutate).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
  });

  it("exposes the useful workspace and thread utilities", async () => {
    const onRevealWorkspace = vi.fn();
    const onForkFromLatestSnapshot = vi.fn();
    render(
      <MemoryRouter>
        <ThreadActionsMenu
          thread={thread}
          workspacePath="/Users/demo/projects/bb"
          onRevealWorkspace={onRevealWorkspace}
          onForkFromLatestSnapshot={onForkFromLatestSnapshot}
        />
      </MemoryRouter>,
    );

    await openThreadActions();

    for (const name of [
      "Connect agent session",
      "Reveal in Finder",
      "Copy working directory",
      "Copy thread ID",
      "Copy deeplink",
      "Fork from latest snapshot",
      "Continue in new thread",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(onRevealWorkspace).toHaveBeenCalledTimes(1);

    await openThreadActions();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Fork from latest snapshot" }),
    );
    expect(onForkFromLatestSnapshot).toHaveBeenCalledTimes(1);
  });

  it("hides the latest-snapshot fork when the provider cannot supply it", async () => {
    render(
      <MemoryRouter>
        <ThreadActionsMenu thread={thread} />
      </MemoryRouter>,
    );

    await openThreadActions();
    expect(
      screen.queryByRole("menuitem", { name: "Fork from latest snapshot" }),
    ).toBeNull();
  });

  it("copies the workspace path, thread ID, and thread deeplink", async () => {
    render(
      <MemoryRouter>
        <ThreadActionsMenu
          thread={thread}
          workspacePath="/Users/demo/projects/bb"
        />
      </MemoryRouter>,
    );

    await openThreadActions();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy working directory" }),
    );
    await waitFor(() =>
      expect(copyToClipboardWithToast).toHaveBeenCalledWith(
        "/Users/demo/projects/bb",
        expect.objectContaining({ successMessage: "Working directory copied" }),
      ),
    );

    await openThreadActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread ID" }));
    await waitFor(() =>
      expect(copyToClipboardWithToast).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({ successMessage: "Thread ID copied" }),
      ),
    );

    await openThreadActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy deeplink" }));
    await waitFor(() =>
      expect(copyToClipboardWithToast).toHaveBeenCalledWith(
        new URL(
          getThreadRoutePath({
            projectId: thread.projectId,
            threadId: thread.id,
          }),
          window.location.href,
        ).toString(),
        expect.objectContaining({ successMessage: "Thread deeplink copied" }),
      ),
    );
  });

  it("continues in a new thread with the existing handoff state", async () => {
    render(
      <MemoryRouter
        initialEntries={["/projects/proj_actions/threads/thr_actions"]}
      >
        <ThreadActionsMenu thread={thread} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await openThreadActions();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Continue in new thread" }),
    );

    await waitFor(() => {
      const location = screen.getByTestId("location").textContent ?? "";
      expect(location).toContain(getProjectComposeRoutePath(thread.projectId));
      expect(location).toContain(thread.id);
      expect(location).toContain(thread.environmentId);
    });
  });

  it("exposes connected provider details without duplicate utilities", async () => {
    sessionState.connection = makeConnection();
    render(
      <MemoryRouter>
        <ThreadActionsMenu thread={thread} />
      </MemoryRouter>,
    );

    await openThreadActions();

    expect(
      screen.queryByRole("menuitem", { name: "Connect agent session" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("menuitem", { name: "Copy thread ID" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("menuitem", { name: "Copy working directory" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("menuitem", { name: "Copy session ID" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy session ID" }));
    expect(copyToClipboardWithToast).toHaveBeenCalledWith("session_test", {
      successMessage: "Session ID copied",
      errorMessage: "Failed to copy session ID",
    });
  });
});
