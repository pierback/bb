export type RuntimeProcessIdentityStatus = "alive" | "dead" | "unknown";

export interface RuntimeProcessProbe {
  getIdentityStatus(processId: number): RuntimeProcessIdentityStatus;
}

export const systemRuntimeProcessProbe: RuntimeProcessProbe = {
  getIdentityStatus(processId) {
    try {
      process.kill(processId, 0);
      return "alive";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return "dead";
      }
      return "unknown";
    }
  },
};
