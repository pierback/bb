import { z } from "zod";

export const connectCredentialSchema = z.object({
  serverUrl: z.string().min(1),
  handle: z.string().min(1),
  credential: z.string().min(1),
});

export type ConnectCredential = z.infer<typeof connectCredentialSchema>;

/**
 * A client machine credential carries the gate identity that authenticated
 * requests must report when enrolling its execution host. Server pairing
 * credentials intentionally do not have a machine identity.
 */
export const connectMachineCredentialSchema = connectCredentialSchema.extend({
  machineId: z.string().min(1),
});

export type ConnectMachineCredential = z.infer<
  typeof connectMachineCredentialSchema
>;
