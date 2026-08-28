// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ProjectManagerProjectionResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectManagerView } from "./ProjectManagerView";

const mockProjection = vi.hoisted(() => ({
  data: null as ProjectManagerProjectionResponse | null,
}));

vi.mock("@/hooks/queries/project-queries", () => ({
  useProjectManagerProjection: () => ({
    data: mockProjection.data,
    error: null,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  }),
}));

function makeProjection(): ProjectManagerProjectionResponse {
  return {
    project: {
      id: "proj_test",
      kind: "standard",
      name: "Agentic IDE",
      gitRemoteUrl: null,
      sources: [],
      createdAt: 1,
      updatedAt: 1,
    },
    generatedAt: Date.now(),
    environments: [
      {
        environment: {
          id: "env_test",
          name: "Session Fabric",
          projectId: "proj_test",
          hostId: "host_test",
          parentEnvironmentId: null,
          parentBaseCommit: null,
          parentHadUncommittedChanges: false,
          path: "/work/session-fabric",
          managed: true,
          isGitRepo: true,
          isWorktree: true,
          workspaceProvisionType: "managed-worktree",
          branchName: "feat/session-fabric",
          baseBranch: "main",
          defaultBranch: "main",
          mergeBaseBranch: "main",
          status: "ready",
          createdAt: 1,
          updatedAt: 1,
        },
        threads: [
          {
            id: "thr_test",
            title: "Connect session handoff",
            titleFallback: null,
            status: "active",
            hasPendingInteraction: true,
          },
        ],
        interaction: { pendingThreadCount: 1 },
        diff: {
          state: "resolved",
          value: {
            outcome: "not_applicable",
            reason: "non_git_environment",
            message: "Workspace diff is not applicable.",
          },
        },
        pullRequest: {
          state: "resolved",
          value: { outcome: "absent" },
        },
        sourceFreshness: {
          state: "resolved",
          value: {
            outcome: "available",
            sourceFreshness: {
              sourceBranch: "main",
              currentBranch: "feat/session-fabric",
              sourceSha: "a".repeat(40),
              headSha: "b".repeat(40),
              state: "up_to_date",
              aheadCount: 2,
              behindCount: 0,
              hasUncommittedChanges: false,
              gitOperation: "none",
            },
            autoUpdated: false,
            updateAction: { kind: "none" },
          },
        },
      },
    ],
    unassignedThreads: [],
    interaction: { pendingThreadCount: 1 },
  } as unknown as ProjectManagerProjectionResponse;
}

describe("ProjectManagerView", () => {
  afterEach(() => {
    cleanup();
    mockProjection.data = null;
  });

  it("renders transcript-free operational state", () => {
    mockProjection.data = makeProjection();

    render(
      <MemoryRouter initialEntries={["/projects/proj_test/manager"]}>
        <Routes>
          <Route
            path="/projects/:projectId/manager"
            element={<ProjectManagerView />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Agentic IDE" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Session Fabric" }),
    ).toBeTruthy();
    expect(screen.getByText("Connect session handoff")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("No pull request")).toBeTruthy();
    expect(
      screen.getByText("Operational state without conversation transcripts"),
    ).toBeTruthy();
    expect(screen.queryByText("raw transcript content")).toBeNull();
  });
});
