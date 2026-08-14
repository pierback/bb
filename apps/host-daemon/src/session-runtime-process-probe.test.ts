import { afterEach, describe, expect, it, vi } from "vitest";
import { systemRuntimeProcessProbe } from "./session-runtime-process-probe.js";

describe("systemRuntimeProcessProbe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a signal probe into alive, dead, and fail-closed unknown states", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockReturnValueOnce(true);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("forbidden"), { code: "EPERM" });
    });

    expect(systemRuntimeProcessProbe.getIdentityStatus(101)).toBe("alive");
    expect(systemRuntimeProcessProbe.getIdentityStatus(102)).toBe("dead");
    expect(systemRuntimeProcessProbe.getIdentityStatus(103)).toBe("unknown");
  });
});
