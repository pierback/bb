import {
  BB_NATIVE_CLIENT_HEADER_NAME,
  BB_NATIVE_CLIENT_HEADER_VALUE,
} from "@bb/host-daemon-contract";
import {
  createNativeClientPairingResponseSchema,
  nativeClientPairingApprovalResponseSchema,
  nativeClientPairingPollResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1/native-client-pairings";
const NATIVE_HEADERS = {
  [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
  "content-type": "application/json",
};
const OWNER_HEADERS = { "x-bb-gate-auth": "session" };

describe("native client pairing routes", () => {
  it("rate-limits unauthenticated allocations before the shared pool fills", async () => {
    await withTestHarness(async (harness) => {
      for (let index = 0; index < 4; index += 1) {
        const response = await harness.app.request(API, {
          body: JSON.stringify({ deviceName: `Mac ${index + 1}` }),
          headers: NATIVE_HEADERS,
          method: "POST",
        });
        expect(response.status).toBe(201);
      }

      const rejected = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "Mac 5" }),
        headers: NATIVE_HEADERS,
        method: "POST",
      });
      expect(rejected.status).toBe(429);
      await expect(readJson(rejected)).resolves.toMatchObject({
        code: "native_pairing_rate_limited",
      });
    });
  });

  it("requires the native marker for request creation and polling", async () => {
    await withTestHarness(async (harness) => {
      const uncredentialedNativeRequest = await harness.app.request("/health", {
        headers: NATIVE_HEADERS,
      });
      expect(uncredentialedNativeRequest.status).toBe(401);

      const mixedCredentialRequest = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "This Mac" }),
        headers: {
          ...NATIVE_HEADERS,
          "x-bb-connect-machine": "must-not-mix-auth-modes",
        },
        method: "POST",
      });
      expect(mixedCredentialRequest.status).toBe(401);

      const unmarked = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "This Mac" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unmarked.status).toBe(403);

      const createdResponse = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "  This Mac  " }),
        headers: NATIVE_HEADERS,
        method: "POST",
      });
      expect(createdResponse.status).toBe(201);
      const created = createNativeClientPairingResponseSchema.parse(
        await readJson(createdResponse),
      );

      const unmarkedPoll = await harness.app.request(
        `${API}/${created.requestId}/poll`,
        {
          body: JSON.stringify({ requestSecret: created.requestSecret }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(unmarkedPoll.status).toBe(403);

      const pendingResponse = await harness.app.request(
        `${API}/${created.requestId}/poll`,
        {
          body: JSON.stringify({ requestSecret: created.requestSecret }),
          headers: NATIVE_HEADERS,
          method: "POST",
        },
      );
      expect(pendingResponse.status).toBe(200);
      expect(
        nativeClientPairingPollResponseSchema.parse(
          await readJson(pendingResponse),
        ),
      ).toMatchObject({ status: "pending" });
    });
  });

  it("lets an owner approve once, then returns an enrollable host token to the requesting Mac", async () => {
    await withTestHarness(async (harness) => {
      const createdResponse = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "Ferdinand's Mac" }),
        headers: NATIVE_HEADERS,
        method: "POST",
      });
      const created = createNativeClientPairingResponseSchema.parse(
        await readJson(createdResponse),
      );

      const nativeApproval = await harness.app.request(
        `${API}/${created.requestId}/approve`,
        {
          body: JSON.stringify({ code: created.userCode }),
          headers: NATIVE_HEADERS,
          method: "POST",
        },
      );
      expect(nativeApproval.status).toBe(401);

      const inspectResponse = await harness.app.request(
        `${API}/${created.requestId}?code=${encodeURIComponent(created.userCode)}`,
        { headers: OWNER_HEADERS },
      );
      expect(inspectResponse.status).toBe(200);
      expect(
        nativeClientPairingApprovalResponseSchema.parse(
          await readJson(inspectResponse),
        ),
      ).toMatchObject({
        deviceName: "Ferdinand's Mac",
        status: "pending",
        userCode: created.userCode,
      });

      const approveResponse = await harness.app.request(
        `${API}/${created.requestId}/approve`,
        {
          body: JSON.stringify({ code: created.userCode }),
          headers: {
            "content-type": "application/json",
            ...OWNER_HEADERS,
          },
          method: "POST",
        },
      );
      expect(approveResponse.status).toBe(200);
      expect(
        nativeClientPairingApprovalResponseSchema.parse(
          await readJson(approveResponse),
        ),
      ).toMatchObject({ status: "approved" });

      const pollResponse = await harness.app.request(
        `${API}/${created.requestId}/poll`,
        {
          body: JSON.stringify({ requestSecret: created.requestSecret }),
          headers: NATIVE_HEADERS,
          method: "POST",
        },
      );
      const poll = nativeClientPairingPollResponseSchema.parse(
        await readJson(pollResponse),
      );
      expect(poll.status).toBe("approved");
      if (poll.status !== "approved") return;

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          body: JSON.stringify({
            hostId: poll.hostId,
            hostName: "Ferdinand's Mac",
            hostType: "persistent",
          }),
          headers: {
            authorization: `Bearer ${poll.joinCode}`,
            "content-type": "application/json",
            [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
          },
          method: "POST",
        },
      );
      expect(enrollResponse.status).toBe(201);
      const enrolled = (await readJson(enrollResponse)) as {
        hostId: string;
        hostKey: string;
      };
      expect(enrolled).toMatchObject({
        hostId: poll.hostId,
        hostKey: expect.stringMatching(/^bbdh_/u),
      });

      const authenticatedNativeRequest = await harness.app.request("/health", {
        headers: {
          authorization: `Bearer ${enrolled.hostKey}`,
          [BB_NATIVE_CLIENT_HEADER_NAME]: BB_NATIVE_CLIENT_HEADER_VALUE,
        },
      });
      expect(authenticatedNativeRequest.status).toBe(200);
    });
  });

  it("does not reveal a request to wrong approval codes or poll secrets", async () => {
    await withTestHarness(async (harness) => {
      const createdResponse = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "This Mac" }),
        headers: NATIVE_HEADERS,
        method: "POST",
      });
      const created = createNativeClientPairingResponseSchema.parse(
        await readJson(createdResponse),
      );

      const wrongCode = await harness.app.request(
        `${API}/${created.requestId}?code=WRONG-CODE`,
        { headers: OWNER_HEADERS },
      );
      expect(wrongCode.status).toBe(404);

      const wrongSecret = await harness.app.request(
        `${API}/${created.requestId}/poll`,
        {
          body: JSON.stringify({ requestSecret: "wrong-secret" }),
          headers: NATIVE_HEADERS,
          method: "POST",
        },
      );
      expect(wrongSecret.status).toBe(401);
      expect(await readJson(wrongSecret)).toEqual({
        code: "unauthorized",
        message: "Unauthorized",
      });
    });
  });

  it("requires an Authelia session or trusted loopback CLI for owner operations", async () => {
    await withTestHarness(async (harness) => {
      const createdResponse = await harness.app.request(API, {
        body: JSON.stringify({ deviceName: "This Mac" }),
        headers: NATIVE_HEADERS,
        method: "POST",
      });
      const created = createNativeClientPairingResponseSchema.parse(
        await readJson(createdResponse),
      );

      const inspectResponse = await harness.app.request(
        `${API}/${created.requestId}?code=${encodeURIComponent(created.userCode)}`,
      );
      expect(inspectResponse.status).toBe(403);
      expect(await readJson(inspectResponse)).toMatchObject({
        code: "native_pairing_approval_forbidden",
      });

      const approveResponse = await harness.app.request(
        `${API}/${created.requestId}/approve`,
        {
          body: JSON.stringify({ code: created.userCode }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(approveResponse.status).toBe(403);
    });
  });
});
