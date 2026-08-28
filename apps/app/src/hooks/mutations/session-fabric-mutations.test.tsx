// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  SessionFabricConnectResponse,
  SessionFabricEnvironmentConnectionsResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { environmentSessionConnectionsQueryKey } from "../queries/query-keys";
import { useConnectThreadSession } from "./session-fabric-mutations";

vi.mock("@/lib/sdk", () => ({
  sdk: { sessionFabric: { connectThread: vi.fn() } },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn(), success: vi.fn() },
}));

const connection: SessionFabricConnectResponse["connection"] = {
  adoptionStatus: "enabled",
  bindingId: "binding-test",
  controlEpoch: 1,
  effectiveModel: null,
  environmentId: "env-test",
  isActiveAuthority: true,
  mutationPolicy: "enabled",
  nativeConversation: {
    catalogConversationId: "catalog-test",
    cwd: "/repo/.worktrees/test",
    hostId: "host-test",
    lastObservedAt: 1,
    nativeConversationId: "native-test",
    providerId: "codex",
    providerInstanceId: "codex-default",
    providerState: "idle",
    title: "Native Codex session",
  },
  openedAt: 1,
  ownership: "owned_exclusive",
  phase: "idle",
  reasoningLevel: null,
  runtime: { id: "runtime-test", status: "live" },
  serviceTier: null,
  threadId: "thr-test",
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useConnectThreadSession", () => {
  it("connects the thread and refreshes its environment connection cache", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKey = environmentSessionConnectionsQueryKey("env-test");
    queryClient.setQueryData<SessionFabricEnvironmentConnectionsResponse>(
      queryKey,
      { connections: [] },
    );
    vi.mocked(sdk.sessionFabric.connectThread).mockResolvedValue({
      connection,
    });
    const { result } = renderHook(() => useConnectThreadSession(), { wrapper });

    act(() => {
      result.current.mutate({
        environmentId: "env-test",
        threadId: "thr-test",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sdk.sessionFabric.connectThread).toHaveBeenCalledWith({
      threadId: "thr-test",
    });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(appToast.success).toHaveBeenCalledWith("Conversation connected", {
      description: "Native Codex session",
    });
  });
});
