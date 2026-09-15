import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function requiredEnvironmentValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const dataDir = requiredEnvironmentValue("BB_DATA_DIR");
const hostId = requiredEnvironmentValue("BB_HOST_ID");
const port = Number(requiredEnvironmentValue("BB_HOST_DAEMON_PORT"));
const serverUrl = requiredEnvironmentValue("BB_SERVER_URL");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("BB_HOST_DAEMON_PORT must be a valid TCP port");
}

const hostKey = "startup-retry-smoke-host-key";
await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, "auth.json"),
  `${JSON.stringify({ hostId, hostKey })}\n`,
);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connected: true, hostId, serverUrl }));
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const desktopPid = process.ppid;
setInterval(() => {
  try {
    process.kill(desktopPid, 0);
  } catch {
    stop();
  }
}, 250).unref();
