import { z } from "zod";

// Fields shared by durable Connect credentials. A bb server stores this shape
// in the connect plugin's kv storage (bb.db). A desktop machine credential
// extends it below with the gate-assigned machine identity.
// `handle` is the paired server's routing label (subdomain), which may differ
// from the account's primary handle when multiple bbs are connected.
export const connectCredentialSchema = z.object({
  serverUrl: z.string().min(1),
  handle: z.string().min(1),
  credential: z.string().min(1),
});

export type ConnectCredential = z.infer<typeof connectCredentialSchema>;

export type ConnectPublicProtocol = "http:" | "https:";

/** Local Cloud is HTTP-only; every non-local Connect gate is HTTPS-only. */
export function connectPublicProtocol(
  baseDomain: string,
): ConnectPublicProtocol {
  const hostname = new URL(`https://${baseDomain}`).hostname;
  return hostname.endsWith(".localhost") ? "http:" : "https:";
}

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

/**
 * Derive the connect cloud apex (`https://getbb.app`) from a server URL
 * (`https://<handle>.getbb.app`) by dropping the handle label.
 */
export function deriveConnectBaseUrl(serverUrl: string): string {
  return new URL(serverUrl).origin.replace(/\/\/[^.]+\./, "//");
}

/**
 * `https://getbb.app` + routing label → `https://<label>.getbb.app`.
 * `handle` is the redeemed server's subdomain (primary or additional).
 */
export function serverUrlForHandle(baseUrl: string, handle: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${handle}.${url.host}`;
}
