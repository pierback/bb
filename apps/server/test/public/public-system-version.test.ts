import { describe, expect, it } from "vitest";
import type { SystemVersionResponse } from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

function createStubAppVersionService(response: SystemVersionResponse) {
  return {
    async getSystemVersion(): Promise<SystemVersionResponse> {
      return response;
    },
  };
}

describe("GET /api/v1/system/version", () => {
  it("reports the deployment-managed coordinator policy", async () => {
    await withTestHarness(
      {
        appVersion: "0.0.5",
        appVersionService: createStubAppVersionService({
          currentVersion: "0.0.5",
          latestVersion: null,
          source: "npm",
          updateAvailable: false,
          isDevelopment: true,
          upgradeCommand: "Managed by the BB Mesh release train",
        }),
        isDevelopment: true,
      },
      async (harness) => {
        const response = await harness.app.request("/api/v1/system/version");
        expect(response.status).toBe(200);
        const body = (await readJson(response)) as SystemVersionResponse;
        expect(body).toEqual({
          currentVersion: "0.0.5",
          latestVersion: null,
          source: "npm",
          updateAvailable: false,
          isDevelopment: true,
          upgradeCommand: "Managed by the BB Mesh release train",
        });
      },
    );
  });

  it("rejects the removed force query instead of silently ignoring it", async () => {
    await withTestHarness(
      {
        appVersion: "0.0.5",
        appVersionService: createStubAppVersionService({
          currentVersion: "0.0.5",
          latestVersion: null,
          source: "npm",
          updateAvailable: false,
          isDevelopment: false,
          upgradeCommand: "Managed by the BB Mesh release train",
        }),
        isDevelopment: false,
      },
      async (harness) => {
        const response = await harness.app.request(
          "/api/v1/system/version?force=true",
        );
        expect(response.status).toBe(400);
      },
    );
  });
});
