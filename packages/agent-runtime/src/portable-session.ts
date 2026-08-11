export interface PortableSessionAdapterExportArtifact {
  adapterPath: string;
  sourcePath: string;
}

export interface PortableSessionAdapter {
  cleanupImport(token: string): Promise<void>;
  exportSessions(providerThreadIds: readonly string[]): Promise<{
    artifacts: PortableSessionAdapterExportArtifact[];
    missingProviderThreadIds: string[];
  }>;
  importArtifact(args: {
    adapterPath: string;
    expectedSha256: string;
    mode: number;
    registerCleanup: (token: string) => Promise<void>;
    sourcePath: string;
  }): Promise<{ outcome: "already_present" | "conflict" | "installed" }>;
}

export interface PortableSessionArtifact {
  portablePath: string;
  sourcePath: string;
}

export interface PortableSessionImportReceipt {
  providerId: string;
  token: string;
}

export type PortableSessionExportResult =
  | {
      availability: "supported";
      artifacts: PortableSessionArtifact[];
      missingProviderThreadIds: string[];
      providerId: string;
    }
  | {
      availability: "unsupported";
      providerId: string;
    };

export type PortableSessionImportResult =
  | {
      availability: "supported";
      outcome: "already_present" | "installed";
      providerId: string;
    }
  | {
      availability: "supported";
      outcome: "conflict";
      providerId: string;
    }
  | {
      availability: "unsupported";
      providerId: string;
    };

export type PortableSessionCleanupResult =
  | { availability: "supported"; providerId: string }
  | { availability: "unsupported"; providerId: string };

export interface PortableSessionPort {
  cleanupImport(
    receipt: PortableSessionImportReceipt,
  ): Promise<PortableSessionCleanupResult>;
  exportSessions(args: {
    providerId: string;
    providerThreadIds: readonly string[];
  }): Promise<PortableSessionExportResult>;
  importArtifact(args: {
    expectedSha256: string;
    mode: number;
    portablePath: string;
    registerCleanup: (receipt: PortableSessionImportReceipt) => Promise<void>;
    sourcePath: string;
  }): Promise<PortableSessionImportResult>;
}

export interface CreatePortableSessionPortArgs {
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
}
