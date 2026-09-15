import { useEffect, type ReactNode } from "react";
import type {
  BbDesktopApi,
  BbDesktopBrowserApi,
  BbDesktopBrowserState,
  BbDesktopInfo,
  BbDesktopServerState,
} from "@bb/desktop-contract";

const STORY_DESKTOP_INFO: BbDesktopInfo = {
  downloadState: "idle",
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updatesEnabled: true,
  updateAvailable: false,
  updateChannel: "stable",
  updateDownloaded: false,
  version: "0.0.0-story",
};

const STORY_DESKTOP_SERVER_STATE: BbDesktopServerState = {
  activeServerId: "builtin",
  executionHost: null,
  servers: [
    {
      id: "builtin",
      kind: "builtin",
      name: "This Mac",
      url: "http://127.0.0.1:38886",
    },
  ],
};

function createStoryDesktopBrowserApi(
  initialState: BbDesktopBrowserState | null,
): BbDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    setBounds() {},
    setVisible() {},
    onState(listener) {
      let subscribed = true;
      if (initialState !== null) {
        queueMicrotask(() => {
          if (subscribed) listener(initialState);
        });
      }
      return () => {
        subscribed = false;
      };
    },
    onOpenTab() {
      return () => {};
    },
  };
}

function createStoryDesktopApi(
  browserState: BbDesktopBrowserState | null,
): BbDesktopApi {
  return {
    ...STORY_DESKTOP_INFO,
    browser: createStoryDesktopBrowserApi(browserState),
    network: {
      async resolveMachineAddresses({ hostname }) {
        return {
          addresses: hostname === "This Mac" ? ["127.0.0.1"] : [],
          resolvedHostname: hostname === "This Mac" ? "localhost" : null,
        };
      },
    },
    server: {
      async getState() {
        return STORY_DESKTOP_SERVER_STATE;
      },
      async refresh() {
        return STORY_DESKTOP_SERVER_STATE;
      },
      onStateChange() {
        return () => {};
      },
      async select() {},
      openCustomServerDialog() {},
    },
    async checkForUpdates() {
      return STORY_DESKTOP_INFO;
    },
    async getInfo() {
      return STORY_DESKTOP_INFO;
    },
    async installUpdate() {},
    async setUpdateChannel(updateChannel) {
      return { ...STORY_DESKTOP_INFO, updateChannel };
    },
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}

interface WithDesktopBrowserProps {
  browserState?: BbDesktopBrowserState | null;
  children: ReactNode;
}

export function WithDesktopBrowser({
  browserState = null,
  children,
}: WithDesktopBrowserProps) {
  if (typeof window !== "undefined" && window.bbDesktop === undefined) {
    window.bbDesktop = createStoryDesktopApi(browserState);
  }
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        delete window.bbDesktop;
      }
    };
  }, []);
  return <>{children}</>;
}
