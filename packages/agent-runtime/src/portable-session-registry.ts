import { createCodexPortableSessionAdapter } from "./codex/portable-session.js";
import type {
  CreatePortableSessionPortArgs,
  PortableSessionAdapter,
  PortableSessionCleanupResult,
  PortableSessionExportResult,
  PortableSessionImportReceipt,
  PortableSessionImportResult,
  PortableSessionPort,
} from "./portable-session.js";

interface DecodedPortablePath {
  adapterPath: string;
  providerId: string;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function encodePortablePath(providerId: string, adapterPath: string): string {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`Invalid portable-session provider id: ${providerId}`);
  }
  return `${providerId}/${adapterPath}`;
}

function decodePortablePath(portablePath: string): DecodedPortablePath {
  const separatorIndex = portablePath.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === portablePath.length - 1) {
    throw new Error(`Invalid portable-session path: ${portablePath}`);
  }
  const providerId = portablePath.slice(0, separatorIndex);
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`Invalid portable-session provider id: ${providerId}`);
  }
  return {
    adapterPath: portablePath.slice(separatorIndex + 1),
    providerId,
  };
}

function createAdapter(
  providerId: string,
  args: CreatePortableSessionPortArgs,
): PortableSessionAdapter | null {
  if (providerId !== "codex") {
    return null;
  }
  return createCodexPortableSessionAdapter(args);
}

export function createPortableSessionPort(
  args: CreatePortableSessionPortArgs,
): PortableSessionPort {
  return {
    async cleanupImport(
      receipt: PortableSessionImportReceipt,
    ): Promise<PortableSessionCleanupResult> {
      const adapter = createAdapter(receipt.providerId, args);
      if (!adapter) {
        return {
          availability: "unsupported",
          providerId: receipt.providerId,
        };
      }
      await adapter.cleanupImport(receipt.token);
      return { availability: "supported", providerId: receipt.providerId };
    },

    async exportSessions(exportArgs): Promise<PortableSessionExportResult> {
      const adapter = createAdapter(exportArgs.providerId, args);
      if (!adapter) {
        return {
          availability: "unsupported",
          providerId: exportArgs.providerId,
        };
      }
      const result = await adapter.exportSessions(exportArgs.providerThreadIds);
      return {
        availability: "supported",
        artifacts: result.artifacts.map((artifact) => ({
          portablePath: encodePortablePath(
            exportArgs.providerId,
            artifact.adapterPath,
          ),
          sourcePath: artifact.sourcePath,
        })),
        missingProviderThreadIds: result.missingProviderThreadIds,
        providerId: exportArgs.providerId,
      };
    },

    async importArtifact(importArgs): Promise<PortableSessionImportResult> {
      const decoded = decodePortablePath(importArgs.portablePath);
      const adapter = createAdapter(decoded.providerId, args);
      if (!adapter) {
        return {
          availability: "unsupported",
          providerId: decoded.providerId,
        };
      }
      const result = await adapter.importArtifact({
        adapterPath: decoded.adapterPath,
        expectedSha256: importArgs.expectedSha256,
        mode: importArgs.mode,
        registerCleanup: async (token) => {
          await importArgs.registerCleanup({
            providerId: decoded.providerId,
            token,
          });
        },
        sourcePath: importArgs.sourcePath,
      });
      return {
        availability: "supported",
        outcome: result.outcome,
        providerId: decoded.providerId,
      };
    },
  };
}
