import { describe, expect, it } from "vitest";
import { pluginSdkAliasFor } from "../../../src/services/plugins/plugin-runtime.js";

describe("pluginSdkAliasFor", () => {
  it("resolves the canonical SDK specifier to the host runtime bundle", () => {
    const alias = pluginSdkAliasFor("/srv/plugin-sdk-runtime.js");

    expect(alias).toEqual({
      "@get-bb/plugin-sdk": "/srv/plugin-sdk-runtime.js",
    });
  });
});
