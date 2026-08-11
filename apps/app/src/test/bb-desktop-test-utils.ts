import type {
  BbDesktopApi,
  BbDesktopBrowserApi,
  BbDesktopInfo,
  BbDesktopNetworkApi,
  BbDesktopServerApi,
  BbDesktopServerState,
} from "@bb/desktop-contract";

const TEST_DESKTOP_SERVER_STATE: BbDesktopServerState = {
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

/**
 * A no-op {@link BbDesktopBrowserApi} for tests that build a full
 * `BbDesktopApi` stub. The browser control surface is exercised separately; here
 * it just needs to satisfy the contract.
 */
export function createNoopDesktopBrowserApi(): BbDesktopBrowserApi {
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
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
  };
}

export function createNoopDesktopServerApi(): BbDesktopServerApi {
  return {
    async getState() {
      return TEST_DESKTOP_SERVER_STATE;
    },
    async refresh() {
      return TEST_DESKTOP_SERVER_STATE;
    },
    onStateChange() {
      return () => {};
    },
    async select() {},
    openCustomServerDialog() {},
  };
}

export function createNoopDesktopNetworkApi(): BbDesktopNetworkApi {
  return {
    async resolveMachineAddresses() {
      return { addresses: [], resolvedHostname: null };
    },
  };
}

/**
 * A full {@link BbDesktopApi} stub for tests that need `window.bbDesktop`. The
 * update/info methods echo `info`; theme and external-open are no-ops. Pass a
 * custom `browser` to exercise the browser control surface. Tests that drive
 * live info changes or assert on method spies build their own stub instead.
 */
export function createBbDesktopApi(
  info: BbDesktopInfo,
  browser: BbDesktopBrowserApi = createNoopDesktopBrowserApi(),
): BbDesktopApi {
  return {
    ...info,
    browser,
    network: createNoopDesktopNetworkApi(),
    server: createNoopDesktopServerApi(),
    async checkForUpdates() {
      return info;
    },
    async getInfo() {
      return info;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
