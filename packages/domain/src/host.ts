import { z } from "zod";
import { permissionModeSchema } from "./shared-types.js";

export const hostTypeValues = ["persistent"] as const;
export const hostTypeSchema = z.enum(hostTypeValues);
export type HostType = z.infer<typeof hostTypeSchema>;

export const hostStatusValues = ["connected", "disconnected"] as const;
export const hostStatusSchema = z.enum(hostStatusValues);

function isLoopbackNetworkAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const ipv4 = normalized.slice(normalized.lastIndexOf(":") + 1);
    return ipv4.startsWith("127.");
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return false;
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const zeroFill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(zeroFill).fill("0"), ...right];
  return (
    groups.length === 8 &&
    groups.slice(0, 7).every((group) => Number.parseInt(group, 16) === 0) &&
    Number.parseInt(groups[7]!, 16) === 1
  );
}

export const hostNetworkAddressSchema = z
  .union([z.ipv4(), z.ipv6()])
  .refine((address) => !isLoopbackNetworkAddress(address), {
    message: "Host network addresses must not be loopback addresses",
  });

/** OS network identity reported for the lifetime of a connected daemon session. */
export const hostNetworkIdentitySchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[^\s/?#]+$/u),
    addresses: z
      .array(hostNetworkAddressSchema)
      .max(64)
      .refine((addresses) => new Set(addresses).size === addresses.length, {
        message: "Host network addresses must be unique",
      }),
  })
  .strict();
export type HostNetworkIdentity = z.infer<typeof hostNetworkIdentitySchema>;

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: hostTypeSchema,
  status: hostStatusSchema,
  /** Current OS hostname and non-loopback addresses; null while disconnected. */
  networkIdentity: hostNetworkIdentitySchema.nullable(),
  /**
   * Permission ceiling for work that runs on this machine. Threads resolve
   * down to this mode, so a sandbox machine can stay at "full" while a
   * personal laptop refuses to go above "accept-edits". Only an owner session
   * changes it; machine credentials cannot (see the hosts routes).
   */
  maxPermissionMode: permissionModeSchema,
  lastSeenAt: z.number().nullable(),
  lastRejectedProtocolVersion: z.number().int().positive().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
