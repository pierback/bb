const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { app, ipcMain, shell } = require("electron");

const desktopRoot = process.env.BB_STARTUP_SMOKE_APP_PATH;
const scenario = process.env.BB_STARTUP_SMOKE_SCENARIO ?? "custom";
const channel = "bb-desktop:retry-startup";
const loads = [];
let contents;

assert.ok(
  scenario === "custom" || scenario === "fatal",
  `Unsupported startup retry scenario: ${scenario}`,
);

async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Timed out waiting for startup recovery");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function run() {
  const server = createServer((request, response) => {
    if (scenario === "fatal") {
      response.writeHead(503);
      response.end();
    } else if (
      request.method === "POST" &&
      request.url === "/api/v1/native-client-pairings"
    ) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 1,
          requestId: "pair_retry",
          requestSecret: "pair_retry_secret",
          userCode: "MESH-RETRY",
        }),
      );
    } else if (
      request.method === "POST" &&
      request.url === "/api/v1/native-client-pairings/pair_retry/poll"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          expiresAt: Date.now() + 60_000,
          hostId: "host_retry",
          joinCode: "join_retry",
          status: "approved",
        }),
      );
    } else if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    } else if (request.url === "/api/v1/system/config") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          hostDaemonPort: 38887,
          voiceTranscriptionEnabled: false,
        }),
      );
    } else if (request.url.startsWith("/api/")) {
      response.writeHead(404);
      response.end();
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end("<h1>Recovered</h1>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  if (scenario === "custom") {
    await new Promise((resolve) => server.close(resolve));
    process.env.BB_DESKTOP_APP_URL = serverUrl;
  }
  process.env.BB_SERVER_PORT = String(port);
  await writeFile(
    join(app.getPath("userData"), "server-target.json"),
    JSON.stringify(
      scenario === "fatal"
        ? { target: "builtin", customServerUrl: null }
        : { target: "custom", customServerUrl: serverUrl },
    ),
  );
  shell.openExternal = async () => {};
  app.setAppPath(desktopRoot);
  app.on("browser-window-created", (_event, window) => {
    contents = window.webContents;
    const loadURL = contents.loadURL.bind(contents);
    contents.loadURL = (url, options) => {
      loads.push(url);
      return loadURL(url, options);
    };
  });
  require(join(desktopRoot, "dist/main.js"));
  const errorTitle =
    scenario === "fatal"
      ? "Port conflict"
      : "Could not open the coordination server";
  const hasError = () =>
    contents?.getURL().startsWith("data:") &&
    contents.executeJavaScript(
      `document.querySelector("h1")?.textContent === ${JSON.stringify(errorTitle)}`,
    );
  await until(hasError);
  if (scenario === "fatal") {
    assert.equal(
      await contents.executeJavaScript(
        'document.querySelectorAll("button").length',
      ),
      0,
    );
    const before = loads.length;
    ipcMain.emit(channel, {
      sender: contents,
      senderFrame: contents.mainFrame,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(loads.length, before, "A fatal startup error cannot retry");
    server.close();
    console.log("STARTUP_RETRY_SMOKE_OK");
    app.exit(0);
    return;
  }
  assert.equal(
    await contents.executeJavaScript("typeof window.bbDesktop"),
    "object",
  );
  assert.equal(
    await contents.executeJavaScript(
      'document.querySelectorAll("[data-testid=bb-startup-retry]").length',
    ),
    1,
  );
  const rejected = loads.length;
  ipcMain.emit(
    channel,
    { sender: contents, senderFrame: contents.mainFrame },
    {},
  );
  ipcMain.emit(
    channel,
    { sender: contents, senderFrame: contents.mainFrame },
    undefined,
    "unexpected",
  );
  ipcMain.emit(channel, {
    sender: { id: -1 },
    senderFrame: contents.mainFrame,
  });
  ipcMain.emit(channel, {
    sender: contents,
    senderFrame: { url: contents.getURL() },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    loads.length,
    rejected,
    "Invalid payloads, unregistered senders and subframes must be rejected",
  );
  const errorUrl = contents.getURL();
  await contents.loadURL(
    "data:text/html;charset=utf-8,<h1>Unrelated local page</h1>",
  );
  const unrelated = loads.length;
  ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    loads.length,
    unrelated,
    "An unrelated data URL cannot retry startup",
  );
  await contents.loadURL(errorUrl);
  const failedRetry = loads.length;
  await contents.executeJavaScript('document.querySelector("button").click()');
  await until(() => loads.length > failedRetry);
  await until(hasError);
  if (scenario === "custom") {
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  }
  const before = loads.length;
  await contents.executeJavaScript(
    'const button = document.querySelector("[data-testid=bb-startup-retry]"); for (let i = 0; i < 10; i++) button.click();',
  );
  await until(() => {
    const currentUrl = contents.getURL();
    return (
      currentUrl.startsWith("http://127.0.0.1:") &&
      currentUrl !== `${serverUrl}/`
    );
  });
  await until(() =>
    contents.executeJavaScript(
      'document.querySelector("h1")?.textContent === "Recovered"',
    ),
  );
  const retryLoads = loads
    .slice(before)
    .filter((url) => url.startsWith("http://127.0.0.1:"));
  console.log(JSON.stringify({ scenario, retryLoads: retryLoads.length }));
  assert.equal(
    retryLoads.length,
    1,
    "Concurrent renderer clicks must apply the target once",
  );
  const after = loads.length;
  ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(loads.length, after, "Loaded remote pages cannot retry startup");
  server.close();
  console.log("STARTUP_RETRY_SMOKE_OK");
  app.exit(0);
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
