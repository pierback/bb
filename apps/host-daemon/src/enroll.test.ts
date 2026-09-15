import { expect, it, vi } from "vitest";
import { enrollDaemonHost } from "./enroll.js";

it("adds the typed Connect credential without putting Cloud identity in the enrollment body", async () => {
  const fetchFn = vi.fn<typeof fetch>(async () =>
    Response.json(
      { hostId: "host-test", hostKey: "durable-key" },
      { status: 201 },
    ),
  );

  await enrollDaemonHost({
    authentication: {
      credential: "bbcm_machine",
      kind: "connect",
      machineId: "machine-test",
    },
    fetchFn,
    hostId: "host-test",
    hostName: "test",
    serverUrl: "https://server.example",
    token: "bootstrap",
  });

  expect(fetchFn).toHaveBeenCalledWith(
    "https://server.example/internal/hosts/enroll",
    expect.objectContaining({
      headers: {
        authorization: "Bearer bootstrap",
        "content-type": "application/json",
        "x-bb-connect-machine": "bbcm_machine",
      },
      body: JSON.stringify({ hostId: "host-test", hostName: "test" }),
    }),
  );
});
