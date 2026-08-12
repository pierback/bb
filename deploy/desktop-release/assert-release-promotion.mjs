import { fileURLToPath } from "node:url";

const plainSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function parsePlainSemver(label, version) {
  if (!plainSemverPattern.test(version)) {
    throw new Error(`${label} version must be plain SemVer, got ${version}.`);
  }
  return version.split(".").map((part) => BigInt(part));
}

export function assertReleasePromotionOrder(candidateVersion, stableVersion) {
  const candidate = parsePlainSemver("Candidate", candidateVersion);
  const stable = parsePlainSemver("Current stable", stableVersion);
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] > stable[index]) return;
    if (candidate[index] < stable[index]) {
      throw new Error(
        `Refusing to move stable backward from ${stableVersion} to ${candidateVersion}.`,
      );
    }
  }
}

async function main() {
  const [candidateVersion, stableVersion] = process.argv.slice(2);
  if (candidateVersion === undefined || stableVersion === undefined) {
    throw new Error(
      "Usage: assert-release-promotion.mjs <candidate-version> <current-stable-version>",
    );
  }
  assertReleasePromotionOrder(candidateVersion, stableVersion);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
