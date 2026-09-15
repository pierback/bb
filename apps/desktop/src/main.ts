import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { arch, homedir, hostname, release, type as osType } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  safeStorage,
  session,
  shell,
  type Event,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
} from "@bb/config/app-surface";
import type { ConnectMachineCredential } from "@bb/connect-client";
import type { AppKeybindings } from "@bb/domain";
import {
  bbDesktopBrowserImportCookiesRequestSchema,
  bbDesktopMachineAddressRequestSchema,
  bbDesktopMachineAddressResponseSchema,
  bbDesktopSelectServerRequestSchema,
  bbDesktopThemeSchema,
  bbDesktopUpdateChannelSchema,
  type BbDesktopInfo,
  type BbDesktopExecutionHostState,
  type BbDesktopServerState,
  type BbDesktopWindowState,
} from "@bb/desktop-contract";
import {
  serverMessageLenientSchema,
  type ClientMessage,
} from "@bb/server-contract";
import { z } from "zod";
import {
  assertPathExists,
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopRendererAssetsPath,
  type DesktopPathContext,
} from "./app-paths.js";
import {
  resolveBbAppProcessRuntime,
  type BbAppProcess,
  type BbAppProcessExit,
  startBbAppProcess,
} from "./bb-process.js";
import { openExistingServerDialog } from "./existing-server-dialog.js";
import {
  readForeignRuntimeDetails,
  stopForeignRuntime,
} from "./foreign-runtime.js";
import { createLocalViewUrl, STARTUP_RETRY_CHANNEL } from "./local-view.js";
import { installApplicationMenu } from "./menu.js";
import {
  DEFAULT_APPLICATION_MENU_ACCELERATORS,
  resolveApplicationMenuAccelerators,
} from "./desktop-menu-shortcuts.js";
import {
  clearOwnedRuntimePidFile,
  reapStaleOwnedRuntime,
  writeOwnedRuntimePidFile,
} from "./owned-runtime-supervisor.js";
import {
  probeBbServer,
  waitForCompatibleServer,
  type CompatibleServerProbeResult,
  type ServerProbeResult,
} from "./server-probe.js";
import {
  createServerTargetStore,
  SERVER_TARGET_FILE_NAME,
  type ServerTargetStore,
} from "./server-target.js";
import { openServerUrlDialog } from "./server-url-dialog.js";
import {
  createConnectServerSync,
  type ConnectAccountServer,
  type ConnectServerSync,
  type ConnectServerSyncSkipReason,
} from "./connect-server-sync.js";
import {
  createCredentialCookieSource,
  createLocalServerCookieSource,
  installConnectDesktopSession,
  requestConnectDesktopHostJoinCode,
  reuseInstalledConnectDesktopSession,
  type ConnectDesktopSessionResult,
} from "./connect-desktop-session.js";
import {
  createConnectCredentialCache,
  type ConnectCredentialCache,
} from "./connect-credential-cache.js";
import { enrollDesktopMachine } from "./connect-machine-enrollment.js";
import {
  createConnectSessionRenewal,
  type ConnectSessionRenewal,
} from "./connect-session-renewal.js";
import {
  createDesktopShutdownState,
  registerDesktopShutdownSignalHandlers,
} from "./desktop-shutdown.js";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowFactory,
} from "./desktop-window-factory.js";
import { shouldUseLinuxFramelessWindow } from "./desktop-window-frame.js";
import { shouldUseLinuxTransparentWindow } from "./desktop-window-transparency.js";
import {
  createDesktopAboutDialogOptions,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "./desktop-about-panel.js";
import { registerDesktopContextMenu } from "./desktop-context-menu.js";
import { resolveBbDesktopPlatform } from "./desktop-platform.js";
import {
  createDesktopUpdateService,
  type DesktopUpdateService,
} from "./desktop-update-check.js";
import {
  canAttachToDesktopRuntime,
  createDesktopRuntimeProcessEnv,
  resolveDesktopRuntimeProfile,
  type DesktopRuntimeProfile,
} from "./desktop-runtime-profile.js";
import {
  createDesktopAutoUpdateFeedConfig,
  createDesktopVersionFeedUrl,
  DESKTOP_BUILD_FLAVOR,
  DESKTOP_DEFAULT_UPDATE_CHANNEL,
  DESKTOP_RELEASE_INFO,
  resolveDesktopUserDataPath,
  resolveDesktopUpdateSupport,
} from "./desktop-update-provider.js";
import {
  createDesktopAutoUpdateService,
  createElectronAutoUpdaterAdapter,
  shouldEnableDesktopAutoUpdate,
  type DesktopAutoUpdateLogger,
  type DesktopAutoUpdateService,
} from "./desktop-auto-update.js";
import { mergeDesktopUpdateInfo } from "./desktop-update-info.js";
import {
  BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  BB_DESKTOP_GET_INFO_CHANNEL,
  BB_DESKTOP_INFO_CHANGED_CHANNEL,
  BB_DESKTOP_INSTALL_UPDATE_CHANNEL,
  BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  BB_DESKTOP_SET_THEME_CHANNEL,
  BB_DESKTOP_SET_UPDATE_CHANNEL_CHANNEL,
} from "./desktop-update-ipc.js";
import {
  createDesktopUpdateChannelStore,
  DESKTOP_UPDATE_CHANNEL_FILE_NAME,
} from "./desktop-update-channel-store.js";
import {
  createDesktopUpdateChannelController,
  type DesktopUpdateChannelController,
} from "./desktop-update-channel-controller.js";
import {
  startDesktopUpdateChannelWatcher,
  type DesktopUpdateChannelWatcher,
} from "./desktop-update-channel-watcher.js";
import {
  BB_DESKTOP_APP_COMMAND_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  CLOSE_WINDOW_REQUEST_TIMEOUT_MS,
} from "./desktop-window-command-ipc.js";
import {
  BB_DESKTOP_GET_SERVER_STATE_CHANNEL,
  BB_DESKTOP_OPEN_CUSTOM_SERVER_DIALOG_CHANNEL,
  BB_DESKTOP_REFRESH_SERVERS_CHANNEL,
  BB_DESKTOP_SERVER_STATE_CHANGED_CHANNEL,
  BB_DESKTOP_SELECT_SERVER_CHANNEL,
} from "./desktop-server-ipc.js";
import { resolveMachineNetworkAddresses } from "./desktop-network.js";
import { BB_DESKTOP_RESOLVE_MACHINE_ADDRESSES_CHANNEL } from "./desktop-network-ipc.js";
import {
  BUILTIN_SERVER_ID,
  buildDesktopServerState,
  CUSTOM_SERVER_ID,
} from "./desktop-server-state.js";
import {
  DESKTOP_COORDINATOR_GATEWAY_CAPABILITY_HEADER,
  startDesktopCoordinatorGateway,
  type DesktopCoordinatorGateway,
} from "./desktop-coordinator-gateway.js";
import type { DesktopCoordinatorAuthentication } from "./desktop-coordinator-auth.js";
import {
  startDesktopExecutionHost,
  type DesktopExecutionHost,
  type DesktopExecutionHostJoinCode,
} from "./desktop-execution-host.js";
import {
  buildNativeClientPairingApprovalUrl,
  createNativeClientPairing,
  waitForNativeClientPairing,
} from "./native-client-pairing.js";
import {
  startDesktopRendererServer,
  type DesktopRendererServer,
} from "./desktop-renderer-server.js";
import {
  createDesktopBrowserViewManager,
  type DesktopBrowserViewManager,
} from "./desktop-browser-view.js";
import { resolveDesktopBrowserAppCommand } from "./desktop-browser-shortcuts.js";
import { registerDesktopBrowserIpc } from "./desktop-browser-main-ipc.js";
import { createBrowserImportService } from "./browser-import/browser-import.js";
import { readMacAppIcon } from "./browser-import/mac-app-icon.js";
import {
  createDesktopBrowserBroker,
  type DesktopBrowserBroker,
} from "./desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "./desktop-browser-broker-client.js";
import { bbDesktopBrowserTabRefSchema } from "@bb/desktop-contract";
import {
  BB_DESKTOP_BROWSER_TARGET_CHANNEL,
  BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  BB_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  BB_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
} from "./desktop-browser-ipc.js";
import { parseDesktopSystemConfig } from "./desktop-system-config.js";
import { ensurePackagedUserShellPath } from "./desktop-shell-path.js";
import { resolveDesktopReloadShortcut } from "./desktop-reload-shortcut.js";
import {
  createLogTailer,
  createLogLineBuffer,
  createLogViewerViewUrl,
  LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
  LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
  type LogLineBuffer,
  type LogTailer,
} from "./log-viewer.js";
import {
  LOG_VIEWER_APPEND_CHANNEL,
  LOG_VIEWER_COPY_CHANNEL,
  LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL,
  LOG_VIEWER_SNAPSHOT_CHANNEL,
  LOG_VIEWER_VISIBLE_LINE_LIMIT,
  type LogViewerLine,
  type LogViewerCopyRequest,
  type LogViewerOpenLogsFolderResult,
} from "./log-viewer-contract.js";
import {
  ATTACH_PROBE_TIMEOUT_MS,
  DEFAULT_BB_SERVER_URL,
  PROCESS_LOG_LINE_LIMIT,
  STARTUP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  type RuntimeOwnership,
  type WindowStateKey,
} from "./types.js";

const OWNED_RUNTIME_STOP_TIMEOUT_MS = 6_000;
const OWNED_RUNTIME_KILL_TIMEOUT_MS = 1_000;
const FOREIGN_RUNTIME_STOP_TIMEOUT_MS = 15_000;
const FOREIGN_RUNTIME_KILL_TIMEOUT_MS = 3_000;
const REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DESKTOP_COORDINATOR_GATEWAY_CAPABILITY = randomUUID();

interface DesktopRuntime {
  bbProcess: BbAppProcess | null;
  ownership: RuntimeOwnership;
  serverUrl: string;
  userDataPath: string | null;
}

interface LoadStartupErrorArgs {
  details: string;
  logs: string;
  retryable: boolean;
  title: string;
}

interface LoadWindowUrlArgs {
  url: string;
}

interface CreateApplicationWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface StartOwnedRuntimeArgs {
  bridgePath: string;
  profile: DesktopRuntimeProfile;
  serverUrl: string;
  userDataPath: string;
}

interface AppendLogViewerLinesArgs {
  lines: LogViewerLine[];
}

interface SendLogViewerSnapshotArgs {
  browserWindow: BrowserWindow;
  lines: LogViewerLine[];
  logDir: string;
}

interface HandleCopyLogsArgs {
  request: LogViewerCopyRequest;
}

interface LoadLogViewerWindowArgs {
  logDir: string;
  preloadPath: string;
}

type StartupRaceResult =
  | ProcessExitedStartupRaceResult
  | ServerProbeStartupRaceResult;

interface ProcessExitedStartupRaceResult {
  exit: BbAppProcessExit;
  kind: "process-exited";
}

interface ServerProbeStartupRaceResult {
  kind: "server-probe";
  result: ServerProbeResult;
}

interface ResolveDesktopWindowUrlArgs {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface ResolveDataDirFromEnvArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveDesktopUpdateFeedUrlArgs {
  channel: BbDesktopInfo["updateChannel"];
  env: NodeJS.ProcessEnv;
  platform: BbDesktopInfo["platform"];
}

interface FetchSystemConfigArgs {
  fetchImpl: typeof fetch;
  serverUrl: string;
}

interface RefreshSystemConfigArgs {
  fetchImpl: typeof fetch;
  serverUrl: string;
}

interface SystemConfigSync {
  stop(): void;
}

const logViewerCopyRequestSchema = z
  .object({
    text: z.string(),
  })
  .strict();

let desktopWindowFactory: DesktopWindowFactory | null = null;
let desktopBrowserViewManager: DesktopBrowserViewManager | null = null;
let desktopBrowserBroker: DesktopBrowserBroker | null = null;
let desktopBrowserBrokerClient: ReturnType<
  typeof createDesktopBrowserBrokerClient
> | null = null;
let currentAppKeybindings: AppKeybindings = [];
let currentApplicationMenuAccelerators = DEFAULT_APPLICATION_MENU_ACCELERATORS;
let desktopUpdateService: DesktopUpdateService | null = null;
let desktopAutoUpdateService: DesktopAutoUpdateService | null = null;
let desktopUpdateChannelController: DesktopUpdateChannelController | null =
  null;
let desktopUpdateChannelWatcher: DesktopUpdateChannelWatcher | null = null;
let currentRuntime: DesktopRuntime | null = null;
let currentWindowUrl: string | null = null;
let logViewerIpcHandlersInstalled = false;
let logViewerLineBuffer: LogLineBuffer | null = null;
let logViewerPreloadPath: string | null = null;
let logViewerTailer: LogTailer | null = null;
let logViewerWindow: BrowserWindow | null = null;
let systemConfigSync: SystemConfigSync | null = null;
let systemConfigRefreshToken = 0;
let refreshRemoteSystemConfig: (() => void) | null = null;
const applicationWindowWebContentsIds = new Set<number>();
let bbAppLoaded = false;
let startupRetryUrl: string | null = null;
let startupRetryPending = false;
let stoppingForQuit = false;
let quitting = false;
let serverTargetStore: ServerTargetStore | null = null;
let connectServerSync: ConnectServerSync | null = null;
let connectCredentialCache: ConnectCredentialCache | null = null;
let cachedConnectCredential: ConnectMachineCredential | null = null;
let enrollingDesktopMachine: Promise<ConnectMachineCredential | null> | null =
  null;
let connectSessionRenewal: ConnectSessionRenewal | null = null;
let serverTargetGeneration = 0;
let connectAccountServers: ConnectAccountServer[] = [];
let connectServerSyncSkipReason: ConnectServerSyncSkipReason | null = null;
let builtinServerUrl: string = DEFAULT_BB_SERVER_URL;
let desktopBridgePath: string | null = null;
let desktopRendererAssetsPath: string | null = null;
let desktopRuntimeProfile: DesktopRuntimeProfile | null = null;
let desktopUserDataPath: string | null = null;
let serverUrlDialogPreloadPath: string | null = null;
let existingServerDialogPreloadPath: string | null = null;
let coordinatorGateway: DesktopCoordinatorGateway | null = null;
let desktopRendererServer: DesktopRendererServer | null = null;
let desktopExecutionHost: DesktopExecutionHost | null = null;
let desktopExecutionHostState: BbDesktopExecutionHostState | null = null;

function resolveDesktopDevelopmentAppUrl(
  env: NodeJS.ProcessEnv,
): string | null {
  const rawAppUrl = env.BB_DESKTOP_APP_URL?.trim();
  if (rawAppUrl === undefined || rawAppUrl.length === 0) {
    return null;
  }
  let parsedAppUrl: URL;
  try {
    parsedAppUrl = new URL(rawAppUrl);
  } catch {
    throw new Error("BB_DESKTOP_APP_URL must be a valid URL");
  }
  if (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:") {
    throw new Error("BB_DESKTOP_APP_URL must be an http(s) URL");
  }
  return rawAppUrl;
}

function resolveDesktopWindowUrl(args: ResolveDesktopWindowUrlArgs): string {
  return resolveDesktopDevelopmentAppUrl(args.env) ?? args.serverUrl;
}

function canReplaceAppImage(appImagePath: string): boolean {
  try {
    accessSync(
      dirname(appImagePath),
      // oxlint-disable-next-line no-bitwise
      fsConstants.W_OK | fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function resolveDesktopUpdateFeedUrl(
  args: ResolveDesktopUpdateFeedUrlArgs,
): string {
  const rawFeedUrl = args.env.BB_DESKTOP_VERSION_FEED_URL?.trim();
  if (rawFeedUrl === undefined || rawFeedUrl.length === 0) {
    return createDesktopVersionFeedUrl(args.channel, args.platform);
  }
  return rawFeedUrl;
}

function getDesktopVersion(version: string | undefined): string {
  if (version === undefined || version.length === 0) {
    throw new Error("Desktop version must be injected at build time");
  }
  return version;
}

function readDesktopAboutFacts(applicationName: string): DesktopAboutFacts {
  return {
    applicationName,
    buildDate: process.env.BB_DESKTOP_BUILD_DATE ?? "",
    channel: DESKTOP_BUILD_FLAVOR === "preview" ? "nightly" : "latest",
    commit: process.env.BB_DESKTOP_COMMIT ?? "",
    electronVersion: process.versions.electron,
    osArch: arch(),
    osRelease: release(),
    osType: osType(),
    platform: process.platform,
    pluginSdkVersion: process.env.BB_DESKTOP_PLUGIN_SDK_VERSION ?? "",
    version: getDesktopVersion(process.env.BB_DESKTOP_VERSION),
  };
}

function installAboutPanel(applicationName: string): void {
  app.setAboutPanelOptions(
    createDesktopAboutPanelOptions(readDesktopAboutFacts(applicationName)),
  );
}

async function showAboutDialog(): Promise<void> {
  const { copyButtonId, ...messageBoxOptions } =
    createDesktopAboutDialogOptions(
      readDesktopAboutFacts(app.getName()),
      Date.now(),
    );
  const parentWindow = getFocusedApplicationWindow();
  const result =
    parentWindow === null
      ? await dialog.showMessageBox(messageBoxOptions)
      : await dialog.showMessageBox(parentWindow, messageBoxOptions);
  if (result.response === copyButtonId) {
    clipboard.writeText(messageBoxOptions.detail);
  }
}

function getCurrentDesktopInfo(): BbDesktopInfo | null {
  const info = mergeDesktopUpdateInfo({
    autoInfo: desktopAutoUpdateService?.getInfo() ?? null,
    feedInfo: desktopUpdateService?.getInfo() ?? null,
  });
  if (info === null) {
    return null;
  }
  return {
    ...info,
    serverDaemonLogsAvailable: shouldEnableServerDaemonLogsMenu(),
  };
}

function isRegisteredApplicationWindow(browserWindow: BrowserWindow): boolean {
  return applicationWindowWebContentsIds.has(browserWindow.webContents.id);
}

function resolveApplicationWindow(
  webContents: WebContents,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents);
}

function isApplicationRendererSender(event: { sender: WebContents }): boolean {
  const browserWindow = resolveApplicationWindow(event.sender);
  return browserWindow !== null && isRegisteredApplicationWindow(browserWindow);
}

function sendToApplicationRenderer(
  browserWindow: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  if (!browserWindow.webContents.isDestroyed()) {
    browserWindow.webContents.send(channel, payload);
  }
}

function registerApplicationRendererReloadShortcut(
  webContents: WebContents,
): void {
  webContents.on("before-input-event", (event, input) => {
    const shortcut = resolveDesktopReloadShortcut(input);
    if (shortcut === null) {
      return;
    }
    event.preventDefault();
    const browserWindow = resolveApplicationWindow(webContents);
    if (browserWindow !== null) {
      desktopBrowserViewManager?.prepareWindowReload(browserWindow);
    }
    if (shortcut === "force-reload") {
      webContents.reloadIgnoringCache();
    } else {
      webContents.reload();
    }
  });
}

function sendDesktopInfoChanged(): void {
  const info = getCurrentDesktopInfo();
  if (info === null) {
    return;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        BB_DESKTOP_INFO_CHANGED_CHANNEL,
        info,
      );
    } else {
      browserWindow.webContents.send(BB_DESKTOP_INFO_CHANGED_CHANNEL, info);
    }
  }
}

function getDesktopWindowState(
  browserWindow: Pick<DesktopBrowserWindow, "isFullScreen"> | null,
): BbDesktopWindowState {
  return {
    isFullScreen: browserWindow?.isFullScreen() ?? false,
  };
}

function getSenderDesktopWindowState(
  event: IpcMainInvokeEvent,
): BbDesktopWindowState {
  return getDesktopWindowState(resolveApplicationWindow(event.sender));
}

function sendDesktopWindowStateChanged(
  browserWindow: DesktopBrowserWindow,
): void {
  sendToApplicationRenderer(
    browserWindow as BrowserWindow,
    BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
    getDesktopWindowState(browserWindow),
  );
}

function createDesktopLogger(): DesktopAutoUpdateLogger {
  return {
    error(message) {
      process.stderr.write(`${message}\n`);
    },
    info(message) {
      process.stderr.write(`${message}\n`);
    },
    warn(message) {
      process.stderr.write(`${message}\n`);
    },
  };
}

function resolveDataDirFromEnv(args: ResolveDataDirFromEnvArgs): string {
  const rawDataDir = args.env.BB_DATA_DIR?.trim();
  if (rawDataDir === undefined || rawDataDir.length === 0) {
    return join(args.homeDir, ".bb");
  }
  if (rawDataDir === "~") {
    return args.homeDir;
  }
  if (rawDataDir.startsWith("~/")) {
    return resolve(args.homeDir, rawDataDir.slice(2));
  }
  return resolve(rawDataDir);
}

function formatLogDirectory(): string {
  return join(desktopRuntimeProfile?.dataDir ?? join(homedir(), ".bb"), "logs");
}

function formatExitResult(result: BbAppProcessExit): string {
  if (result.code !== null) {
    return `exit code ${result.code}`;
  }
  return result.signal === null
    ? "without an exit code"
    : `signal ${result.signal}`;
}

function createDesktopPathContext(): DesktopPathContext {
  return {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

function shouldEnableServerDaemonLogsMenu(): boolean {
  return (
    process.platform === "darwin" && currentRuntime?.ownership === "spawned"
  );
}

const pendingCloseWindowRequests = new Map<number, NodeJS.Timeout>();

function requestRendererWindowClose(browserWindow: BrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  const pending = pendingCloseWindowRequests.get(webContentsId);
  if (pending !== undefined) {
    clearTimeout(pending);
  }
  pendingCloseWindowRequests.set(
    webContentsId,
    setTimeout(() => {
      pendingCloseWindowRequests.delete(webContentsId);
      if (!browserWindow.isDestroyed()) {
        browserWindow.close();
      }
    }, CLOSE_WINDOW_REQUEST_TIMEOUT_MS),
  );
  sendToApplicationRenderer(
    browserWindow,
    BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
    null,
  );
}

function closeFocusedDetachedDevTools(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.webContents.isDevToolsFocused()) {
      browserWindow.webContents.closeDevTools();
      return;
    }
  }
}

function getFocusedApplicationWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused !== null &&
    !focused.isDestroyed() &&
    applicationWindowWebContentsIds.has(focused.webContents.id)
  ) {
    return focused;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (
      !browserWindow.isDestroyed() &&
      applicationWindowWebContentsIds.has(browserWindow.webContents.id)
    ) {
      return browserWindow;
    }
  }
  return null;
}

