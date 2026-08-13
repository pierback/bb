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
  const nasDatabaseRollback = await read(
    "deploy/desktop-release/nas-database-rollback.sh",
  );
  const nasDesktopProcesses = await read(
    "deploy/desktop-release/nas-desktop-processes.sh",
  );
  const nasDesktopLaunch = await read(
    "deploy/desktop-release/nas-desktop-launch.sh",
  );
  const nasRuntimeDataVerifier = await read(
    "deploy/desktop-release/verify-nas-runtime-data-directory.mjs",
  );
  const nasDesktopRuntime = await read(
    "deploy/desktop-release/nas-desktop-runtime.sh",
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
  assert.match(
    nasInstaller,
    /pierback_stop_desktop_runtimes\(\)[\s\S]*pierback_stop_desktop_runtime "\$destination" "\$runtime_data_directory"[\s\S]*pierback_stop_desktop_runtime "\$legacy_destination" "\$runtime_data_directory"[\s\S]*pierback_desktop_runtime_is_recorded\(\)[\s\S]*pierback_fence_desktop_cutover/u,
    "NAS cutover must supply both installed runtimes to the ordered lifecycle fence",
  );
  assert.match(nasDesktopRuntime, /bb-app-bridge\.mjs/u);
  assert.match(nasDesktopRuntime, /ELECTRON_RUN_AS_NODE=1/u);
  assert.match(nasDesktopRuntime, /--data-dir "\$data_directory"[\s\S]*stop/u);
  assert.match(build, /turbo run typecheck.*--filter=@bb\/app/u);
  assert.match(build, /turbo run test.*--filter=@bb\/app/u);
  assert.doesNotMatch(
    build,
    /turbo run test[^\n]*--filter=@bb\/app[^\n]*--filter=@bb\/desktop(?:\s|$)/u,
    "the real-window desktop smoke must not compete with the app test suite on the signing Mac",
  );
  assert.match(
    build,
    /Test desktop release surface without competing package tests[\s\S]*turbo run test --filter=@bb\/desktop --force --concurrency=1/u,
    "the signing workflow must give GUI-backed desktop tests an isolated serialized phase",
  );
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
  const databaseSnapshot = nasInstaller.indexOf(
    'pierback_snapshot_database "$database_path" "$database_snapshot_path"',
  );
  assert.ok(
    rollbackArmed >= 0 && rollbackArmed < firstAppMove,
    "automatic rollback must be armed before the first destructive app move",
  );
  assert.ok(
    databaseSnapshot > rollbackArmed && databaseSnapshot < firstAppMove,
    "the stopped coordinator database must be snapshotted before the first app move",
  );
  const rollbackStart = nasInstaller.indexOf("rollback() {");
  const rollbackStop = nasInstaller.indexOf(
    "if ! stop_desktop_apps; then",
    rollbackStart,
  );
  const databaseRestore = nasInstaller.indexOf(
    'pierback_restore_database "$database_path" "$database_snapshot_path"',
    rollbackStart,
  );
  const rollbackOpen = nasInstaller.indexOf(
    'pierback_open_desktop_app "$destination"',
    rollbackStart,
  );
  assert.ok(
    rollbackStop >= 0 &&
      databaseRestore > rollbackStop &&
      rollbackOpen > databaseRestore,
    "rollback must restore the database after stopping the candidate and before reopening the old app",
  );
  assert.doesNotMatch(
    nasInstaller.slice(rollbackStart, databaseRestore),
    /stop_desktop_apps \|\| true/u,
    "rollback must fail closed rather than mutate a database whose candidate could still be running",
  );
  assert.match(
    nasInstaller.slice(rollbackStop, databaseRestore),
    /if ! stop_desktop_apps; then[\s\S]*return 1/u,
    "database recovery must be unreachable when the candidate cannot be fenced",
  );
  assert.match(
    nasInstaller,
    /if \[\[ "\$rollback_exit_code" -eq 0 && -d "\$destination" \]\]/u,
    "an incomplete database or app recovery must keep the previous coordinator closed",
  );
  assert.match(
    nasDatabaseRollback,
    /rm -f -- "\$database_path-wal" "\$database_path-shm"/u,
    "database recovery may remove only the exact SQLite sidecars before atomic replacement",
  );
  assert.match(
    nasDatabaseRollback,
    /mv -f -- "\$backup_path" "\$database_path"/u,
    "database recovery must consume its adjacent snapshot atomically without a second DB-sized allocation",
  );
  assert.doesNotMatch(
    nasDatabaseRollback,
    /pierback-restore|\/bin\/cp/u,
    "database recovery must not allocate a second DB-sized staging copy",
  );
  assert.match(
    nasInstaller,
    /if \[\[ "\$exit_code" -ne 0[\s\S]*rollback/u,
    "the exit trap must compensate every incomplete app swap",
  );
  assert.match(
    nasDesktopProcesses,
    /pierback_wait_for_desktop_process_quiescence 30 TERM 5[\s\S]*pierback_wait_for_desktop_process_quiescence 15 KILL 5[\s\S]*pierback_wait_for_desktop_cutover_quiescence 30 5/u,
    "NAS cutover must stop GUI generations before the runtime and final quiet window",
  );
  assert.doesNotMatch(
    nasInstaller,
    /osascript/u,
    "NAS cutover must not launch a stopped GUI app merely to deliver a quit event",
  );
  assert.match(
    nasInstaller,
    /pierback_open_desktop_app "\$destination" "\$runtime_data_directory"/u,
  );
  for (const variableName of [
    "BB_CLI",
    "BB_DATA_DIR",
    "BB_DESKTOP_APP_URL",
    "BB_DESKTOP_NODE_EXEC_PATH",
    "ELECTRON_RUN_AS_NODE",
    "RUNNER_TRACKING_ID",
  ]) {
    assert.match(
      nasDesktopLaunch,
      new RegExp(`-u ${variableName}`, "u"),
      `${variableName} must not leak from the signing runner into Pierback`,
    );
  }
  assert.match(
    nasDesktopLaunch,
    /BB_DATA_DIR="\$data_directory"[\s\S]*"\$executable"/u,
    "the launch adapter must execute the exact installed binary with the protected data directory",
  );
  assert.doesNotMatch(
    nasDesktopLaunch,
    /(?:^|\s)open(?:\s|$)/u,
    "LaunchServices must not be able to reapply a conflicting launchctl environment",
  );
  assert.match(
    nasRuntimeDataVerifier,
    /metadata\.isSymbolicLink\(\)/u,
    "the protected NAS data root must reject symbolic links",
  );
  assert.match(
    nasRuntimeDataVerifier,
    /Object\.hasOwn\(parsed\.env, "BB_DATA_DIR"\)/u,
    "persisted environment must not redirect the protected NAS data root",
  );
  assert.match(
    nasDesktopProcesses,
    /for \(\(attempt = 1; attempt <= maximum_attempts; attempt \+= 1\)\)[\s\S]*pierback_signal_desktop_processes "\$signal_name"/u,
    "NAS cutover must signal every observed detached-process generation",
  );
  assert.match(
    nasDesktopProcesses,
    /quiet_polls=0[\s\S]*quiet_polls=\$\(\(quiet_polls \+ 1\)\)[\s\S]*quiet_polls >= required_quiet_polls/u,
    "NAS cutover must observe a consecutive quiet window before moving applications",
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
    /prepared[\s\S]*nas-installing[\s\S]*recovery-required[\s\S]*nas-installed[\s\S]*stable-verified[\s\S]*complete/u,
  );
  assert.match(
    promote,
    /Block unsafe promotion retry until recovery is acknowledged/u,
  );
  assert.match(promote, /do not rerun this promotion/u);
  assert.match(promote, /acknowledge-recovery/u);
  assert.match(nasInstaller, /recovery-required/u);
  assert.match(nasInstaller, /rollback-complete/u);
  assert.match(
    promote,
    /nas-installed\)\s+needs_nas=false/u,
    "a retry after verified NAS installation must not reinstall or resnapshot the NAS database",
  );
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
