import { z } from "zod";

export const bbDesktopMachineAddressRequestSchema = z
  .object({ hostname: z.string().trim().min(1).max(253) })
  .strict();
export type BbDesktopMachineAddressRequest = z.infer<
  typeof bbDesktopMachineAddressRequestSchema
>;

export const bbDesktopMachineAddressResponseSchema = z
  .object({
    addresses: z.array(z.string().min(1)),
    resolvedHostname: z.string().min(1).nullable(),
  })
  .strict();
export type BbDesktopMachineAddressResponse = z.infer<
  typeof bbDesktopMachineAddressResponseSchema
>;

/** Desktop-only OS name resolution used by machine details in the renderer. */
export interface BbDesktopNetworkApi {
  resolveMachineAddresses(
    request: BbDesktopMachineAddressRequest,
  ): Promise<BbDesktopMachineAddressResponse>;
}
