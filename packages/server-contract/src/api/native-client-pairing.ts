import { z } from "zod";

export const NATIVE_CLIENT_PAIRING_POLL_INTERVAL_MS = 2_000;

const DEVICE_NAME_MAX_LENGTH = 100;
const REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_SECRET_MAX_LENGTH = 128;
const USER_CODE_MAX_LENGTH = 32;

export const createNativeClientPairingRequestSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH),
  })
  .strict();
export type CreateNativeClientPairingRequest = z.infer<
  typeof createNativeClientPairingRequestSchema
>;

export const createNativeClientPairingResponseSchema = z
  .object({
    expiresAt: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
    requestId: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
    requestSecret: z.string().min(1).max(REQUEST_SECRET_MAX_LENGTH),
    userCode: z.string().min(1).max(USER_CODE_MAX_LENGTH),
  })
  .strict();
export type CreateNativeClientPairingResponse = z.infer<
  typeof createNativeClientPairingResponseSchema
>;

export const nativeClientPairingApprovalQuerySchema = z
  .object({
    code: z.string().min(1).max(USER_CODE_MAX_LENGTH),
  })
  .strict();
export type NativeClientPairingApprovalQuery = z.infer<
  typeof nativeClientPairingApprovalQuerySchema
>;

export const approveNativeClientPairingRequestSchema = z
  .object({
    code: z.string().min(1).max(USER_CODE_MAX_LENGTH),
  })
  .strict();
export type ApproveNativeClientPairingRequest = z.infer<
  typeof approveNativeClientPairingRequestSchema
>;

export const nativeClientPairingApprovalResponseSchema = z
  .object({
    deviceName: z.string().min(1).max(DEVICE_NAME_MAX_LENGTH),
    expiresAt: z.number().int().positive(),
    requestId: z.string().min(1).max(REQUEST_ID_MAX_LENGTH),
    status: z.enum(["approved", "pending"]),
    userCode: z.string().min(1).max(USER_CODE_MAX_LENGTH),
  })
  .strict();
export type NativeClientPairingApprovalResponse = z.infer<
  typeof nativeClientPairingApprovalResponseSchema
>;

export const pollNativeClientPairingRequestSchema = z
  .object({
    requestSecret: z.string().min(1).max(REQUEST_SECRET_MAX_LENGTH),
  })
  .strict();
export type PollNativeClientPairingRequest = z.infer<
  typeof pollNativeClientPairingRequestSchema
>;

export const nativeClientPairingPollResponseSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        expiresAt: z.number().int().positive(),
        status: z.literal("pending"),
      })
      .strict(),
    z
      .object({
        expiresAt: z.number().int().positive(),
        hostId: z.string().min(1),
        joinCode: z.string().min(1),
        status: z.literal("approved"),
      })
      .strict(),
  ],
);
export type NativeClientPairingPollResponse = z.infer<
  typeof nativeClientPairingPollResponseSchema
>;
