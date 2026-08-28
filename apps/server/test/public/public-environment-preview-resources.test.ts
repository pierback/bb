import {
  environmentPreviewResourcesResponseSchema,
  type EnvironmentPreviewResourcesResponse,
} from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function resourceUrl(environmentId: string): string {
  return `/api/v1/environments/${environmentId}/preview-resources`;
}

describe("public environment preview resources", () => {
  it("persists, selects, and removes previews with realtime CAS semantics", async () => {
    await withTestHarness(async (harness) => {
      const { environment } = seedThreadFixture(harness);
      const notifyEnvironment = vi.spyOn(harness.hub, "notifyEnvironment");

      const initialResponse = await harness.app.request(
        resourceUrl(environment.id),
      );
      expect(initialResponse.status).toBe(200);
      const initial = environmentPreviewResourcesResponseSchema.parse(
        await readJson(initialResponse),
      );
      expect(initial).toEqual({
        previewResources: [],
        revision: 0,
        selectedPreviewResourceId: null,
      });

      const createResponse = await harness.app.request(
        resourceUrl(environment.id),
        {
          body: JSON.stringify({
            expectedRevision: 0,
            kind: "remote_novnc",
            label: "Remote desktop",
            url: "https://preview.example.test/vnc.html",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(createResponse.status).toBe(201);
      const created = environmentPreviewResourcesResponseSchema.parse(
        await readJson(createResponse),
      );
      expect(created.revision).toBe(1);
      expect(created.previewResources).toHaveLength(1);
      expect(created.previewResources[0]).toMatchObject({
        kind: "remote_novnc",
        label: "Remote desktop",
        url: "https://preview.example.test/vnc.html",
      });
      const resourceId = created.previewResources[0]?.id;
      expect(resourceId).toBeTruthy();

      const selectResponse = await harness.app.request(
        `${resourceUrl(environment.id)}/selection`,
        {
          body: JSON.stringify({
            expectedRevision: 1,
            selectedPreviewResourceId: resourceId,
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      expect(selectResponse.status).toBe(200);
      const selected = environmentPreviewResourcesResponseSchema.parse(
        await readJson(selectResponse),
      );
      expect(selected).toMatchObject({
        revision: 2,
        selectedPreviewResourceId: resourceId,
      });

      const removeResponse = await harness.app.request(
        `${resourceUrl(environment.id)}/${resourceId}`,
        {
          body: JSON.stringify({ expectedRevision: 2 }),
          headers: { "content-type": "application/json" },
          method: "DELETE",
        },
      );
      expect(removeResponse.status).toBe(200);
      expect(
        environmentPreviewResourcesResponseSchema.parse(
          await readJson(removeResponse),
        ),
      ).toEqual({
        previewResources: [],
        revision: 3,
        selectedPreviewResourceId: null,
      });

      const staleResponse = await harness.app.request(
        resourceUrl(environment.id),
        {
          body: JSON.stringify({
            expectedRevision: 0,
            kind: "local_browser",
            label: "Stale local app",
            url: "http://127.0.0.1:4000",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(staleResponse.status).toBe(409);
      expect(await readJson(staleResponse)).toEqual({
        code: "environment_preview_resources_conflict",
        details: { currentRevision: 3 },
        message: "Environment preview resources changed on another client",
      });
      expect(notifyEnvironment).toHaveBeenCalledTimes(3);
      expect(notifyEnvironment).toHaveBeenLastCalledWith(environment.id, [
        "preview-resources-changed",
      ]);
    });
  });

  it("rejects unsafe preview URLs and unknown selections", async () => {
    await withTestHarness(async (harness) => {
      const { environment } = seedThreadFixture(harness);
      const unsafeResponse = await harness.app.request(
        resourceUrl(environment.id),
        {
          body: JSON.stringify({
            expectedRevision: 0,
            kind: "local_browser",
            label: "Unsafe",
            url: "javascript:alert(1)",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(unsafeResponse.status).toBe(400);

      const selection: EnvironmentPreviewResourcesResponse = {
        previewResources: [],
        revision: 0,
        selectedPreviewResourceId: null,
      };
      const missingResponse = await harness.app.request(
        `${resourceUrl(environment.id)}/selection`,
        {
          body: JSON.stringify({
            expectedRevision: selection.revision,
            selectedPreviewResourceId: "epr_missing",
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      expect(missingResponse.status).toBe(404);
    });
  });
});
