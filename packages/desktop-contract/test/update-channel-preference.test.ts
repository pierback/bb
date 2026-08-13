import { describe, expect, it } from "vitest";
import {
  parsePierbackDesktopUpdateChannelPreference,
  serializePierbackDesktopUpdateChannelPreference,
} from "../src/update-channel-preference.js";

describe("Pierback desktop update channel preference", () => {
  it("round-trips the strict local preference contract", () => {
    const serialized =
      serializePierbackDesktopUpdateChannelPreference("canary");

    expect(parsePierbackDesktopUpdateChannelPreference(serialized)).toBe(
      "canary",
    );
    expect(() =>
      parsePierbackDesktopUpdateChannelPreference(
        '{"channel":"official","schemaVersion":1}',
      ),
    ).toThrow();
  });
});
