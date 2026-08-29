import type { SystemVersionResponse } from "@bb/server-contract";
import type { ServerRuntimeConfig } from "../../types.js";

export interface AppVersionService {
  getSystemVersion(): Promise<SystemVersionResponse>;
}

export interface CreateAppVersionServiceArgs {
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
}

/**
 * The coordinator is released as part of the BB Mesh deployment. It must
 * never consult npm or suggest an upstream bb-app command: doing so could
 * replace the fork independently of the signed desktop release train.
 */
export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  return {
    async getSystemVersion(): Promise<SystemVersionResponse> {
      return {
        currentVersion: args.config.appVersion,
        isDevelopment: args.config.isDevelopment,
        updatePolicy: "deployment-managed",
      };
    },
  };
}
