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

export function createNoopDesktopBrowserApi(): BbDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    focus() {},
    setBounds() {},
    setVisible() {},
    setVisibleWithoutFocus() {},
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
    onFocus() {
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
    async setUpdateChannel(updateChannel) {
      return { ...info, updateChannel };
    },
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
