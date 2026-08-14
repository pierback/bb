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
          isDevelopment: true,
          updatePolicy: "deployment-managed",
        }),
        isDevelopment: true,
      },
      async (harness) => {
        const response = await harness.app.request("/api/v1/system/version");
        expect(response.status).toBe(200);
        const body = (await readJson(response)) as SystemVersionResponse;
        expect(body.isDevelopment).toBe(true);
        expect(body.updatePolicy).toBe("deployment-managed");
      },
    );
  });

  it("rejects the removed force query instead of silently ignoring it", async () => {
    await withTestHarness(
      {
        appVersion: "0.0.5",
        appVersionService: createStubAppVersionService({
          currentVersion: "0.0.5",
          isDevelopment: false,
          updatePolicy: "deployment-managed",
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
