import { describe, expect, it } from "vitest";
import { resolveEnvironmentSourceFreshnessState } from "../src/environment-source-freshness.js";

describe("resolveEnvironmentSourceFreshnessState", () => {
  it.each([
    { aheadCount: 0, behindCount: 0, expected: "up_to_date" },
    { aheadCount: 2, behindCount: 0, expected: "ahead" },
    { aheadCount: 0, behindCount: 3, expected: "behind" },
    { aheadCount: 2, behindCount: 3, expected: "diverged" },
  ] as const)(
    "resolves $aheadCount ahead and $behindCount behind as $expected",
    ({ aheadCount, behindCount, expected }) => {
      expect(
        resolveEnvironmentSourceFreshnessState({ aheadCount, behindCount }),
      ).toBe(expected);
    },
  );
});
