import { z } from "zod";

// The durable machine credential minted by pairing. On a bb server it lives in
// the connect plugin's kv storage (bb.db); the desktop app caches a copy so it
// can reach the connect gate without a local server.
// `handle` is the paired server's routing label (subdomain), which may differ
// from the account's primary handle when multiple bbs are connected.
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
