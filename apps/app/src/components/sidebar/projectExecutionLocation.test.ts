import { describe, expect, it } from "vitest";
import type { Host, ProjectSource } from "@bb/domain";
import { resolveProjectExecutionLocation } from "./projectExecutionLocation";

function makeHost(overrides: Partial<Host>): Host {
  return {
    id: "host_local",
    name: "Fabian's MacBook Pro",
    type: "persistent",
    status: "connected",
    maxPermissionMode: "full",
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeSource(
  hostId: string,
  isDefault: boolean,
  id = `source_${hostId}`,
): ProjectSource {
  return {
    id,
    projectId: "proj_test",
    type: "local_path",
    hostId,
    path: `/projects/${hostId}`,
    isDefault,
    createdAt: 1,
    updatedAt: 1,
  };
}

const localHost = makeHost({});
const nasHost = makeHost({
  id: "host_nas",
  name: "pierback-nas",
});

describe("resolveProjectExecutionLocation", () => {
  it("calls the reachable local execution host This Mac", () => {
    expect(
      resolveProjectExecutionLocation({
        hosts: [localHost, nasHost],
        localDaemonHostId: localHost.id,
        preferredHostId: localHost.id,
        sources: [makeSource(localHost.id, true)],
      }),
    ).toEqual({
      label: "This Mac",
      title: "Project runs on This Mac",
      connected: true,
      machineName: "Fabian's MacBook Pro",
      path: "/projects/host_local",
    });
  });

  it("shows the configured remote machine when the project only exists there", () => {
    expect(
      resolveProjectExecutionLocation({
        hosts: [localHost, nasHost],
        localDaemonHostId: localHost.id,
        preferredHostId: localHost.id,
        sources: [makeSource(nasHost.id, true)],
      }),
    ).toEqual({
      label: "pierback-nas",
      title: "Project runs on pierback-nas",
      connected: true,
      machineName: "pierback-nas",
      path: "/projects/host_nas",
    });
  });

  it("summarizes additional machines while keeping this desktop's execution host first", () => {
    expect(
      resolveProjectExecutionLocation({
        hosts: [localHost, nasHost],
        localDaemonHostId: localHost.id,
        preferredHostId: localHost.id,
        sources: [
          makeSource(nasHost.id, true),
          makeSource(localHost.id, false),
        ],
      }),
    ).toEqual({
      label: "This Mac +1",
      title:
        "Project can run on This Mac, pierback-nas. New threads default to This Mac.",
      connected: true,
      machineName: "Fabian's MacBook Pro",
      path: "/projects/host_local",
    });
  });

  it("does not invent a location for a project without a configured source", () => {
    expect(
      resolveProjectExecutionLocation({
        hosts: [localHost, nasHost],
        localDaemonHostId: localHost.id,
        preferredHostId: localHost.id,
        sources: [],
      }),
    ).toBeNull();
  });
});
