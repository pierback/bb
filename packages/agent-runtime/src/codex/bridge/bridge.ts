#!/usr/bin/env node

import { isMainModule } from "../../shared/bridge-harness.js";
import { runCodexAppServerBridge } from "./transport.js";

if (isMainModule(import.meta.url)) {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  void runCodexAppServerBridge({
    input: process.stdin,
    output: process.stdout,
    signal: abortController.signal,
    socketPath: process.argv[2] ?? "",
  }).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
