import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { test } from "node:test";
import { assertReleasePromotionOrder } from "./assert-release-promotion.mjs";

const repoRoot = new URL("../../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repoRoot), "utf8");
}

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, repoRoot), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("the fork has no inherited publisher or getbb.app deployment workflow", async () => {
  for (const path of [
    ".github/workflows/deploy-connect.yml",
    ".github/workflows/deploy-web.yml",
    ".github/workflows/publish-bb-app.yml",
  ]) {
    assert.equal(await exists(path), false, `${path} must stay removed`);
  }
});

test("desktop update targets are Pierback-only", async () => {
  const provider = await read("apps/desktop/src/desktop-update-provider.ts");
  const builderConfig = await read("apps/desktop/electron-builder.config.json");
  const turboConfig = await read("turbo.json");
  const combined = `${provider}\n${builderConfig}\n${turboConfig}`;

  assert.match(combined, /https:\/\/updates\.bb\.staufingers\.de/u);
  assert.doesNotMatch(combined, /get-bb\/bb|desktop-latest|desktop-nightly/u);
  assert.doesNotMatch(combined, /BB_DESKTOP_RELEASE_CHANNEL/u);
  assert.match(turboConfig, /BB_DESKTOP_BUILD_FLAVOR/u);
  assert.match(
    turboConfig,
    /"@bb\/desktop#test":\s*\{\s*(?:\/\/[^\n]*\n\s*)*"dependsOn":\s*\["\/\/#ensure-native-modules",\s*"bb-app#build",\s*"topo"\]/u,
    "desktop tests must provide packaged renderer assets before Electron startup coverage",
  );
});

test("PWA release builds validate generated icons without rewriting source", async () => {
  const appPackage = JSON.parse(await read("apps/app/package.json"));

  assert.match(
    appPackage.scripts.build,
    /generate-pwa-icons\.mjs --check/u,
    "the app build must fail on stale committed icons instead of racing tests by rewriting them",
  );
});

test("runtime install and coordinator status cannot escape to official bb-app", async () => {
  const appVersionService = await read(
    "apps/server/src/services/system/app-version.ts",
  );
  const machineInstaller = await read(
    "apps/server/src/assets/install-machine.sh",
  );
  const dashboard = await read("apps/web/src/routes/dashboard.tsx");
  const landing = await read("apps/web/src/routes/index.tsx");
  const launcher = await read("packages/bb-app/src/launcher.ts");
  const packageManifest = JSON.parse(
    await read("packages/bb-app/package.json"),
  );
  const executableSurfaces = [
    appVersionService,
    machineInstaller,
    dashboard,
    landing,
    launcher,
  ].join("\n");

  assert.equal(packageManifest.private, true);
  assert.match(appVersionService, /updatePolicy: "deployment-managed"/u);
  assert.match(machineInstaller, /coordinator-matched bb-app/u);
  assert.doesNotMatch(
    executableSurfaces,
    /registry\.npmjs\.org\/bb-app|npx(?:\s+--package|\s+-p)?\s+bb-app|npm install -g bb-app(?:\s|$)/u,
  );
});

test("candidate and promotion workflows preserve the NAS-first release gate", async () => {
  const build = await read(".github/workflows/build-desktop.yml");
  const promote = await read(".github/workflows/promote-desktop.yml");
  const desktopPackage = await read("apps/desktop/package.json");
  const nasInstaller = await read(
    "deploy/desktop-release/install-nas-candidate.sh",
  );

  assert.match(build, /workflow_dispatch:/u);
  assert.match(build, /self-hosted, macOS, ARM64, pierback-signing/u);
  for (const [name, workflow] of [
    ["candidate", build],
    ["promotion", promote],
  ]) {
    const toolchainSetup = workflow.indexOf(
      "deploy/desktop-release/expose-nas-runner-toolchain.sh",
    );
    const firstGitHubCliCall = workflow.indexOf("gh ");
    assert.ok(
      toolchainSetup >= 0 &&
        firstGitHubCliCall >= 0 &&
        toolchainSetup < firstGitHubCliCall,
      `${name} workflow must expose the GUI runner toolchain before using gh`,
    );
  }
  assert.match(build, /Require the fork default branch/u);
  assert.match(
    build,
    /pnpm install --frozen-lockfile --store-dir "\$RUNNER_TEMP\/pierback-pnpm-store"/u,
    "release installs must not reuse a mutable shared pnpm store",
  );
  assert.doesNotMatch(
    build,
    /cache:\s*pnpm/u,
    "the signing job must not restore an immutable cache containing a corrupted pnpm store",
  );
  assert.match(build, /turbo run typecheck.*--filter=@bb\/app/u);
  assert.match(build, /turbo run test.*--filter=@bb\/app/u);
  assert.match(build, /pnpm --filter @bb\/desktop run desktop:build/u);
  assert.match(desktopPackage, /--publish never/u);
  assert.match(build, /Publish exact candidate artifacts to canary/u);
  assert.match(
    build,
    /CSC_NAME.*Developer ID Application:/su,
    "candidate preflight must reject electron-builder's invalid certificate-kind prefix",
  );
  assert.match(
    build,
    /ACTIONS_RUNNER_SVC/u,
    "the macOS signer must reject GitHub runner service mode",
  );
  assert.match(
    build,
    /xcrun notarytool history[\s\S]*--apple-id "\$APPLE_ID"[\s\S]*--password "\$APPLE_APP_SPECIFIC_PASSWORD"[\s\S]*--team-id "\$APPLE_TEAM_ID"/u,
    "candidate preflight must validate Apple notarization credentials before signing",
  );
  assert.match(
    build,
    /codesign --force --timestamp --options runtime/u,
    "candidate preflight must prove non-interactive access to the signing key",
  );
  assert.doesNotMatch(build, /schedule:|get-bb\/bb/u);
  const candidateResolution = build.indexOf(
    "Resolve immutable candidate identity",
  );
  const desktopBuild = build.indexOf("Build desktop and PWA runtime");
  assert.ok(
    candidateResolution >= 0 && candidateResolution < desktopBuild,
    "candidate reuse must be resolved before a signed bundle can be rebuilt",
  );
  assert.match(
    build,
    /Build desktop and PWA runtime\n\s+if: steps\.candidate\.outputs\.reuse != 'true'/u,
  );
  assert.match(
    build,
    /gh release download "\$RELEASE_TAG" --dir "\$release_directory"/u,
    "a deployment retry must reuse the existing immutable release bytes",
  );
  assert.match(
    build,
    /release_directory="apps\/desktop\/release\/bundle"/u,
    "a new candidate must publish only the clean immutable bundle, not Electron Builder diagnostics",
  );
  assert.match(
    build,
    /release-manifest\.mjs "\$release_directory\/release-manifest\.json" desktopVersion/u,
    "candidate reuse must compare the manifest's canonical desktop version",
  );
  assert.match(
    build,
    /for script in[\s\S]*bash -n "\$script"/u,
    "every release shell script must receive its own syntax check",
  );
  const canaryPublication = build.indexOf(
    "Publish exact candidate artifacts to canary",
  );
  assert.ok(
    canaryPublication >= 0 &&
      build.indexOf(
        '"${{ steps.bundle.outputs.directory }}"',
        canaryPublication,
      ) > canaryPublication,
    "canary publication must use the resolved new-or-existing bundle",
  );

  assert.doesNotMatch(
    promote,
    /git checkout --detach/u,
    "promotion must execute approved release automation from main, not deployment code embedded in an older candidate",
  );
  assert.match(
    promote,
    /git merge-base --is-ancestor "\$source_commit" "\$automation_commit"/u,
    "promotion must prove that the immutable candidate belongs to the approved fork history",
  );
  const canaryRestage = promote.indexOf(
    "Restage and verify the exact candidate on canary",
  );

  const nasInstallAndBootstrap = promote.indexOf(
    "Install or verify NAS coordinator and machine bootstrap",
  );
  const stablePromotion = promote.indexOf("Promote the same bytes to stable");
  assert.ok(
    nasInstallAndBootstrap >= 0 && stablePromotion > nasInstallAndBootstrap,
    "stable publication must happen after NAS runtime and bootstrap verification",
  );
  assert.match(promote, /\/install\/bb-app\.tgz/u);
  assert.match(promote, /verify-bb-app-tarball\.mjs/u);
  assert.match(nasInstaller, /verify_candidate_bootstrap/u);
  const rollbackArmed = nasInstaller.indexOf('cutover_started="true"');
  const firstAppMove = nasInstaller.indexOf(
    'mv -- "$destination" "$previous_destination"',
  );
  assert.ok(
    rollbackArmed >= 0 && rollbackArmed < firstAppMove,
    "automatic rollback must be armed before the first destructive app move",
  );
  assert.match(
    nasInstaller,
    /if \[\[ "\$exit_code" -ne 0[\s\S]*rollback/u,
    "the exit trap must compensate every incomplete app swap",
  );
  assert.match(
    nasInstaller,
    /osascript[\s\S]*wait_for_coordinator_to_stop 30[\s\S]*signal_desktop_processes TERM[\s\S]*wait_for_coordinator_to_stop 15[\s\S]*signal_desktop_processes KILL[\s\S]*wait_for_coordinator_to_stop 10/u,
    "NAS cutover must escalate only after graceful shutdown and remain bounded",
  );
  assert.match(
    nasInstaller,
    /coordinator port is still healthy but is not owned by an installed Pierback\/bb process; refusing the cutover/u,
    "NAS cutover must fail closed when another process owns the coordinator port",
  );
  assert.match(
    promote,
    /RELEASE_TAG.*pierback-desktop-v\$version/su,
    "promotion must bind the immutable tag to the manifest version",
  );
  const downgradeRejection = promote.indexOf("Reject a production downgrade");
  assert.ok(
    downgradeRejection >= 0 && downgradeRejection < nasInstallAndBootstrap,
    "promotion must reject older candidates before changing the NAS",
  );
  assert.match(promote, /promotion-state\.mjs initialize/u);
  assert.match(
    promote,
    /prepared[\s\S]*nas-installed[\s\S]*stable-verified[\s\S]*complete/u,
  );
  assert.match(promote, /Report resumable promotion phase after failure/u);
  const publicationPreflight = promote.indexOf(
    "Preflight the stable publication boundary",
  );
  assert.ok(
    canaryRestage >= 0 &&
      publicationPreflight > canaryRestage &&
      publicationPreflight < nasInstallAndBootstrap,
    "the exact candidate must be publicly readable on canary and preflighted before NAS cutover",
  );
});

test("the NAS runner exposes gh without relying on interactive shell startup", async () => {
  const toolchain = await read(
    "deploy/desktop-release/expose-nas-runner-toolchain.sh",
  );

  assert.match(toolchain, /\.local\/share\/mise\/shims/u);
  assert.match(toolchain, /\/opt\/homebrew\/bin/u);
  assert.match(toolchain, /\/usr\/local\/bin/u);
  assert.match(toolchain, /-x "\$candidate\/gh"/u);
  assert.match(toolchain, /GITHUB_PATH/u);
  assert.doesNotMatch(toolchain, /source|\.zprofile|\.zshrc/u);
});

test("discoverable channel documentation names the real CLI, SDK, and file", async () => {
  for (const path of [
    "docs/configuration.md",
    "apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md",
    "packages/templates/src/templates/bb-guide-customization.md",
  ]) {
    const contents = await read(path);
    assert.match(contents, /bb updates channel/u, path);
    assert.match(contents, /createNodeBbSdk\(\)\.desktopUpdates/u, path);
  }
  assert.match(
    await read("docs/configuration.md"),
    /desktop-update-channel\.json/u,
  );
});

test("production promotion accepts upgrades and retries but rejects downgrades", () => {
  assert.doesNotThrow(() => assertReleasePromotionOrder("1.2.4", "1.2.3"));
  assert.doesNotThrow(() => assertReleasePromotionOrder("1.2.3", "1.2.3"));
  assert.throws(
    () => assertReleasePromotionOrder("1.2.2", "1.2.3"),
    /Refusing to move stable backward/u,
  );
  assert.throws(
    () => assertReleasePromotionOrder("1.2.3-beta.1", "1.2.2"),
    /plain SemVer/u,
  );
});

test("the daily upstream watcher can only open a manual review PR", async () => {
  const workflow = await read(".github/workflows/sync-upstream-release.yml");

  assert.match(workflow, /schedule:/u);
  assert.match(
    workflow,
    /git push origin "\$UPSTREAM_COMMIT:refs\/heads\/\$REVIEW_BRANCH"/u,
  );
  assert.match(workflow, /gh pr create/u);
  assert.doesNotMatch(
    workflow,
    /(?:^|\n)\s*(?:git merge|gh pr merge)(?:\s|$)|(?:^|\s)-[Xx]\s+ours(?:\s|$)/u,
    "automation must neither resolve conflicts nor merge the review PR",
  );
});
