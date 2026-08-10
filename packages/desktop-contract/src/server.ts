import { z } from "zod";

export const bbDesktopServerKindSchema = z.enum([
  "builtin",
  "connect",
  "custom",
]);
export type BbDesktopServerKind = z.infer<typeof bbDesktopServerKindSchema>;

const desktopServerOptionBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

export const bbDesktopServerOptionSchema = z.discriminatedUnion("kind", [
  desktopServerOptionBaseSchema.extend({ kind: z.literal("builtin") }).strict(),
  desktopServerOptionBaseSchema
    .extend({
      handle: z.string().min(1),
      kind: z.literal("connect"),
    })
    .strict(),
  desktopServerOptionBaseSchema.extend({ kind: z.literal("custom") }).strict(),
]);
export type BbDesktopServerOption = z.infer<typeof bbDesktopServerOptionSchema>;

export const bbDesktopExecutionHostStateSchema = z
  .object({
    error: z.string().min(1).nullable(),
    hostId: z.string().min(1).nullable(),
    port: z.number().int().min(1).max(65_535).nullable(),
    serverUrl: z.string().min(1),
    status: z.enum(["starting", "connected", "error"]),
  })
  .strict();
export type BbDesktopExecutionHostState = z.infer<
  typeof bbDesktopExecutionHostStateSchema
>;

export const bbDesktopServerStateSchema = z
  .object({
    activeServerId: z.string().min(1),
    executionHost: bbDesktopExecutionHostStateSchema.nullable(),
    servers: z.array(bbDesktopServerOptionSchema).min(1),
  })
  .strict()
  .superRefine((state, context) => {
    if (!state.servers.some((server) => server.id === state.activeServerId)) {
      context.addIssue({
        code: "custom",
        message: "The active server must be present in the server list.",
        path: ["activeServerId"],
      });
    }
  });
export type BbDesktopServerState = z.infer<typeof bbDesktopServerStateSchema>;

export const bbDesktopSelectServerRequestSchema = z
  .object({ serverId: z.string().min(1) })
  .strict();
export type BbDesktopSelectServerRequest = z.infer<
  typeof bbDesktopSelectServerRequestSchema
>;

/** Desktop-shell control surface for BB's coordination and durable-state server. */
export interface BbDesktopServerApi {
  /** Return the persisted selection and the last known account-server list. */
  getState(): Promise<BbDesktopServerState>;
  /** Refresh Connect account servers, then return the latest selection state. */
  refresh(): Promise<BbDesktopServerState>;
  /** Persist a target and reload every bb window onto it. */
  select(serverId: string): Promise<void>;
  /** Open the native custom-server URL editor. */
  openCustomServerDialog(): void;
}
