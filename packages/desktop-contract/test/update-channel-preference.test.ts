import { describe, expect, it } from "vitest";
import {
  parseBbMeshDesktopUpdateChannelPreference,
  serializeBbMeshDesktopUpdateChannelPreference,
} from "../src/update-channel-preference.js";

describe("BB Mesh desktop update channel preference", () => {
  it("round-trips the strict local preference contract", () => {
    const serialized = serializeBbMeshDesktopUpdateChannelPreference("canary");

    expect(parseBbMeshDesktopUpdateChannelPreference(serialized)).toBe(
      "canary",
    );
    expect(() =>
      parseBbMeshDesktopUpdateChannelPreference(
        '{"channel":"official","schemaVersion":1}',
      ),
    ).toThrow();
  });
});
