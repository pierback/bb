import { z } from "zod";
import type { BbDesktopBrowserApi } from "./browser.js";
import type { BbDesktopNetworkApi } from "./network.js";
import type { BbDesktopServerApi } from "./server.js";
import { bbDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId } from "@bb/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

export const bbDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);
export type BbDesktopDownloadState = z.infer<
  typeof bbDesktopDownloadStateSchema
>;

export const bbDesktopUpdateChannelSchema = z.enum(["canary", "stable"]);
export type BbDesktopUpdateChannel = z.infer<
  typeof bbDesktopUpdateChannelSchema
>;

export const bbDesktopInfoSchema = z.object({
  downloadState: bbDesktopDownloadStateSchema.optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: bbDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updatesEnabled: z.boolean(),
  updateAvailable: z.boolean(),
  updateChannel: bbDesktopUpdateChannelSchema,
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
});
export type BbDesktopInfo = z.infer<typeof bbDesktopInfoSchema>;

export const bbDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
  })
  .strict();
export type BbDesktopWindowState = z.infer<typeof bbDesktopWindowStateSchema>;

export const bbDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type BbDesktopTheme = z.infer<typeof bbDesktopThemeSchema>;

export type BbDesktopInfoChangeHandler = (info: BbDesktopInfo) => void;
export type BbDesktopInfoUnsubscribe = () => void;
export type BbDesktopWindowStateChangeHandler = (
  state: BbDesktopWindowState,
) => void;
export type BbDesktopOpenNewTabHandler = () => void;
export type BbDesktopAppCommandHandler = (command: AppCommandId) => void;
export type BbDesktopCloseWindowRequestHandler = () => boolean;

export interface BbDesktopApi extends BbDesktopInfo {
  browser: BbDesktopBrowserApi;
  /** Resolve machine names through the desktop's DNS and Bonjour stack. */
  network: BbDesktopNetworkApi;
  /** Select BB's coordination and durable-state server independently of execution machines. */
  server: BbDesktopServerApi;
  checkForUpdates(): Promise<BbDesktopInfo>;
  getInfo(): Promise<BbDesktopInfo>;
  getWindowState?(): Promise<BbDesktopWindowState>;
  installUpdate(): Promise<void>;
  /** Select the signed BB Mesh release feed used by this Mac. */
  setUpdateChannel(channel: BbDesktopUpdateChannel): Promise<BbDesktopInfo>;
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe;
  onOpenNewTab?(listener: BbDesktopOpenNewTabHandler): BbDesktopInfoUnsubscribe;
  onAppCommand?(listener: BbDesktopAppCommandHandler): BbDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: BbDesktopCloseWindowRequestHandler,
  ): BbDesktopInfoUnsubscribe;
  openExternalUrl(url: string): void;
  openServerDaemonLogs?(): Promise<void>;
  setTheme(theme: BbDesktopTheme): void;
}
