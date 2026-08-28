import { useEffect, type ReactNode } from "react";
import type {
  BbDesktopApi,
  BbDesktopBrowserApi,
  BbDesktopBrowserState,
  BbDesktopInfo,
  BbDesktopServerState,
} from "@bb/desktop-contract";

// A minimal, inert desktop bridge for stories that need the desktop-only browser
// surface to register as available. The browser methods are no-ops: the native
// `WebContentsView` only exists in the packaged desktop app, so in a story the
// browser tab renders its chrome + new-tab screen and never a live page.
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

/**
 * Installs an inert `window.bbDesktop` so stories can exercise the desktop-only
 * browser surface — the launcher's "Open browser" entry and the browser tab.
 * The bridge is set synchronously during render (before children read
 * `isDesktopBrowserAvailable()`, which runs at render time) and removed on
 * unmount so it never leaks into the web-build stories that must see the surface
 * as absent. Use exactly one wrapper per story page.
 */
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
