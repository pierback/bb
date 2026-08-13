import {
  environmentThreadTabsResponseSchema,
  type EnvironmentThreadTabsResponse,
} from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function getTabs(
  harness: TestAppHarness,
  environmentId: string,
): Promise<Response> {
  return harness.app.request(
    `/api/v1/environments/${environmentId}/thread-tabs`,
  );
}

async function putTabs(
  harness: TestAppHarness,
  environmentId: string,
  body: EnvironmentThreadTabsResponse,
): Promise<Response> {
  return harness.app.request(
    `/api/v1/environments/${environmentId}/thread-tabs`,
    {
      body: JSON.stringify({
        expectedRevision: body.revision,
        threadIds: body.threadIds,
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
}

describe("public environment thread tabs", () => {
  it("stores ordered tabs, notifies clients, and rejects stale writes", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, thread } = seedThreadFixture(harness);
      const secondThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        title: "Second tab",
      });
      const notifyEnvironment = vi.spyOn(harness.hub, "notifyEnvironment");

      const initial = environmentThreadTabsResponseSchema.parse(
        await readJson(await getTabs(harness, environment.id)),
      );
      expect(initial).toEqual({ revision: 0, threadIds: [] });

      const updateResponse = await putTabs(harness, environment.id, {
        revision: 0,
        threadIds: [secondThread.id, thread.id],
      });
      expect(updateResponse.status).toBe(200);
      expect(
        environmentThreadTabsResponseSchema.parse(
          await readJson(updateResponse),
        ),
      ).toEqual({ revision: 1, threadIds: [secondThread.id, thread.id] });
      expect(notifyEnvironment).toHaveBeenCalledWith(environment.id, [
        "thread-tabs-changed",
      ]);

      const staleResponse = await putTabs(harness, environment.id, {
        revision: 0,
        threadIds: [],
      });
      expect(staleResponse.status).toBe(409);
      expect(await readJson(staleResponse)).toEqual({
        code: "environment_thread_tabs_conflict",
        details: { currentRevision: 1 },
        message: "Worktree thread tabs changed on another client",
      });
      expect(notifyEnvironment).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects duplicates and threads from another environment", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, project, thread } = seedThreadFixture(harness);
      const otherEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/other-tabs-environment",
        projectId: project.id,
      });
      const foreignThread = seedThread(harness.deps, {
        environmentId: otherEnvironment.id,
        projectId: project.id,
      });

      expect(
        (
          await putTabs(harness, environment.id, {
            revision: 0,
            threadIds: [thread.id, thread.id],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await putTabs(harness, environment.id, {
            revision: 0,
            threadIds: [foreignThread.id],
          })
        ).status,
      ).toBe(400);
      expect((await getTabs(harness, "env_missing")).status).toBe(404);
    });
  });
});
