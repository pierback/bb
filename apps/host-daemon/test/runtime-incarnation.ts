import type { AgentRuntimeProviderProcessIncarnation } from "@bb/agent-runtime";

export function testRuntimeIncarnation(
  providerId: string,
  discriminator: string,
): AgentRuntimeProviderProcessIncarnation {
  return Object.freeze({
    bootNonce: `boot_nonce_${discriminator}`,
    connectorId: `${providerId}-test-adapter`,
    endpointFingerprint: `stdio:${discriminator}`,
    processKey: `${providerId}\0test:${discriminator}`,
    providerId,
    runtimeInstanceId: `runtime_${discriminator}`,
    startedAt: 1_000,
  });
}
