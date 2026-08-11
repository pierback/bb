// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { ConnectionDetails } from "./connection-details.js";
import type { SessionFabricConnectionView } from "./server.js";

const app = await loadPluginApp(() => import("./app"));
const threadPanel = app.threadPanelActions[0]!;

const connection: SessionFabricConnectionView = {
  adoptionStatus: "enabled",
  bindingId: "binding-secret-technical",
  controlEpoch: 2,
  effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
  environmentId: "environment-1",
  isActiveAuthority: true,
  mutationPolicy: "enabled",
  nativeConversation: {
    catalogConversationId: "catalog-1",
    cwd: "/workspace/project",
    hostId: "this-mac",
    lastObservedAt: 1_786_000_000_000,
    nativeConversationId: "native-conversation-1",
    providerId: "codex",
    providerInstanceId: "codex-default",
    providerState: "idle",
    title: "Portable session",
  },
  openedAt: 1_785_000_000_000,
  ownership: "owned_brokered",
  phase: "idle",
  reasoningLevel: "high",
  runtime: { id: "runtime-1", status: "live" },
  serviceTier: "fast",
  threadId: "thread-1",
  updatedAt: 1_786_000_000_000,
};

afterEach(cleanup);

describe("ConnectionDetails", () => {
  it("keeps low-level identifiers hidden by default", () => {
    const html = renderToStaticMarkup(
      <ConnectionDetails
        connection={connection}
        showTechnicalIdentifiers={false}
      />,
    );
    expect(html).toContain("Portable session");
    expect(html).toContain("Active authority");
    expect(html).not.toContain("binding-secret-technical");
  });

  it("shows audit identifiers when the operator enables them", () => {
    const html = renderToStaticMarkup(
      <ConnectionDetails connection={connection} showTechnicalIdentifiers />,
    );
    expect(html).toContain("Technical identifiers");
    expect(html).toContain("binding-secret-technical");
    expect(html).toContain("native-conversation-1");
  });
});

describe("SessionFabricPanel", () => {
  it("discards a pending connection when the panel switches threads", async () => {
    let resolveOldConnection!: (value: {
      connection: SessionFabricConnectionView;
    }) => void;
    const oldConnection = new Promise<{
      connection: SessionFabricConnectionView;
    }>((resolve) => {
      resolveOldConnection = resolve;
    });
    const slot = renderSlot(
      threadPanel,
      { params: null, threadId: "thread-old" },
      {
        rpc: {
          connectThread: (input) => {
            const { threadId } = input as { threadId: string };
            if (threadId !== "thread-old") {
              throw new Error(`unexpected connect for ${threadId}`);
            }
            return oldConnection;
          },
          threadConnection: () => ({ connection: null }),
        },
      },
    );

    const oldThreadButton = await slot.findByRole("button", {
      name: "Connect thread",
    });
    fireEvent.click(oldThreadButton);
    expect(
      await slot.findByRole("button", { name: "Connecting…" }),
    ).toHaveProperty("disabled", true);

    const Panel = threadPanel.component;
    slot.lifecycle.rerender(<Panel params={null} threadId="thread-new" />);
    const newThreadButton = await slot.findByRole("button", {
      name: "Connect thread",
    });
    expect(newThreadButton).toHaveProperty("disabled", false);

    await act(async () => {
      resolveOldConnection({
        connection: { ...connection, threadId: "thread-old" },
      });
      await oldConnection;
    });
    expect(slot.queryByText("Portable session")).toBeNull();
    expect(newThreadButton).toHaveProperty("disabled", false);
  });
});
