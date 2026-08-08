// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPreviewWorkspace } from "./EnvironmentPreviewWorkspace";

const previewState = vi.hoisted(() => ({
  data: {
    previewResources: [
      {
        createdAt: 10,
        id: "epr-local",
        kind: "local_browser" as const,
        label: "Local app",
        updatedAt: 10,
        url: "http://127.0.0.1:3000",
      },
      {
        createdAt: 11,
        id: "epr-remote",
        kind: "remote_novnc" as const,
        label: "Remote desktop",
        updatedAt: 11,
        url: "https://preview.example.test/vnc.html",
      },
    ],
    revision: 7,
    selectedPreviewResourceId: "epr-remote" as string | null,
  },
}));

const mutationMocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironmentPreviewResources: () => ({ data: previewState.data }),
}));

vi.mock("@/hooks/mutations/environment-mutations", () => ({
  useCreateEnvironmentPreviewResource: () => ({
    isPending: false,
    mutateAsync: mutationMocks.create,
  }),
  useRemoveEnvironmentPreviewResource: () => ({
    isPending: false,
    mutate: mutationMocks.remove,
  }),
  useSelectEnvironmentPreviewResource: () => ({
    isPending: false,
    mutate: mutationMocks.select,
  }),
}));

beforeEach(() => {
  previewState.data.selectedPreviewResourceId = "epr-remote";
  mutationMocks.create.mockReset();
  mutationMocks.remove.mockReset();
  mutationMocks.select.mockReset();
});

afterEach(cleanup);

describe("EnvironmentPreviewWorkspace", () => {
  it("renders the environment selection and keeps its live preview visible", () => {
    const { rerender } = render(
      <EnvironmentPreviewWorkspace environmentId="env-worktree" />,
    );

    const frame = screen.getByTestId("environment-preview-frame");
    expect(frame.getAttribute("src")).toBe(
      "https://preview.example.test/vnc.html",
    );
    expect(frame.getAttribute("title")).toBe(
      "Remote desktop environment preview",
    );

    // Thread navigation remounts detail content, but the environment-owned
    // selection remains the same synchronized state.
    rerender(<EnvironmentPreviewWorkspace environmentId="env-worktree" />);
    expect(
      screen.getByTestId("environment-preview-frame").getAttribute("src"),
    ).toBe("https://preview.example.test/vnc.html");
  });

  it("selects and removes resources using the observed aggregate revision", () => {
    render(<EnvironmentPreviewWorkspace environmentId="env-worktree" />);

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Selected environment preview",
      }),
      { target: { value: "epr-local" } },
    );
    expect(mutationMocks.select).toHaveBeenCalledWith({
      environmentId: "env-worktree",
      expectedRevision: 7,
      selectedPreviewResourceId: "epr-local",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Remote desktop" }),
    );
    expect(mutationMocks.remove).toHaveBeenCalledWith({
      environmentId: "env-worktree",
      expectedRevision: 7,
      resourceId: "epr-remote",
    });
  });
});
