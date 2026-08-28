// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ProviderInfo } from "@bb/domain";
import type { SessionFabricConnection } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  isThreadSessionConnectionEnabled,
  ThreadSessionConnectionStatus,
} from "./ThreadSessionConnectionStatus";

function createConnection(
  overrides: Partial<SessionFabricConnection> = {},
): SessionFabricConnection {
  return {
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
    ...overrides,
  };
}

const CODEX_PROVIDER: ProviderInfo = {
  id: "codex",
  pluginId: "provider-codex",
  displayName: "Codex",
  logoUrl: null,
  available: true,
  maintenance: { health: false, usage: false, installation: false },
  composerActions: [],
  capabilities: {
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: true,
    modelCatalogScope: "workspace",
    permissionModes: ["accept-edits", "auto", "full"],
  },
};

afterEach(cleanup);

describe("ThreadSessionConnectionStatus", () => {
  it("renders a compact connected provider badge in the header", () => {
    render(
      <ThreadSessionConnectionStatus
        connection={createConnection()}
        provider={CODEX_PROVIDER}
        variant="header"
      />,
    );

    expect(screen.getByText("Codex")).not.toBeNull();
    expect(screen.getByText("Connected")).not.toBeNull();
  });

  it("exposes the provider connection on the sidebar row", () => {
    render(
      <ThreadSessionConnectionStatus
        connection={createConnection()}
        provider={CODEX_PROVIDER}
        variant="sidebar"
      />,
    );

    expect(screen.getByLabelText("Codex session connected")).not.toBeNull();
  });

  it("surfaces a connection that cannot mutate as needing attention", () => {
    const connection = createConnection({ mutationPolicy: "staged_read_only" });

    expect(isThreadSessionConnectionEnabled(connection)).toBe(false);
    render(
      <ThreadSessionConnectionStatus
        connection={connection}
        provider={CODEX_PROVIDER}
        variant="header"
      />,
    );

    expect(screen.getByText("Needs attention")).not.toBeNull();
  });
});
