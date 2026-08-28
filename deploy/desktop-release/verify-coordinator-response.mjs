import { fileURLToPath } from "node:url";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyCoordinatorVersionResponse(
  value,
  expectedVersion,
  expectedProtocolVersion,
) {
  if (
    !isRecord(value) ||
    value.version !== expectedVersion ||
    value.protocolVersion !== expectedProtocolVersion
  ) {
    throw new Error(
      `Coordinator version mismatch: expected desktop/app ${expectedVersion} and protocol ${expectedProtocolVersion}.`,
    );
  }
}

async function main() {
  const [expectedVersion, rawExpectedProtocolVersion] = process.argv.slice(2);
  const expectedProtocolVersion = Number(rawExpectedProtocolVersion);
  if (
    expectedVersion === undefined ||
    !Number.isSafeInteger(expectedProtocolVersion) ||
    expectedProtocolVersion <= 0
  ) {
    throw new Error(
      "Usage: verify-coordinator-response.mjs <expected-version> <expected-protocol-version>",
    );
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  verifyCoordinatorVersionResponse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    expectedVersion,
    expectedProtocolVersion,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