function getCurrentDesktopServerState(): BbDesktopServerState {
  return buildDesktopServerState({
    builtinServerUrl,
    connectServers: connectAccountServers,
    customServerUrl: serverTargetStore?.getCustomServerUrl() ?? null,
    executionHost: desktopExecutionHostState,
    savedConnectServer: serverTargetStore?.getConnectServer() ?? null,
    target: serverTargetStore?.getTarget() ?? { kind: "builtin" },
  });
}

function sendDesktopServerStateChanged(): void {
  const state = getCurrentDesktopServerState();
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (isRegisteredApplicationWindow(browserWindow)) {
      sendToApplicationRenderer(
        browserWindow,
        BB_DESKTOP_SERVER_STATE_CHANGED_CHANNEL,
        state,
      );
    }
  }
}

function setDesktopExecutionHostState(
  state: BbDesktopExecutionHostState | null,
): void {
  desktopExecutionHostState = state;
  sendDesktopServerStateChanged();
}

function buildMenuServerItems(): Array<{
  checked: boolean;
  id: string;
  name: string;
}> {
  const state = getCurrentDesktopServerState();
  return state.servers.map((server) => ({
    checked: server.id === state.activeServerId,
    id: server.id,
    name: server.name,
  }));
}

function installCurrentApplicationMenu(): void {
  installApplicationMenu({
    accelerators: currentApplicationMenuAccelerators,
    connectServersSkipReason:
      connectAccountServers.length === 0 ? connectServerSyncSkipReason : null,
    isMac: process.platform === "darwin",
    createNewWindow() {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    },
    openAbout() {
      void showAboutDialog();
    },
    openNewTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
          null,
        );
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.newTab",
        );
      }
    },
    openNewThread() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "thread.new",
        );
      }
    },
    reopenClosedTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.reopenClosedTab",
        );
      }
    },
    openSettings() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "settings.open",
        );
      }
    },
    reloadWindow(browserWindow, ignoreCache) {
      if (!(browserWindow instanceof BrowserWindow)) {
        return;
      }
      desktopBrowserViewManager?.prepareWindowReload(browserWindow);
      if (ignoreCache) {
        browserWindow.webContents.reloadIgnoringCache();
      } else {
        browserWindow.webContents.reload();
      }
    },
    closeWindowOrSideTab(browserWindow) {
      if (browserWindow === undefined) {
        closeFocusedDetachedDevTools();
        return;
      }
      if (
        !(browserWindow instanceof BrowserWindow) ||
        browserWindow === logViewerWindow
      ) {
        browserWindow.close();
        return;
      }
      requestRendererWindowClose(browserWindow);
    },
    openServerDaemonLogs() {
      void openServerDaemonLogs();
    },
    selectServer(serverId) {
      void setActiveServerTarget(serverId);
    },
    setServerUrl() {
      void openSetServerUrlDialog();
    },
    onServerMenuWillShow() {
      connectServerSync?.onListRequested();
    },
    serverDaemonLogsMenuEnabled: shouldEnableServerDaemonLogsMenu(),
    servers: buildMenuServerItems(),
  });
}

