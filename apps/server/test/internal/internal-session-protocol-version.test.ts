import {
  HOST_DAEMON_PROTOCOL_VERSION,
  createHostDaemonClient,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { getHost, upsertHost } from "@bb/db";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

describe("internal session protocol version", () => {
  const networkIdentity = {
    hostname: "protocol-host.local",
    addresses: ["192.168.178.90"],
  };

  it("reports a protocol mismatch before enforcing current-only session fields", async () => {
    const server = await startTestServer();
    try {
      const hostKey = createTestDaemonHostKey({ hostId: "host-protocol" });
      upsertHost(server.db, server.hub, {
        id: "host-protocol",
        name: "Protocol Host",
        type: "persistent",
      });
      const daemonClient = createHostDaemonClient(server.baseUrl, hostKey);
      const staleProtocolVersion = HOST_DAEMON_PROTOCOL_VERSION - 1;
      const response = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-1",
          hostName: "Protocol Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
        },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: false,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        message: `Daemon protocol version ${staleProtocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
      });
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBe(staleProtocolVersion);
      await expect(
        fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
          result.json(),
        ),
      ).resolves.toMatchObject({
        lastRejectedProtocolVersion: staleProtocolVersion,
      });

      server.hub.requestHostProtocolUpdateRetry("host-protocol");
      const forcedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry",
          hostName: "Protocol Host",
          networkIdentity,
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
        },
      });
      expect(await forcedRetry.json()).toMatchObject({
        details: { retryUpdate: true },
      });

      const consumedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry-consumed",
          hostName: "Protocol Host",
          networkIdentity,
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
        },
      });
      expect(await consumedRetry.json()).toMatchObject({
        details: { retryUpdate: false },
      });

      const accepted = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-2",
          hostName: "Protocol Host",
          networkIdentity,
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(accepted.status).toBe(201);
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBeNull();
      await expect(
        fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
          result.json(),
        ),
      ).resolves.toMatchObject({ lastRejectedProtocolVersion: null });
    } finally {
      await server.close();
    }
  });

  it("requires network identity from the current daemon protocol", async () => {
    const server = await startTestServer();
    try {
      const hostKey = createTestDaemonHostKey({ hostId: "host-current" });
      upsertHost(server.db, server.hub, {
        id: "host-current",
        name: "Current Host",
        type: "persistent",
      });
      const daemonClient = createHostDaemonClient(server.baseUrl, hostKey);
      const response = await daemonClient.session.open.$post({
        json: {
          hostId: "host-current",
          instanceId: "instance-current",
          hostName: "Current Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-current-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: "networkIdentity is required for the current daemon protocol",
      });
    } finally {
      await server.close();
    }
  });
});
