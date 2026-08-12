import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_SECRET_FAILURES = 8;
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000;
const REQUEST_ID_PREFIX = "bbnp_";
const REQUEST_SECRET_PREFIX = "bbns_";
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_LENGTH = 8;
const DUMMY_SECRET_DIGEST = createHash("sha256")
  .update("bb-native-pairing-dummy-secret", "utf8")
  .digest();

export type NativeClientPairingErrorCode =
  | "capacity_exceeded"
  | "expired"
  | "invalid_approval"
  | "invalid_request_secret";

export class NativeClientPairingError extends Error {
  constructor(readonly code: NativeClientPairingErrorCode) {
    super(code);
    this.name = "NativeClientPairingError";
  }
}

export interface NativeClientEnrollment {
  expiresAt: number;
  hostId: string;
  joinCode: string;
}

export interface NativeClientPairingRequest {
  expiresAt: number;
  requestId: string;
  requestSecret: string;
  userCode: string;
}

export interface NativeClientPairingApprovalView {
  deviceName: string;
  expiresAt: number;
  requestId: string;
  status: "approved" | "pending";
  userCode: string;
}

export type NativeClientPairingPollResult =
  | {
      expiresAt: number;
      status: "pending";
    }
  | (NativeClientEnrollment & {
      status: "approved";
    });

interface PendingPairing {
  approvalPromise: Promise<NativeClientEnrollment> | null;
  deviceName: string;
  enrollment: NativeClientEnrollment | null;
  failedSecretAttempts: number;
  requestExpiresAt: number;
  requestId: string;
  requestSecretDigest: Buffer;
  userCode: string;
}

export interface NativeClientPairingServiceOptions {
  issueEnrollment(): Promise<NativeClientEnrollment>;
  createRequestId?: () => string;
  createRequestSecret?: () => string;
  createUserCode?: () => string;
  maxPendingRequests?: number;
  maxSecretFailures?: number;
  now?: () => number;
  requestTtlMs?: number;
}

function randomToken(prefix: string, byteLength: number): string {
  return `${prefix}${randomBytes(byteLength).toString("base64url")}`;
}

function randomUserCode(): string {
  let value = "";
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    value += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function secretDigest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function secretsMatch(actual: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(secretDigest(actual), expectedDigest);
}

export class NativeClientPairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly createRequestId: () => string;
  private readonly createRequestSecret: () => string;
  private readonly createUserCode: () => string;
  private readonly maxPendingRequests: number;
  private readonly maxSecretFailures: number;
  private readonly now: () => number;
  private readonly requestTtlMs: number;

  constructor(private readonly options: NativeClientPairingServiceOptions) {
    this.createRequestId =
      options.createRequestId ?? (() => randomToken(REQUEST_ID_PREFIX, 18));
    this.createRequestSecret =
      options.createRequestSecret ??
      (() => randomToken(REQUEST_SECRET_PREFIX, 32));
    this.createUserCode = options.createUserCode ?? randomUserCode;
    this.maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.maxSecretFailures =
      options.maxSecretFailures ?? DEFAULT_MAX_SECRET_FAILURES;
    this.now = options.now ?? Date.now;
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  }

  create(deviceName: string): NativeClientPairingRequest {
    this.removeExpired();
    if (this.pending.size >= this.maxPendingRequests) {
      throw new NativeClientPairingError("capacity_exceeded");
    }

    let requestId = this.createRequestId();
    let collisionAttempts = 0;
    while (this.pending.has(requestId)) {
      collisionAttempts += 1;
      if (collisionAttempts >= 5) {
        throw new Error("Could not allocate a unique native pairing request");
      }
      requestId = this.createRequestId();
    }

    const requestSecret = this.createRequestSecret();
    const requestExpiresAt = this.now() + this.requestTtlMs;
    const pairing: PendingPairing = {
      approvalPromise: null,
      deviceName,
      enrollment: null,
      failedSecretAttempts: 0,
      requestExpiresAt,
      requestId,
      requestSecretDigest: secretDigest(requestSecret),
      userCode: this.createUserCode(),
    };
    this.pending.set(requestId, pairing);
    return {
      expiresAt: pairing.requestExpiresAt,
      requestId: pairing.requestId,
      requestSecret,
      userCode: pairing.userCode,
    };
  }

  inspect(args: {
    requestId: string;
    userCode: string;
  }): NativeClientPairingApprovalView {
    const pairing = this.requireApproval(args);
    return {
      deviceName: pairing.deviceName,
      expiresAt: pairing.enrollment?.expiresAt ?? pairing.requestExpiresAt,
      requestId: pairing.requestId,
      status: pairing.enrollment === null ? "pending" : "approved",
      userCode: pairing.userCode,
    };
  }

  async approve(args: {
    requestId: string;
    userCode: string;
  }): Promise<NativeClientPairingApprovalView> {
    const pairing = this.requireApproval(args);
    if (pairing.enrollment === null) {
      pairing.approvalPromise ??= this.options.issueEnrollment();
      try {
        pairing.enrollment = await pairing.approvalPromise;
      } catch (error) {
        pairing.approvalPromise = null;
        throw error;
      }
    }
    return this.inspect(args);
  }

  poll(args: {
    requestId: string;
    requestSecret: string;
  }): NativeClientPairingPollResult {
    const pairing = this.pending.get(args.requestId);
    const expectedDigest = pairing?.requestSecretDigest ?? DUMMY_SECRET_DIGEST;
    if (!secretsMatch(args.requestSecret, expectedDigest) || !pairing) {
      if (pairing) {
        pairing.failedSecretAttempts += 1;
        if (pairing.failedSecretAttempts >= this.maxSecretFailures) {
          this.pending.delete(pairing.requestId);
        }
      }
      throw new NativeClientPairingError("invalid_request_secret");
    }
    this.assertNotExpired(pairing);
    if (pairing.enrollment === null) {
      return {
        expiresAt: pairing.requestExpiresAt,
        status: "pending",
      };
    }
    return {
      ...pairing.enrollment,
      status: "approved",
    };
  }

  private requireApproval(args: {
    requestId: string;
    userCode: string;
  }): PendingPairing {
    const pairing = this.pending.get(args.requestId);
    if (!pairing || pairing.userCode !== args.userCode) {
      throw new NativeClientPairingError("invalid_approval");
    }
    this.assertNotExpired(pairing);
    return pairing;
  }

  private assertNotExpired(pairing: PendingPairing): void {
    const expiresAt = pairing.enrollment?.expiresAt ?? pairing.requestExpiresAt;
    if (expiresAt > this.now()) {
      return;
    }
    this.pending.delete(pairing.requestId);
    throw new NativeClientPairingError("expired");
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [requestId, pairing] of this.pending) {
      const expiresAt =
        pairing.enrollment?.expiresAt ?? pairing.requestExpiresAt;
      if (expiresAt <= now) {
        this.pending.delete(requestId);
      }
    }
  }
}