function refreshApplicationMenu(): void {
  installCurrentApplicationMenu();
}

function setCurrentRuntime(runtime: DesktopRuntime | null): void {
  currentRuntime = runtime;
  if (runtime === null) {
    stopSystemConfigSync();
  } else {
    connectServerSync?.onRuntimeReady();
  }
  refreshApplicationMenu();
  if (runtime?.ownership !== "spawned") {
    closeServerDaemonLogsWindow();
  }
  sendDesktopInfoChanged();
}

function formatApiUrl(args: FetchSystemConfigArgs): string {
  const url = new URL(args.serverUrl);
  url.pathname = "/api/v1/system/config";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatRealtimeUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchSystemConfig(args: FetchSystemConfigArgs) {
  const response = await args.fetchImpl(formatApiUrl(args));
  if (!response.ok) {
    throw new Error(
      `System config request failed with HTTP ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  return parseDesktopSystemConfig(payload);
}

function createSystemConfigSync(serverUrl: string): SystemConfigSync {
  const realtimeUrl = formatRealtimeUrl(serverUrl);
  const subscribeMessage: ClientMessage = {
    type: "subscribe",
    target: { kind: "system" },
  };
  let reconnectTimer: NodeJS.Timeout | null = null;
  let socket: WebSocket | null = null;
  let stopped = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const parsed = serverMessageLenientSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) {
        return;
      }
      if (
        parsed.data.entity === "system" &&
        parsed.data.changes.includes("config-changed")
      ) {
        void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
      }
    } catch {
      return;
    }
  }

  function connect(): void {
    if (stopped) {
      return;
    }
    socket = new WebSocket(realtimeUrl);
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify(subscribeMessage));
      void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
}

async function refreshSystemConfig(
  args: RefreshSystemConfigArgs,
): Promise<void> {
  const token = systemConfigRefreshToken + 1;
  systemConfigRefreshToken = token;
  try {
    const config = await fetchSystemConfig({
      fetchImpl: args.fetchImpl,
      serverUrl: args.serverUrl,
    });
    if (token !== systemConfigRefreshToken) {
      return;
    }
    currentAppKeybindings = config.keybindings;
    currentApplicationMenuAccelerators = resolveApplicationMenuAccelerators(
      currentAppKeybindings,
    );
    refreshApplicationMenu();
  } catch (error) {
    if (token !== systemConfigRefreshToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not refresh system config: ${message}\n`);
  }
}

function createRemoteSystemConfigSync(serverUrl: string): SystemConfigSync {
  function refresh(): void {
    void refreshSystemConfig({
      fetchImpl: (input, init) => net.fetch(input as string | Request, init),
      serverUrl,
    });
  }

  const timer = setInterval(refresh, REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS);
  timer.unref();
  refreshRemoteSystemConfig = refresh;
  refresh();

  return {
    stop(): void {
      clearInterval(timer);
      refreshRemoteSystemConfig = null;
    },
  };
}

function stopSystemConfigSync(): void {
  systemConfigSync?.stop();
  systemConfigSync = null;
}

function startSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createSystemConfigSync(serverUrl);
  void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
}

function fetchWithElectronSession(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  return net.fetch(input instanceof URL ? input.toString() : input, init);
}

function canAttachCompatibleRuntime(
  probe: CompatibleServerProbeResult,
  profile: DesktopRuntimeProfile,
): boolean {
  return canAttachToDesktopRuntime({
    allowForeignRuntime: process.env.BB_DESKTOP_ATTACH_WITHOUT_PROMPT === "1",
    dataDir: probe.dataDir,
    isPackaged: app.isPackaged,
    profile,
  });
}

function startRemoteSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createRemoteSystemConfigSync(serverUrl);
}

