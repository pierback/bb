import { describe, expect, it } from "vitest";
import { createAppVersionService } from "../../src/services/system/app-version.js";

describe("createAppVersionService", () => {
  it.each([
    { appVersion: "0.0.5", isDevelopment: true },
    { appVersion: "1.4.2", isDevelopment: false },
  ])("reports the coordinator as deployment-managed", async (config) => {
    const service = createAppVersionService({ config });

    await expect(service.getSystemVersion()).resolves.toEqual({
      currentVersion: config.appVersion,
      isDevelopment: config.isDevelopment,
      updatePolicy: "deployment-managed",
    });
  });
});
