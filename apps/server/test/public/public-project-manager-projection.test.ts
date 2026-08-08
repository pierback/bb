import { createPendingInteraction } from "@bb/db";
import { projectManagerProjectionResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public project manager projection", () => {
  it("groups operational state without exposing interaction payloads", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-manager-projection" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Manager Project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        workspaceProvisionType: "personal",
        branchName: null,
      });
      const environmentThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Environment work",
      });
      const unassignedThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Project planning",
      });
      createPendingInteraction(harness.db, {
        originKind: "plugin",
        pluginId: "secrets",
        rendererId: "secret-request",
        threadId: environmentThread.id,
        turnId: null,
        payload: JSON.stringify({ prompt: "raw transcript sentinel" }),
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/manager-projection`,
      );
      expect(response.status).toBe(200);
      const rawProjection = await readJson(response);
      const projection =
        projectManagerProjectionResponseSchema.parse(rawProjection);

      expect(projection.project.name).toBe("Manager Project");
      expect(projection.interaction.pendingThreadCount).toBe(1);
      expect(projection.environments).toHaveLength(1);
      expect(projection.environments[0]).toMatchObject({
        environment: { id: environment.id },
        interaction: { pendingThreadCount: 1 },
        threads: [{ id: environmentThread.id, hasPendingInteraction: true }],
        diff: {
          state: "resolved",
          value: { outcome: "not_applicable" },
        },
        pullRequest: {
          state: "resolved",
          value: { outcome: "absent" },
        },
        sourceFreshness: {
          state: "resolved",
          value: { outcome: "not_applicable" },
        },
      });
      expect(projection.unassignedThreads).toMatchObject([
        { id: unassignedThread.id, title: "Project planning" },
      ]);
      expect(JSON.stringify(rawProjection)).not.toContain(
        "raw transcript sentinel",
      );
    });
  });
});