function registerApplicationWindow(browserWindow: DesktopBrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  applicationWindowWebContentsIds.add(webContentsId);
  const nativeWindow = BrowserWindow.fromId(browserWindow.id);
  if (nativeWindow !== null) desktopBrowserBroker?.registerWindow(nativeWindow);
  registerApplicationRendererReloadShortcut(
    (browserWindow as BrowserWindow).webContents,
  );
  registerDesktopContextMenu({ webContents: browserWindow.webContents });
  browserWindow.on("enter-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("leave-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("closed", () => {
    desktopBrowserBroker?.releaseWindow(webContentsId);
    applicationWindowWebContentsIds.delete(webContentsId);
  });
}

async function ensureBuiltinRuntimeAttached(): Promise<boolean> {
  if (currentRuntime !== null) {
    return true;
  }
  if (desktopBridgePath === null || desktopUserDataPath === null) {
    return false;
  }
  if (desktopRuntimeProfile === null) {
    return false;
  }

  const existingProbe = await probeBbServer({
    serverUrl: builtinServerUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    if (!canAttachCompatibleRuntime(existingProbe, desktopRuntimeProfile)) {
      createDesktopLogger().error(
        `[desktop] refusing foreign runtime at ${existingProbe.serverUrl}`,
      );
      return false;
    }
    setCurrentRuntime({
      bbProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    return true;
  }

  if (existingProbe.kind === "incompatible") {
    return false;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: desktopBridgePath,
    profile: desktopRuntimeProfile,
    serverUrl: builtinServerUrl,
    userDataPath: desktopUserDataPath,
  });
  return runtime !== null;
}

async function authenticateConnectTarget(
  remoteServerUrl: string,
  isCurrent: () => boolean,
): Promise<ConnectDesktopSessionResult> {
  const cookieStore = session.defaultSession.cookies;
  let cachedFailure: ConnectDesktopSessionResult | null = null;
  if (cachedConnectCredential !== null) {
    const cachedResult = await installConnectDesktopSession({
      cookieStore,
      mintCookie: createCredentialCookieSource({
        credential: cachedConnectCredential,
      }),
      remoteServerUrl,
    });
    if (cachedResult.ok) {
      return cachedResult;
    }
    if (cachedResult.code === "unauthorized") {
      createDesktopLogger().info(
        "[desktop] bb Connect refused the cached machine credential — dropping it",
      );
      await clearCachedConnectCredential();
    } else if (cachedResult.code === "network") {
      return cachedResult;
    }
    cachedFailure = cachedResult;
  }

  if (!isCurrent()) {
    return (
      cachedFailure ?? {
        code: "network",
        detail: "the app no longer targets this server",
        ok: false,
      }
    );
  }
  const existingResult = await reuseInstalledConnectDesktopSession({
    cookieStore,
    fetchImpl: fetchWithElectronSession,
    remoteServerUrl,
  });
  if (existingResult !== null) {
    await ensureDesktopMachineEnrolled(remoteServerUrl, true);
    return existingResult;
  }

  const localRuntimeReady = await ensureBuiltinRuntimeAttached();
  if (!localRuntimeReady || currentRuntime === null) {
    return (
      cachedFailure ?? {
        code: "network",
        detail:
          "the local bb server is unavailable, and this app has no stored bb Connect credential",
        ok: false,
      }
    );
  }
  const localResult = await installConnectDesktopSession({
    cookieStore,
    mintCookie: createLocalServerCookieSource({
      localServerUrl: currentRuntime.serverUrl,
    }),
    remoteServerUrl,
  });
  if (localResult.ok) {
    await ensureDesktopMachineEnrolled(currentRuntime.serverUrl, false);
  }
  return localResult;
}

async function clearCachedConnectCredential(): Promise<void> {
  cachedConnectCredential = null;
  await connectCredentialCache?.clear();
}

async function requestNativeClientPairingJoinCode(args: {
  isCurrent(): boolean;
  serverUrl: string;
}): Promise<DesktopExecutionHostJoinCode> {
  const deviceName = hostname().trim() || "This Mac";
  const fetchImpl: typeof fetch = (input, init) =>
    net.fetch(input instanceof URL ? input.toString() : input, init);
  const pairing = await createNativeClientPairing({
    deviceName,
    fetchImpl,
    serverUrl: args.serverUrl,
  });
  if (!args.isCurrent()) {
    throw new Error("Native pairing was cancelled");
  }

  const approvalUrl = buildNativeClientPairingApprovalUrl({
    pairing,
    serverUrl: args.serverUrl,
  });
  await loadNativeClientPairingView({
    approvalUrl,
    coordinator: new URL(args.serverUrl).host,
    deviceName,
    expiresAt: pairing.expiresAt,
    userCode: pairing.userCode,
  });
  if (!args.isCurrent()) {
    throw new Error("Native pairing was cancelled");
  }
  await shell.openExternal(approvalUrl);
  const enrollment = await waitForNativeClientPairing({
    fetchImpl,
    isCurrent: args.isCurrent,
    pairing,
    serverUrl: args.serverUrl,
  });
  return { hostId: enrollment.hostId, joinCode: enrollment.joinCode };
}

async function ensureDesktopMachineEnrolled(
  machineCodeServerUrl: string,
  includeSessionCookie: boolean,
): Promise<ConnectMachineCredential | null> {
  const cache = connectCredentialCache;
  if (cachedConnectCredential !== null) return cachedConnectCredential;
  if (enrollingDesktopMachine !== null) return enrollingDesktopMachine;
  if (cache === null) return null;
  if (!cache.canPersist()) {
    createDesktopLogger().info(
      "[desktop] no OS keychain available — keeping the local bb server for bb Connect sessions",
    );
    return null;
  }
  const logger = createDesktopLogger();
  const enrollment = (async (): Promise<ConnectMachineCredential | null> => {
    const result = await enrollDesktopMachine({
      fetchImpl: (input, init) =>
        fetchWithElectronSession(input, {
          ...init,
          ...(includeSessionCookie ? { credentials: "include" } : {}),
        }),
      localServerUrl: machineCodeServerUrl,
    });
    if (!result.ok) {
      logger.info(
        `[desktop] could not enroll this app with bb Connect (${result.code}): ${result.detail}`,
      );
      return null;
    }
    cachedConnectCredential = result.credential;
    await cache.write(result.credential);
    logger.info("[desktop] enrolled this app as a bb Connect machine");
    return result.credential;
  })();
  enrollingDesktopMachine = enrollment;
  try {
    return await enrollment;
  } finally {
    if (enrollingDesktopMachine === enrollment) {
      enrollingDesktopMachine = null;
    }
  }
}

async function stopRemoteDesktopServices(): Promise<void> {
  const gateway = coordinatorGateway;
  const executionHost = desktopExecutionHost;
  const rendererServer = desktopRendererServer;
  coordinatorGateway = null;
  desktopExecutionHost = null;
  desktopRendererServer = null;
  setDesktopExecutionHostState(null);
  session.defaultSession.webRequest.onBeforeSendHeaders(null);
  await Promise.allSettled([
    gateway?.close() ?? Promise.resolve(),
    executionHost?.stop() ?? Promise.resolve(),
    rendererServer?.close() ?? Promise.resolve(),
  ]);
}

async function handleRemoteExecutionHostExit(args: {
  isCurrent(): boolean;
  message: string;
  serverUrl: string;
}): Promise<void> {
  if (
    !args.isCurrent() ||
    desktopExecutionHostState?.serverUrl !== args.serverUrl
  ) {
    return;
  }
  await stopRemoteDesktopServices();
  if (!args.isCurrent()) return;
  setDesktopExecutionHostState({
    error: args.message,
    hostId: null,
    port: null,
    serverUrl: args.serverUrl,
    status: "error",
  });
  await loadStartupError({
    details: `This Mac stopped acting as the execution machine: ${args.message}`,
    logs: "",
    retryable: true,
    title: "Local execution stopped",
  });
  refreshApplicationMenu();
}

async function startRemoteDesktopServices(args: {
  authentication: DesktopCoordinatorAuthentication;
  isCurrent(): boolean;
  requestJoinCode(): Promise<DesktopExecutionHostJoinCode>;
  serverUrl: string;
}): Promise<string | null> {
  if (
    desktopBridgePath === null ||
    desktopRendererAssetsPath === null ||
    desktopUserDataPath === null
  ) {
    throw new Error(
      "The desktop app is missing the renderer or execution bridge needed to keep development on this Mac.",
    );
  }

  // Connect authentication may briefly start the built-in coordinator to mint
  // its account credential. Remote mode itself must not keep that coordinator
  // alive. Stop it before allocating remote services.
  await stopOwnedRuntime();
  if (!args.isCurrent()) {
    return null;
  }

  let rendererServer: DesktopRendererServer | null = null;
  const developmentAppUrl = resolveDesktopDevelopmentAppUrl(process.env);
  if (developmentAppUrl === null) {
    rendererServer = await startDesktopRendererServer({
      assetsPath: desktopRendererAssetsPath,
    });
  }
  const appUrl = developmentAppUrl ?? rendererServer?.url;
  if (appUrl === undefined) {
    throw new Error("The desktop renderer server did not start");
  }

  setDesktopExecutionHostState({
    error: null,
    hostId: null,
    port: null,
    serverUrl: args.serverUrl,
    status: "starting",
  });

  let executionHost: DesktopExecutionHost;
  let unexpectedExitMessage: string | null = null;
  try {
    executionHost = await startDesktopExecutionHost({
      authentication: args.authentication,
      bridgePath: desktopBridgePath,
      cwd: homedir(),
      env: {
        ...process.env,
        [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP,
      },
      fetchImpl: (input, init) =>
        net.fetch(input instanceof URL ? input.toString() : input, init),
      onUnexpectedExit(message) {
        unexpectedExitMessage = message;
        if (desktopExecutionHost !== null) {
          void handleRemoteExecutionHostExit({
            isCurrent: args.isCurrent,
            message,
            serverUrl: args.serverUrl,
          });
        }
      },
      requestJoinCode: args.requestJoinCode,
      runtime: resolveBbAppProcessRuntime({
        env: process.env,
        isPackaged: app.isPackaged,
        platform: process.platform,
        processExecPath: process.execPath,
      }),
      serverUrl: args.serverUrl,
      userDataPath: desktopUserDataPath,
    });
    setDesktopExecutionHostState(executionHost.state);
  } catch (error) {
    if (!args.isCurrent()) {
      await rendererServer?.close();
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    setDesktopExecutionHostState({
      error: message,
      hostId: null,
      port: null,
      serverUrl: args.serverUrl,
      status: "error",
    });
    createDesktopLogger().warn(
      `[desktop] this Mac could not join the remote coordinator: ${message}`,
    );
    await rendererServer?.close();
    throw new Error(
      `This Mac could not connect as the execution machine: ${message}`,
    );
  }

  if (unexpectedExitMessage !== null) {
    await Promise.allSettled([
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    throw new Error(
      `This Mac stopped acting as the execution machine: ${unexpectedExitMessage}`,
    );
  }

  if (!args.isCurrent()) {
    await Promise.allSettled([
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    return null;
  }

  let gateway: DesktopCoordinatorGateway;
  try {
    gateway = await startDesktopCoordinatorGateway({
      appUrl,
      authentication: args.authentication,
      capability: DESKTOP_COORDINATOR_GATEWAY_CAPABILITY,
      coordinatorUrl: args.serverUrl,
      hostKey: executionHost.hostKey,
    });
  } catch (error) {
    await Promise.allSettled([
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    throw error;
  }
  if (unexpectedExitMessage !== null) {
    await Promise.allSettled([
      gateway.close(),
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    throw new Error(
      `This Mac stopped acting as the execution machine: ${unexpectedExitMessage}`,
    );
  }
  if (!args.isCurrent()) {
    await Promise.allSettled([
      gateway.close(),
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    return null;
  }
  coordinatorGateway = gateway;
  desktopExecutionHost = executionHost;
  desktopRendererServer = rendererServer;
  const gatewayWebSocketUrl = new URL(gateway.url);
  gatewayWebSocketUrl.protocol = "ws:";
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [`${gateway.url}/*`, `${gatewayWebSocketUrl.origin}/*`],
    },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [DESKTOP_COORDINATOR_GATEWAY_CAPABILITY_HEADER]:
            DESKTOP_COORDINATOR_GATEWAY_CAPABILITY,
        },
      });
    },
  );
  try {
    await loadBbApp(gateway.url);
  } catch (error) {
    coordinatorGateway = null;
    desktopExecutionHost = null;
    desktopRendererServer = null;
    session.defaultSession.webRequest.onBeforeSendHeaders(null);
    await Promise.allSettled([
      gateway.close(),
      executionHost.stop(),
      rendererServer?.close() ?? Promise.resolve(),
    ]);
    throw error;
  }
  return args.isCurrent() ? gateway.url : null;
}

async function retryStartup(): Promise<void> {
  if (startupRetryUrl === null || startupRetryPending) {
    return;
  }
  startupRetryPending = true;
  startupRetryUrl = null;
  try {
    await loadLoadingView();
    await applyServerTarget();
  } catch (error) {
    await loadStartupError({
      details: error instanceof Error ? error.message : String(error),
      logs: "",
      retryable: false,
      title: "Could not open bb",
    });
  } finally {
    startupRetryPending = false;
  }
}

async function applyServerTarget(): Promise<void> {
  startupRetryUrl = null;
  desktopBrowserBrokerClient?.reconnect();
  if (serverTargetStore === null) {
    return;
  }
  const target = serverTargetStore.getTarget();
  connectSessionRenewal?.stop();
  serverTargetGeneration += 1;
  const generation = serverTargetGeneration;
  const isCurrent = (): boolean => serverTargetGeneration === generation;
  await stopRemoteDesktopServices();
  if (!isCurrent()) return;

  if (target.kind === "builtin") {
    const attached = await ensureBuiltinRuntimeAttached();
    if (!isCurrent()) {
      return;
    }
    if (!attached) {
      await loadStartupError({
        details:
          "Could not connect to the local bb server on this Mac. Check that the port is free or that a compatible bb server is running.",
        logs: "",
        retryable: true,
        title: "Could not connect",
      });
      refreshApplicationMenu();
      return;
    }
    const localServerUrl = currentRuntime?.serverUrl ?? builtinServerUrl;
    startSystemConfigSync(localServerUrl);
    await loadBbApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: localServerUrl,
      }),
    );
  } else if (target.kind === "connect") {
    // Keep this desktop's renderer and execution helper local. Only API and
    // websocket traffic crosses the coordinator gateway to the NAS.
    const result = await authenticateConnectTarget(
      target.server.url,
      isCurrent,
    );
    if (!isCurrent()) {
      return;
    }
    if (!result.ok) {
      createDesktopLogger().warn(
        `[desktop] Connect authentication failed (${result.code}): ${result.detail}`,
      );
      await loadStartupError({
        details:
          "The desktop app could not establish a session for this Connect server. " +
          `Try switching servers again. (${result.code}: ${result.detail})`,
        logs: "",
        retryable: true,
        title: "Could not authenticate with bb Connect",
      });
      refreshApplicationMenu();
      return;
    }
    connectSessionRenewal?.start({
      expiresAt: result.expiresAt,
      remoteServerUrl: target.server.url,
    });
    const machineCredential = cachedConnectCredential;
    if (machineCredential === null) {
      await loadStartupError({
        details:
          "Pair this desktop as a machine before using a remote coordination server.",
        logs: "",
        retryable: true,
        title: "Could not authorize this Mac",
      });
      refreshApplicationMenu();
      return;
    }
    try {
      const gatewayUrl = await startRemoteDesktopServices({
        authentication: {
          credential: machineCredential.credential,
          kind: "connect",
          machineId: machineCredential.machineId,
        },
        isCurrent,
        requestJoinCode: async () => {
          const issued = await requestConnectDesktopHostJoinCode({
            bootstrapServerUrl: target.server.url,
            fetchImpl: (input, init) =>
              net.fetch(input instanceof URL ? input.toString() : input, init),
          });
          return { hostId: issued.hostId, joinCode: issued.joinCode };
        },
        serverUrl: target.server.url,
      });
      if (gatewayUrl === null) return;
      startRemoteSystemConfigSync(gatewayUrl);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      connectSessionRenewal?.stop();
      await loadStartupError({
        details: message,
        logs: "",
        retryable: true,
        title: "Could not open the coordination server",
      });
      refreshApplicationMenu();
      return;
    }
  } else {
    try {
      const gatewayUrl = await startRemoteDesktopServices({
        authentication: { kind: "native" },
        isCurrent,
        requestJoinCode: () =>
          requestNativeClientPairingJoinCode({
            isCurrent,
            serverUrl: target.url,
          }),
        serverUrl: target.url,
      });
      if (gatewayUrl === null) return;
      startRemoteSystemConfigSync(gatewayUrl);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      await loadStartupError({
        details: message,
        logs: "",
        retryable: true,
        title: "Could not open the coordination server",
      });
      refreshApplicationMenu();
      return;
    }
  }
  refreshApplicationMenu();
}

async function persistServerTargetSelection(
  serverId: string,
): Promise<boolean> {
  if (serverTargetStore === null) {
    return false;
  }

  const server = getCurrentDesktopServerState().servers.find(
    (candidate) => candidate.id === serverId,
  );
  if (server === undefined) {
    return false;
  }

  if (server.kind === "connect") {
    await serverTargetStore.setConnectServer({
      handle: server.handle,
      name: server.name,
      url: server.url,
    });
    return true;
  }

  const targetKind =
    server.id === BUILTIN_SERVER_ID ? BUILTIN_SERVER_ID : CUSTOM_SERVER_ID;
  const switched = await serverTargetStore.setTarget(targetKind);
  if (!switched) {
    refreshApplicationMenu();
    return false;
  }
  return true;
}

async function setActiveServerTarget(serverId: string): Promise<void> {
  if (!(await persistServerTargetSelection(serverId))) {
    refreshApplicationMenu();
    return;
  }
  await applyServerTarget();
}

async function openSetServerUrlDialog(): Promise<void> {
  if (serverTargetStore === null || serverUrlDialogPreloadPath === null) {
    return;
  }
  const result = await openServerUrlDialog({
    initialUrl: serverTargetStore.getCustomServerUrl(),
    parentWindow: getFocusedApplicationWindow(),
    preloadPath: serverUrlDialogPreloadPath,
  });
  if (result.kind === "cancelled") {
    return;
  }
  if (
    result.kind === "clear" &&
    serverTargetStore.getCustomServerUrl() === null
  ) {
    return;
  }
  await serverTargetStore.setCustomServerUrl(
    result.kind === "set" ? result.url : null,
  );
  await applyServerTarget();
}

function registerDesktopServerIpc(): void {
  ipcMain.handle(BB_DESKTOP_GET_SERVER_STATE_CHANNEL, (event) => {
    if (!isApplicationRendererSender(event)) {
      throw new Error("Unexpected desktop server-state sender");
    }
    return getCurrentDesktopServerState();
  });
  ipcMain.handle(BB_DESKTOP_REFRESH_SERVERS_CHANNEL, async (event) => {
    if (!isApplicationRendererSender(event)) {
      throw new Error("Unexpected desktop server-refresh sender");
    }
    await connectServerSync?.syncNow();
    return getCurrentDesktopServerState();
  });
  ipcMain.handle(
    BB_DESKTOP_SELECT_SERVER_CHANNEL,
    async (event, payload: unknown) => {
      if (!isApplicationRendererSender(event)) {
        throw new Error("Unexpected desktop server-selection sender");
      }
      const request = bbDesktopSelectServerRequestSchema.parse(payload);
      if (!(await persistServerTargetSelection(request.serverId))) {
        throw new Error("The selected bb server is no longer available");
      }
      // Resolve the renderer's invoke before loading another origin tears down
      // its page. The target is already durable at this point.
      setTimeout(() => {
        void applyServerTarget();
      }, 0);
    },
  );
  ipcMain.on(BB_DESKTOP_OPEN_CUSTOM_SERVER_DIALOG_CHANNEL, (event) => {
    if (!isApplicationRendererSender(event)) {
      return;
    }
    void openSetServerUrlDialog();
  });
}

function sendLogViewerSnapshot(args: SendLogViewerSnapshotArgs): void {
  if (args.browserWindow.isDestroyed()) {
    return;
  }
  args.browserWindow.webContents.send(LOG_VIEWER_SNAPSHOT_CHANNEL, {
    lines: args.lines,
    logDir: args.logDir,
  });
}

function appendLogViewerLines(args: AppendLogViewerLinesArgs): void {
  if (args.lines.length === 0) {
    return;
  }

  logViewerLineBuffer?.append(args.lines);
}

function closeServerDaemonLogsWindow(): void {
  logViewerTailer?.stop();
  logViewerTailer = null;
  logViewerLineBuffer?.stop();
  logViewerLineBuffer = null;

  const browserWindow = logViewerWindow;
  logViewerWindow = null;
  if (browserWindow !== null && !browserWindow.isDestroyed()) {
    browserWindow.close();
  }
}

function handleCopyLogs(args: HandleCopyLogsArgs): void {
  const request = logViewerCopyRequestSchema.parse(args.request);
  clipboard.writeText(request.text);
}

async function handleOpenLogsFolder(): Promise<LogViewerOpenLogsFolderResult> {
  if (!shouldEnableServerDaemonLogsMenu()) {
    throw new Error(
      "Server and daemon logs are only available for owned runtimes",
    );
  }

  const logDir = formatLogDirectory();
  const errorMessage = await shell.openPath(logDir);
  if (errorMessage.length > 0) {
    throw new Error(errorMessage);
  }
  return { path: logDir };
}

function installLogViewerIpcHandlers(): void {
  if (logViewerIpcHandlersInstalled) {
    return;
  }
  logViewerIpcHandlersInstalled = true;
  ipcMain.handle(
    LOG_VIEWER_COPY_CHANNEL,
    (_event, request: LogViewerCopyRequest) => {
      handleCopyLogs({ request });
    },
  );
  ipcMain.handle(LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL, () =>
    handleOpenLogsFolder(),
  );
}

async function loadLogViewerWindow(
  args: LoadLogViewerWindowArgs,
): Promise<void> {
  const browserWindow = new BrowserWindow({
    height: 720,
    minHeight: 520,
    minWidth: 840,
    show: false,
    title: "bb - Server & Daemon Logs",
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
    },
    width: 1180,
  });
  const tailer = createLogTailer({
    logDir: args.logDir,
    onLines(lines) {
      appendLogViewerLines({ lines });
    },
  });
  const lineBuffer = createLogLineBuffer({
    flushIntervalMs: LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
    flushLineCount: LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
    maxLines: LOG_VIEWER_VISIBLE_LINE_LIMIT,
    onFlush(lines) {
      if (logViewerWindow === null || logViewerWindow.isDestroyed()) {
        return;
      }
      logViewerWindow.webContents.send(LOG_VIEWER_APPEND_CHANNEL, {
        lines,
      });
    },
  });

  logViewerLineBuffer = lineBuffer;
  logViewerTailer = tailer;
  logViewerWindow = browserWindow;

  browserWindow.once("ready-to-show", () => {
    browserWindow.show();
  });
  browserWindow.on("closed", () => {
    if (logViewerTailer === tailer) {
      logViewerTailer = null;
      tailer.stop();
    }
    if (logViewerWindow === browserWindow) {
      logViewerWindow = null;
    }
    if (logViewerLineBuffer === lineBuffer) {
      logViewerLineBuffer = null;
    }
    lineBuffer.stop();
  });

  await browserWindow.loadURL(createLogViewerViewUrl({ logDir: args.logDir }));
  sendLogViewerSnapshot({
    browserWindow,
    lines: lineBuffer.lines(),
    logDir: args.logDir,
  });
  await tailer.start();
}

async function openServerDaemonLogs(): Promise<void> {
  if (!shouldEnableServerDaemonLogsMenu() || logViewerPreloadPath === null) {
    return;
  }

  if (logViewerWindow !== null && !logViewerWindow.isDestroyed()) {
    logViewerWindow.focus();
    return;
  }

  await loadLogViewerWindow({
    logDir: formatLogDirectory(),
    preloadPath: logViewerPreloadPath,
  });
}

async function loadWindowUrl(args: LoadWindowUrlArgs): Promise<void> {
  startupRetryUrl = null;
  currentWindowUrl = args.url;
  if (desktopWindowFactory === null) {
    return;
  }

  await desktopWindowFactory.loadUrl({ url: args.url });
}

async function loadLoadingView(): Promise<void> {
  bbAppLoaded = false;
  await loadWindowUrl({
    url: createLocalViewUrl({
      viewModel: {
        kind: "loading",
        message: "Starting local services and opening the bb workspace.",
        title: "Opening bb",
      },
    }),
  });
}

async function loadNativeClientPairingView(args: {
  approvalUrl: string;
  coordinator: string;
  deviceName: string;
  expiresAt: number;
  userCode: string;
}): Promise<void> {
  bbAppLoaded = false;
  await loadWindowUrl({
    url: createLocalViewUrl({
      viewModel: { kind: "pairing", ...args },
    }),
  });
}

async function loadStartupError(args: LoadStartupErrorArgs): Promise<void> {
  bbAppLoaded = false;
  const url = createLocalViewUrl({
    viewModel: {
      details: `${args.details} Logs are under ${formatLogDirectory()}/.`,
      kind: "error",
      logText: args.logs,
      retryable: args.retryable,
      title: args.title,
    },
  });
  const loading = loadWindowUrl({ url });
  startupRetryUrl = args.retryable ? url : null;
  await loading;
}

async function loadBbApp(serverUrl: string): Promise<void> {
  bbAppLoaded = true;
  await loadWindowUrl({ url: serverUrl });
  if (shouldOpenDevTools()) {
    desktopWindowFactory?.openDevTools();
  }
}

function shouldOpenDevTools(): boolean {
  return process.env.BB_DESKTOP_OPEN_DEVTOOLS === "1";
}

async function createApplicationWindow(
  args: CreateApplicationWindowArgs,
): Promise<DesktopBrowserWindow | null> {
  if (desktopWindowFactory === null) {
    return null;
  }

  const browserWindow = await desktopWindowFactory.createWindow({
    initialUrl: args.initialUrl,
    stateKey: args.stateKey,
  });
  registerApplicationWindow(browserWindow);
  if (bbAppLoaded && shouldOpenDevTools()) {
    browserWindow.webContents.openDevTools({ mode: "detach" });
  }
  return browserWindow;
}

async function stopOwnedRuntime(): Promise<void> {
  const runtime = currentRuntime;
  if (runtime === null || runtime.ownership !== "spawned") {
    setCurrentRuntime(null);
    return;
  }

  setCurrentRuntime(null);
  try {
    await runtime.bbProcess?.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: OWNED_RUNTIME_KILL_TIMEOUT_MS,
      signal: "SIGTERM",
      timeoutMs: OWNED_RUNTIME_STOP_TIMEOUT_MS,
    });
  } finally {
    if (runtime.userDataPath !== null) {
      await clearOwnedRuntimePidFile({ userDataPath: runtime.userDataPath });
    }
  }
}

function handleBeforeQuit(event: Event): void {
  quitting = true;
  if (stoppingForQuit) {
    return;
  }

  event.preventDefault();
  stoppingForQuit = true;
  void finishQuit().finally(() => {
    app.quit();
  });
}

async function finishQuit(): Promise<void> {
  desktopBrowserBrokerClient?.stop();
  desktopBrowserBroker?.dispose();
  stopSystemConfigSync();
  connectSessionRenewal?.stop();
  desktopUpdateChannelWatcher?.close();
  desktopUpdateChannelWatcher = null;
  desktopUpdateService?.stop();
  desktopAutoUpdateService?.stop();
  desktopBrowserViewManager?.destroyAll();
  await desktopWindowFactory?.persistOpenWindows();
  await stopRemoteDesktopServices();
  await stopOwnedRuntime();
}

function registerDesktopUpdateIpc(): void {
  ipcMain.handle(BB_DESKTOP_GET_INFO_CHANNEL, () => {
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(BB_DESKTOP_GET_WINDOW_STATE_CHANNEL, (event) => {
    return getSenderDesktopWindowState(event);
  });
  ipcMain.handle(BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL, async () => {
    await openServerDaemonLogs();
  });
  ipcMain.handle(BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL, async () => {
    await Promise.all([
      desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null),
      desktopAutoUpdateService?.checkForUpdates() ?? Promise.resolve(null),
    ]);
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(BB_DESKTOP_INSTALL_UPDATE_CHANNEL, async () => {
    if (desktopAutoUpdateService === null) {
      return;
    }
    if (!desktopAutoUpdateService.getInfo().updateDownloaded) {
      desktopAutoUpdateService.installUpdate();
      return;
    }
    const appImagePath = process.env.APPIMAGE?.trim() ?? "";
    if (
      process.platform === "linux" &&
      (appImagePath.length === 0 || !canReplaceAppImage(appImagePath))
    ) {
      createDesktopLogger().error(
        `Desktop update install skipped: ${appImagePath || "this build"} cannot be replaced in place. The runtime stays up; download the new AppImage instead.`,
      );
      return;
    }
    quitting = true;
    stoppingForQuit = true;
    await finishQuit();
    desktopAutoUpdateService.installUpdate();
  });
  ipcMain.handle(
    BB_DESKTOP_SET_UPDATE_CHANNEL_CHANNEL,
    async (_event, payload: unknown) => {
      if (DESKTOP_BUILD_FLAVOR !== "release") {
        throw new Error(
          "BB Mesh Preview does not use signed release update channels",
        );
      }
      const channel = bbDesktopUpdateChannelSchema.parse(payload);
      if (desktopUpdateChannelController === null) {
        throw new Error("Desktop update channel controller is unavailable");
      }
      await desktopUpdateChannelController.setChannel(channel);
      await Promise.all([
        desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null),
        desktopAutoUpdateService?.checkForUpdates() ?? Promise.resolve(null),
      ]);
      return getCurrentDesktopInfo();
    },
  );
  ipcMain.on(BB_DESKTOP_SET_THEME_CHANNEL, (_event, payload: unknown) => {
    const parsed = bbDesktopThemeSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    nativeTheme.themeSource = parsed.data;
  });
  ipcMain.on(STARTUP_RETRY_CHANNEL, (event, ...payload: unknown[]) => {
    if (
      payload.length !== 0 ||
      startupRetryUrl === null ||
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== startupRetryUrl
    ) {
      return;
    }
    void retryStartup();
  });

  ipcMain.on(BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, (event, payload) => {
    const pending = pendingCloseWindowRequests.get(event.sender.id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingCloseWindowRequests.delete(event.sender.id);
    }
    if (payload === false) {
      resolveApplicationWindow(event.sender)?.close();
    }
  });
  ipcMain.on(
    BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
    (_event, payload: unknown) => {
      if (typeof payload !== "string") {
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(payload);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
      void shell.openExternal(parsed.toString());
    },
  );
}

function registerDesktopNetworkIpc(): void {
  ipcMain.handle(
    BB_DESKTOP_RESOLVE_MACHINE_ADDRESSES_CHANNEL,
    async (_event, payload: unknown) => {
      const request = bbDesktopMachineAddressRequestSchema.parse(payload);
      return bbDesktopMachineAddressResponseSchema.parse(
        await resolveMachineNetworkAddresses(request),
      );
    },
  );
}

interface DesktopBrowserWindowLifecycleArgs {
  browserWindow: BrowserWindow;
  manager: DesktopBrowserViewManager;
}

const WINDOW_RESIZE_SETTLE_MS = 200;

function registerDesktopBrowserWindowLifecycle({
  browserWindow,
  manager,
}: DesktopBrowserWindowLifecycleArgs): void {
  const hostWebContentsId = browserWindow.webContents.id;
  let resizeSettleTimer: NodeJS.Timeout | null = null;
  const endWindowResize = () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    if (!browserWindow.isDestroyed()) {
      manager.endWindowResize(browserWindow);
    }
  };
  browserWindow.on("resize", () => {
    manager.beginWindowResize(browserWindow);
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
    }
    resizeSettleTimer = setTimeout(endWindowResize, WINDOW_RESIZE_SETTLE_MS);
  });
  browserWindow.on("resized", endWindowResize);
  browserWindow.once("closed", () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    manager.releaseWindow(hostWebContentsId);
  });
}

async function startOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<DesktopRuntime | null> {
  const bbProcess = startBbAppProcess({
    bridgePath: args.bridgePath,
    cwd: homedir(),
    env: {
      ...createDesktopRuntimeProcessEnv({
        env: process.env,
        profile: args.profile,
      }),
      [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP,
    },
    logLineLimit: PROCESS_LOG_LINE_LIMIT,
    runtime: resolveBbAppProcessRuntime({
      env: process.env,
      isPackaged: app.isPackaged,
      platform: process.platform,
      processExecPath: process.execPath,
    }),
  });
  const runtime: DesktopRuntime = {
    bbProcess,
    ownership: "spawned",
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  };
  await writeOwnedRuntimePidFile({
    bridgePath: args.bridgePath,
    pid: bbProcess.pid,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  setCurrentRuntime(runtime);

  void bbProcess.exit.then((exit) => {
    void clearOwnedRuntimePidFile({ userDataPath: args.userDataPath });
    if (quitting || currentRuntime !== runtime) {
      return;
    }
    setCurrentRuntime(null);
    void loadStartupError({
      details: `The Electron-owned bb-app process stopped with ${formatExitResult(
        exit,
      )}.`,
      logs: bbProcess.logs.text(),
      retryable: false,
      title: "bb stopped",
    });
  });

  const raceResult = await Promise.race<StartupRaceResult>([
    waitForCompatibleServer({
      intervalMs: STARTUP_POLL_INTERVAL_MS,
      serverUrl: args.serverUrl,
      timeoutMs: STARTUP_TIMEOUT_MS,
    }).then((result) => ({
      kind: "server-probe",
      result,
    })),
    bbProcess.exit.then((exit) => ({
      exit,
      kind: "process-exited",
    })),
  ]);

  if (raceResult.kind === "process-exited") {
    await loadStartupError({
      details: `bb-app exited before the server was ready with ${formatExitResult(
        raceResult.exit,
      )}.`,
      logs: bbProcess.logs.text(),
      retryable: false,
      title: "Could not start bb",
    });
    setCurrentRuntime(null);
    return null;
  }

  if (raceResult.result.kind === "compatible") {
    if (canAttachCompatibleRuntime(raceResult.result, args.profile)) {
      return runtime;
    }
    await loadStartupError({
      details:
        `Another bb product claimed ${raceResult.result.serverUrl} while BB Mesh was starting. ` +
        "BB Mesh will not connect to it or show its interface.",
      logs: bbProcess.logs.text(),
      retryable: false,
      title: "BB Mesh runtime conflict",
    });
    await stopOwnedRuntime();
    return null;
  }

  await loadStartupError({
    details:
      raceResult.result.kind === "incompatible"
        ? `Port ${args.serverUrl} is responding, but it does not look like bb: ${raceResult.result.reason}.`
        : `Timed out waiting for bb at ${args.serverUrl}: ${raceResult.result.reason}.`,
    logs: bbProcess.logs.text(),
    retryable: false,
    title: "Could not start bb",
  });
  await stopOwnedRuntime();
  return null;
}

interface InitializeRuntimeArgs {
  bridgePath: string;
  profile: DesktopRuntimeProfile;
  serverUrl: string;
  userDataPath: string;
}

function shouldAskBeforeAttaching(): boolean {
  if (!app.isPackaged || existingServerDialogPreloadPath === null) {
    return false;
  }
  if (process.env.BB_DESKTOP_ATTACH_WITHOUT_PROMPT === "1") {
    return false;
  }
  return (process.env.BB_DESKTOP_APP_URL ?? "").trim().length === 0;
}

async function waitForServerToStop(serverUrl: string): Promise<boolean> {
  const deadline = Date.now() + FOREIGN_RUNTIME_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const probe = await probeBbServer({
      serverUrl,
      timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
    });
    if (probe.kind === "unavailable") {
      return true;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, STARTUP_POLL_INTERVAL_MS);
    });
  }
  return false;
}

type ExistingServerDecision = "attach" | "quit" | "start-fresh";

async function decideOnExistingServer(
  probe: CompatibleServerProbeResult,
): Promise<ExistingServerDecision> {
  if (!shouldAskBeforeAttaching()) {
    return "attach";
  }

  const preloadPath = existingServerDialogPreloadPath;
  if (preloadPath === null) {
    return "attach";
  }

  const details = await readForeignRuntimeDetails({
    dataDir: probe.dataDir,
    serverUrl: probe.serverUrl,
  });
  const choice = await openExistingServerDialog({
    details,
    parentWindow: getFocusedApplicationWindow(),
    preloadPath,
    serverUrl: probe.serverUrl,
  });

  if (choice === "quit") {
    return "quit";
  }
  if (choice === "connect" || details === null) {
    return "attach";
  }

  const stopResult = await stopForeignRuntime({
    details,
    killTimeoutMs: FOREIGN_RUNTIME_KILL_TIMEOUT_MS,
    timeoutMs: FOREIGN_RUNTIME_STOP_TIMEOUT_MS,
  });
  if (stopResult.kind === "unverified") {
    await loadStartupError({
      details:
        `The bb at ${probe.serverUrl} records process ${String(stopResult.pid)}, but that ` +
        "process no longer matches the record. bb did not stop it. Stop it yourself, then open bb again.",
      logs: "",
      retryable: false,
      title: "Could not stop the running bb",
    });
    return "quit";
  }
  if (stopResult.kind === "still-running") {
    await loadStartupError({
      details: `bb could not stop process ${String(stopResult.pid)}, even after SIGKILL.`,
      logs: "",
      retryable: false,
      title: "Could not stop the running bb",
    });
    return "quit";
  }
  if (stopResult.kind === "replaced") {
    await loadStartupError({
      details:
        `Another bb started at ${probe.serverUrl} while the question was open, so bb stopped nothing. ` +
        "Open bb again to see the copy that runs now.",
      logs: "",
      retryable: false,
      title: "Could not stop the running bb",
    });
    return "quit";
  }
  if (!(await waitForServerToStop(probe.serverUrl))) {
    await loadStartupError({
      details: `The bb at ${probe.serverUrl} stopped, but the address is still in use.`,
      logs: "",
      retryable: false,
      title: "Could not stop the running bb",
    });
    return "quit";
  }
  return "start-fresh";
}

async function initializeRuntime(args: InitializeRuntimeArgs): Promise<void> {
  const existingProbe = await probeBbServer({
    serverUrl: args.serverUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    if (!canAttachCompatibleRuntime(existingProbe, args.profile)) {
      await loadStartupError({
        details:
          `Another bb product is already using ${existingProbe.serverUrl}. ` +
          "BB Mesh will not connect to it or show its interface.",
        logs: "",
        retryable: false,
        title: "BB Mesh runtime conflict",
      });
      return;
    }
    const decision = await decideOnExistingServer(existingProbe);
    if (decision === "quit") {
      app.quit();
      return;
    }
    if (decision === "start-fresh") {
      await loadLoadingView();
      const freshRuntime = await startOwnedRuntime({
        bridgePath: args.bridgePath,
        profile: args.profile,
        serverUrl: args.serverUrl,
        userDataPath: args.userDataPath,
      });
      if (freshRuntime !== null) {
        await loadBbApp(freshRuntime.serverUrl);
        startSystemConfigSync(freshRuntime.serverUrl);
        refreshApplicationMenu();
      }
      return;
    }

    setCurrentRuntime({
      bbProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    await loadBbApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: existingProbe.serverUrl,
      }),
    );
    startSystemConfigSync(existingProbe.serverUrl);
    refreshApplicationMenu();
    return;
  }

  if (existingProbe.kind === "incompatible") {
    await loadStartupError({
      details: `Port ${args.serverUrl} is already in use, but it is not a compatible bb server: ${existingProbe.reason}.`,
      logs: "",
      retryable: false,
      title: "Port conflict",
    });
    return;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: args.bridgePath,
    profile: args.profile,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  if (runtime !== null) {
    await loadBbApp(runtime.serverUrl);
    startSystemConfigSync(runtime.serverUrl);
    refreshApplicationMenu();
  }
}

async function runDesktopApp(): Promise<void> {
  ensurePackagedUserShellPath({
    env: process.env,
    isPackaged: app.isPackaged,
    logger: createDesktopLogger(),
    platform: process.platform,
  });

  if (app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath(
      "userData",
      resolveDesktopUserDataPath({
        appDataPath: app.getPath("appData"),
        buildFlavor: DESKTOP_BUILD_FLAVOR,
      }),
    );
  }
  const applicationName = app.isPackaged
    ? DESKTOP_RELEASE_INFO.applicationName
    : "bb-dev";
  app.setName(applicationName);
  installAboutPanel(applicationName);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (desktopWindowFactory?.focusFirstWindow() === true) {
      return;
    }
    // An OS activation can arrive while the first BrowserWindow is still
    // restoring its persisted state. That pending window will become visible;
    // creating another here turns repeated Dock clicks into durable duplicate
    // windows that all reopen on the next launch.
    if (desktopWindowFactory?.hasOpenOrPendingWindows() === true) {
      return;
    }
    void createApplicationWindow({
      initialUrl: currentWindowUrl,
      stateKey: null,
    });
  });
  app.on("before-quit", handleBeforeQuit);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (desktopWindowFactory?.hasOpenOrPendingWindows() === false) {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    }
  });
  app.on("did-become-active", () => {
    void desktopUpdateService?.checkAfterActive();
    void desktopAutoUpdateService?.checkAfterActive();
    refreshRemoteSystemConfig?.();
    connectSessionRenewal?.renewIfDue();
  });
  app.on("browser-window-created", (_event, browserWindow) => {
    if (desktopBrowserViewManager === null) {
      return;
    }
    registerDesktopBrowserWindowLifecycle({
      browserWindow,
      manager: desktopBrowserViewManager,
    });
  });
  registerDesktopShutdownSignalHandlers({
    exitProcess(code) {
      process.exitCode = code;
    },
    processEvents: process,
    quitApplication() {
      app.quit();
    },
    state: createDesktopShutdownState(),
    async stopOwnedRuntime() {
      quitting = true;
      await stopRemoteDesktopServices();
      await stopOwnedRuntime();
    },
  });

  await app.whenReady();
  if (app.isPackaged) {
    await session.defaultSession.clearCache();
  }

  const paths = createDesktopPathContext();
  const iconPath = resolveDesktopIconPath({
    packagedIconFileName: DESKTOP_RELEASE_INFO.iconFileName,
    paths,
  });
  const bridgePath = resolveDesktopBridgePath({ paths });
  const rendererAssetsPath = resolveDesktopRendererAssetsPath({ paths });
  const resolvedLogViewerPreloadPath = join(
    paths.appPath,
    "dist",
    "log-viewer-preload.cjs",
  );
  const preloadPath = join(paths.appPath, "dist", "preload.cjs");
  const resolvedExistingServerDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "existing-server-dialog-preload.cjs",
  );
  const resolvedServerUrlDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "server-url-dialog-preload.cjs",
  );
  desktopBridgePath = bridgePath;
  desktopRendererAssetsPath = rendererAssetsPath;
  const desktopVersion = getDesktopVersion(process.env.BB_DESKTOP_VERSION);
  const desktopPlatform = resolveBbDesktopPlatform(process.platform);
  const userDataPath = app.getPath("userData");
  const runtimeProfile = resolveDesktopRuntimeProfile({
    allowPackagedPortOverrides:
      process.env.BB_DESKTOP_ATTACH_WITHOUT_PROMPT === "1",
    buildFlavor: DESKTOP_BUILD_FLAVOR,
    env: process.env,
    homeDir: homedir(),
    isPackaged: app.isPackaged,
    userDataPath,
  });
  const serverUrl = runtimeProfile.serverUrl;
  builtinServerUrl = serverUrl;
  desktopRuntimeProfile = runtimeProfile;
  desktopUserDataPath = userDataPath;

  assertPathExists({ label: "bb-app bridge", path: bridgePath });
  assertPathExists({
    label: "desktop renderer entry point",
    path: join(rendererAssetsPath, "index.html"),
  });
  assertPathExists({
    label: "existing server dialog preload script",
    path: resolvedExistingServerDialogPreloadPath,
  });
  assertPathExists({
    label: "log viewer preload script",
    path: resolvedLogViewerPreloadPath,
  });
  assertPathExists({ label: "preload script", path: preloadPath });
  assertPathExists({
    label: "server URL dialog preload script",
    path: resolvedServerUrlDialogPreloadPath,
  });
  assertPathExists({ label: "app icon", path: iconPath });

  if (
    process.platform === "darwin" &&
    app.dock !== undefined &&
    !paths.isPackaged
  ) {
    app.dock.setIcon(iconPath);
  }
  await reapStaleOwnedRuntime({
    signal: "SIGTERM",
    timeoutMs: 5_000,
    userDataPath,
  });

  serverTargetStore = createServerTargetStore({
    storagePath: join(userDataPath, SERVER_TARGET_FILE_NAME),
  });
  await serverTargetStore.load();
  const desktopUpdateChannelStoragePath = join(
    userDataPath,
    DESKTOP_UPDATE_CHANNEL_FILE_NAME,
  );
  const desktopUpdateChannelStore = createDesktopUpdateChannelStore({
    defaultChannel: DESKTOP_DEFAULT_UPDATE_CHANNEL,
    storagePath: desktopUpdateChannelStoragePath,
  });
  await desktopUpdateChannelStore.load();
  const desktopUpdateChannel = desktopUpdateChannelStore.getChannel();
  const desktopUpdateFeedUrl = resolveDesktopUpdateFeedUrl({
    channel: desktopUpdateChannel,
    env: process.env,
    platform: desktopPlatform,
  });
  connectCredentialCache = createConnectCredentialCache({
    encryption: safeStorage,
    platform: process.platform,
    userDataPath,
  });
  cachedConnectCredential = await connectCredentialCache.read();
  const logger = createDesktopLogger();
  connectServerSync = createConnectServerSync({
    getCredential: () => cachedConnectCredential,
    getLocalServerUrl: () => currentRuntime?.serverUrl ?? null,
    onUnauthorized() {
      void clearCachedConnectCredential();
    },
    onSkipped(reason) {
      connectServerSyncSkipReason = reason;
      refreshApplicationMenu();
    },
    onServers(servers) {
      connectAccountServers = servers;
      connectServerSyncSkipReason = null;
      const selected = serverTargetStore?.getConnectServer() ?? null;
      const synced = servers.find(
        (server) => server.handle === selected?.handle,
      );
      if (synced !== undefined) {
        void serverTargetStore?.refreshConnectServer({
          handle: synced.handle,
          name: synced.name,
          url: synced.url,
        });
      }
      refreshApplicationMenu();
      sendDesktopServerStateChanged();
    },
    log: (message) => {
      logger.info(`[desktop] ${message}`);
    },
  });
  connectServerSync.start();
  connectSessionRenewal = createConnectSessionRenewal({
    async authenticate(remoteServerUrl, isCurrent) {
      const result = await authenticateConnectTarget(
        remoteServerUrl,
        isCurrent,
      );
      return result.ok
        ? result
        : { detail: `${result.code}: ${result.detail}`, ok: false };
    },
    log: (message) => {
      logger.warn(`[desktop] ${message}`);
    },
  });

  const desktopUpdateSupport = resolveDesktopUpdateSupport({
    canReplaceAppImage,
    env: process.env,
    platform: desktopPlatform,
  });
  desktopUpdateService = createDesktopUpdateService({
    channel: desktopUpdateChannel,
    currentVersion: desktopVersion,
    enabled:
      DESKTOP_BUILD_FLAVOR === "release" &&
      desktopUpdateSupport.versionCheck &&
      (app.isPackaged || process.env.BB_DESKTOP_VERSION_CHECK === "1"),
    feedUrl: desktopUpdateFeedUrl,
    logger: createDesktopLogger(),
    platform: desktopPlatform,
  });
  desktopAutoUpdateService = createDesktopAutoUpdateService({
    currentVersion: desktopVersion,
    enabled:
      desktopUpdateSupport.autoUpdate &&
      shouldEnableDesktopAutoUpdate({
        env: process.env,
        isPackaged: app.isPackaged,
        releaseIdentity: DESKTOP_BUILD_FLAVOR === "release",
      }),
    feedConfig: createDesktopAutoUpdateFeedConfig(desktopUpdateChannel),
    forceDevUpdateConfig:
      DESKTOP_BUILD_FLAVOR === "release" &&
      !app.isPackaged &&
      process.env.BB_DESKTOP_AUTO_UPDATE === "1",
    logger: createDesktopLogger(),
    platform: desktopPlatform,
    updater: createElectronAutoUpdaterAdapter(autoUpdater),
  });
  desktopUpdateChannelController = createDesktopUpdateChannelController({
    autoUpdateService: desktopAutoUpdateService,
    channelStore: desktopUpdateChannelStore,
    platform: desktopPlatform,
    updateService: desktopUpdateService,
  });
  if (DESKTOP_BUILD_FLAVOR === "release") {
    desktopUpdateChannelWatcher = startDesktopUpdateChannelWatcher({
      logger,
      async onChannel(channel) {
        if (desktopUpdateChannelController?.getChannel() === channel) return;
        await desktopUpdateChannelController?.reconcilePersistedChannel(
          channel,
        );
        await Promise.all([
          desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null),
          desktopAutoUpdateService?.checkForUpdates() ?? Promise.resolve(null),
        ]);
      },
      storagePath: desktopUpdateChannelStoragePath,
    });
  }
  desktopUpdateService.subscribe(() => {
    sendDesktopInfoChanged();
  });
  desktopAutoUpdateService.subscribe(() => {
    sendDesktopInfoChanged();
  });
  registerDesktopUpdateIpc();
  registerDesktopNetworkIpc();
  registerDesktopServerIpc();
  desktopBrowserViewManager = createDesktopBrowserViewManager({
    dispatchAppCommand({ command, hostWebContentsId }) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow === undefined) {
        return;
      }
      sendToApplicationRenderer(
        browserWindow,
        BB_DESKTOP_APP_COMMAND_CHANNEL,
        command,
      );
    },
    focusHostWebContents(hostWebContentsId) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow !== undefined) {
        browserWindow.webContents.focus();
      }
    },
    resolveAppCommand(input) {
      return resolveDesktopBrowserAppCommand({
        input,
        isMac: process.platform === "darwin",
        keybindings: currentAppKeybindings,
      });
    },
  });
  registerDesktopBrowserIpc(desktopBrowserViewManager);
  const browserImportService = createBrowserImportService({
    context: { platform: process.platform, home: homedir() },
    resolveIcon: (appPath) => readMacAppIcon(appPath),
    log(message, details) {
      createDesktopLogger().info(
        `[desktop] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`,
      );
    },
  });
  desktopBrowserBroker = createDesktopBrowserBroker({
    manager: desktopBrowserViewManager,
    product: `Chrome/${process.versions.chrome}`,
    browserImport: browserImportService,
  });
  ipcMain.handle(
    BB_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    async (event) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) return null;
      return { sources: await browserImportService.listSources() };
    },
  );
  ipcMain.handle(
    BB_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
    async (event, payload: unknown) => {
      const parsed =
        bbDesktopBrowserImportCookiesRequestSchema.safeParse(payload);
      if (
        !parsed.success ||
        !applicationWindowWebContentsIds.has(event.sender.id)
      )
        return null;
      const manager = desktopBrowserViewManager;
      if (!manager) return null;
      return browserImportService.importCookies(
        {
          sourceId: parsed.data.sourceId,
          sourceProfileDirectory: parsed.data.sourceProfileDirectory,
        },
        manager.profileSession(parsed.data.profile),
      );
    },
  );
  ipcMain.on(
    BB_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    (event) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        process.platform !== "darwin"
      )
        return;
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    },
  );
  ipcMain.handle(BB_DESKTOP_BROWSER_TARGET_CHANNEL, (event) => {
    return applicationWindowWebContentsIds.has(event.sender.id)
      ? (desktopBrowserBroker?.getTarget(event.sender.id) ?? null)
      : null;
  });
  ipcMain.handle(
    BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
      return parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
        ? (desktopBrowserBroker?.getControl(
            event.sender.id,
            parsed.data.tabId,
          ) ?? null)
        : null;
    },
  );
  ipcMain.on(
    BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
      if (
        parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
      )
        desktopBrowserBroker?.takeOver(event.sender.id, parsed.data.tabId);
    },
  );
  desktopBrowserBrokerClient = createDesktopBrowserBrokerClient({
    broker: desktopBrowserBroker,
    dataDir: resolveDataDirFromEnv({ env: process.env, homeDir: homedir() }),
    homeDir: homedir(),
    getServerUrl() {
      const target = serverTargetStore?.getTarget();
      if (target?.kind === "connect") return target.server.url;
      if (target?.kind === "custom") return target.url;
      return currentRuntime?.serverUrl ?? builtinServerUrl;
    },
  });
  if (desktopUpdateSupport.versionCheck) {
    desktopUpdateService.start();
  }
  if (desktopUpdateSupport.autoUpdate) {
    desktopAutoUpdateService.start();
  } else {
    logger.info(
      "Desktop auto-install is disabled: only the Linux AppImage build can replace itself. Version checks still report new releases.",
    );
  }

  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      return new BrowserWindow(options);
    },
  };
  logViewerPreloadPath = resolvedLogViewerPreloadPath;
  serverUrlDialogPreloadPath = resolvedServerUrlDialogPreloadPath;
  existingServerDialogPreloadPath = resolvedExistingServerDialogPreloadPath;
  desktopWindowFactory = createDesktopWindowFactory({
    browserWindowCreator,
    createWindowStateKey() {
      return `window-${randomUUID()}`;
    },
    displayWorkAreas: null,
    icon: nativeImage.createFromPath(iconPath),
    isLinuxTransparent: shouldUseLinuxTransparentWindow({
      argv: process.argv,
      platform: process.platform,
    }),
    isMac: process.platform === "darwin",
    isLinuxFrameless: shouldUseLinuxFramelessWindow({
      argv: process.argv,
      platform: process.platform,
    }),
    isQuitting() {
      return quitting;
    },
    openExternalUrl(openArgs) {
      void shell.openExternal(openArgs.url);
    },
    preloadPath,
    userDataPath,
  });
  installLogViewerIpcHandlers();

  refreshApplicationMenu();
  await loadLoadingView();
  const restoredWindows = await desktopWindowFactory.restoreSavedWindows({
    initialUrl: currentWindowUrl,
  });
  for (const browserWindow of restoredWindows) {
    registerApplicationWindow(browserWindow);
  }
  if (serverTargetStore.getTarget().kind === "builtin") {
    await initializeRuntime({
      bridgePath,
      profile: runtimeProfile,
      serverUrl,
      userDataPath,
    });
  } else {
    await applyServerTarget();
    connectServerSync.syncNow().catch(() => {});
  }
}

void runDesktopApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  void loadStartupError({
    details: message,
    logs: "",
    retryable: false,
    title: "Could not open bb",
  });
});
