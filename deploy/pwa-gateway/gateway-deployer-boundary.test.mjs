import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const privilegedHelper = fileURLToPath(
  new URL("./activate-gateway-config-privileged.sh", import.meta.url),
);
const activationCore = fileURLToPath(
  new URL("./activate-gateway-config.sh", import.meta.url),
);
const candidateReader = fileURLToPath(
  new URL("./read-gateway-candidate.py", import.meta.url),
);
const installer = fileURLToPath(
  new URL("./install-gateway-deployer.sh", import.meta.url),
);
const uploader = fileURLToPath(
  new URL("./upload-gateway-config.sh", import.meta.url),
);

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test("the installed root helper fixes every privileged gateway target", async () => {
  const source = await readFile(privilegedHelper, "utf8");
  const coreSource = await readFile(activationCore, "utf8");

  assert.match(source, /if \[\[ "\$EUID" -ne 0 \]\]/u);
  assert.match(
    source,
    /\^\/srv\/bb-pwa\/\\\.incoming\/gateway-config-\[0-9\]\+-\[0-9\]\+\/Caddyfile\$/u,
  );
  assert.match(
    source,
    /ACTIVATION_CORE="\/usr\/local\/libexec\/bb-mesh\/activate-gateway-config\.sh"/u,
  );
  assert.match(source, /TARGET_CONFIG="\/etc\/caddy\/Caddyfile"/u);
  assert.match(source, /CADDY_BIN="\/usr\/local\/bin\/caddy"/u);
  assert.match(source, /SYSTEMCTL_BIN="\/usr\/bin\/systemctl"/u);
  assert.match(source, /SERVICE_NAME="caddy\.service"/u);
  assert.match(source, /root:root:755/u);
  assert.match(source, /root:root:644/u);
  assert.match(source, /\/usr\/bin\/realpath -e/u);
  assert.match(source, /\^\/usr\/bin\/python3\(\[\.\]\[0-9\]\+\)\*\$/u);
  assert.match(
    source,
    /\/usr\/sbin\/runuser -u "\$DEPLOY_USER" -- \/usr\/bin\/env -i/u,
  );
  assert.match(source, /"\$python3_resolved" -I -S "\$CANDIDATE_READER"/u);
  assert.doesNotMatch(source, /install .*"\$staged_config"/u);
  assert.match(
    coreSource,
    /"\$runuser_bin" -u "\$caddy_service_user" -- \/usr\/bin\/env -i/u,
  );
  assert.match(coreSource, /XDG_CONFIG_HOME=\/var\/lib\/caddy\/config/u);
  assert.match(coreSource, /XDG_DATA_HOME=\/var\/lib\/caddy/u);
  assert.match(coreSource, /show --property=User --value "\$service_name"/u);
  assert.match(coreSource, /show --property=Group --value "\$service_name"/u);
  assert.match(
    coreSource,
    /Refusing to load deploy-controlled configuration into a privileged Caddy service/u,
  );
  assert.doesNotMatch(coreSource, /run_privileged "\$caddy_bin" validate/u);
});

test("the candidate reader opens one bounded regular file without following links", async () => {
  const source = await readFile(candidateReader, "utf8");

  assert.match(source, /MAX_CANDIDATE_BYTES = 1024 \* 1024/u);
  assert.match(source, /os\.O_NOFOLLOW/u);
  assert.match(source, /os\.O_NONBLOCK/u);
  assert.match(source, /before = os\.fstat\(candidate_fd\)/u);
  assert.match(source, /stat\.S_ISREG\(before\.st_mode\)/u);
  assert.match(source, /before\.st_uid != os\.geteuid\(\)/u);
  assert.match(source, /before\.st_nlink != 1/u);
  assert.match(
    source,
    /hashlib\.sha256\(candidate\)\.hexdigest\(\) != expected_sha256/u,
  );

  const root = await mkdtemp(join(tmpdir(), "bb-mesh-gateway-reader-"));
  const candidate = join(root, "Caddyfile");
  const linkedCandidate = join(root, "LinkedCaddyfile");
  const oversizedCandidate = join(root, "OversizedCaddyfile");
  const contents = "example.test { respond 200 }\n";
  const checksum = createHash("sha256").update(contents).digest("hex");
  await writeFile(candidate, contents, { mode: 0o600 });

  const accepted = spawnSync(
    "/usr/bin/python3",
    ["-I", "-S", candidateReader, candidate, checksum],
    { encoding: "utf8" },
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, contents);

  const mismatched = spawnSync(
    "/usr/bin/python3",
    ["-I", "-S", candidateReader, candidate, "0".repeat(64)],
    { encoding: "utf8" },
  );
  assert.notEqual(mismatched.status, 0);
  assert.equal(mismatched.stdout, "");

  await symlink(candidate, linkedCandidate);
  const linked = spawnSync(
    "/usr/bin/python3",
    ["-I", "-S", candidateReader, linkedCandidate, checksum],
    { encoding: "utf8" },
  );
  assert.notEqual(linked.status, 0);
  assert.equal(linked.stdout, "");

  await writeFile(oversizedCandidate, Buffer.alloc(1024 * 1024 + 1), {
    mode: 0o600,
  });
  const oversized = spawnSync(
    "/usr/bin/python3",
    ["-I", "-S", candidateReader, oversizedCandidate, checksum],
    { encoding: "utf8" },
  );
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.stdout, "");
});

test("the installer grants exactly one passwordless command", async () => {
  const source = await readFile(installer, "utf8");
  const grants = source.match(/NOPASSWD:/gu) ?? [];

  assert.equal(grants.length, 1);
  assert.match(
    source,
    /SUDOERS_RULE="pierback-updates ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/bb-mesh-activate-gateway"/u,
  );
  assert.match(source, /\/usr\/sbin\/visudo -cf "\$staged_sudoers"/u);
  assert.match(source, /\/usr\/sbin\/visudo -cf \/etc\/sudoers/u);
  assert.match(source, /require_trusted_python/u);
  assert.match(
    source,
    /resolved_path="\$\(\/usr\/bin\/realpath -e -- "\$logical_path"\)"/u,
  );
  assert.match(source, /require_trusted_dependency "\$resolved_path"/u);
  assert.match(source, /\/usr\/bin\/install -o root -g root -m 0755/u);
  assert.match(
    source,
    /\/usr\/bin\/install -o root -g root -m 0644 -- "\$source_reader"/u,
  );
  assert.match(source, /\/usr\/bin\/install -o root -g root -m 0440/u);
  assert.doesNotMatch(source, /NOPASSWD:\s+ALL/u);
});

test("the CI transport uploads only the candidate and calls the installed helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-mesh-gateway-uploader-"));
  const bin = join(root, "bin");
  const log = join(root, "transport.log");
  const config = join(root, "Caddyfile");
  const key = join(root, "id");
  const knownHosts = join(root, "known_hosts");
  await mkdir(bin);
  await writeFile(config, "example.test { respond 200 }\n");
  await writeFile(key, "test key\n");
  await writeFile(knownHosts, "test host\n");
  const transport =
    '#!/bin/bash\nset -euo pipefail\nprintf "%s" "${0##*/}" >> "$BB_MESH_TEST_TRANSPORT_LOG"\nprintf "\\t%q" "$@" >> "$BB_MESH_TEST_TRANSPORT_LOG"\nprintf "\\n" >> "$BB_MESH_TEST_TRANSPORT_LOG"\n';
  await executable(join(bin, "ssh"), transport);
  await executable(join(bin, "scp"), transport);

  const result = spawnSync(
    "/bin/bash",
    [uploader, config, "pierback-updates@example.test", key, knownHosts],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BB_MESH_TEST_TRANSPORT_LOG: log,
        GITHUB_RUN_ATTEMPT: "4",
        GITHUB_RUN_ID: "123",
        PATH: `${bin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const calls = await readFile(log, "utf8");
  const scpCalls = calls.split("\n").filter((line) => line.startsWith("scp\t"));
  assert.equal(scpCalls.length, 1, calls);
  assert.match(
    scpCalls[0],
    /Caddyfile.*pierback-updates@example\.test:\/srv\/bb-pwa\/\.incoming\/gateway-config-123-4\/Caddyfile/u,
  );
  assert.match(
    calls,
    /sudo\\ -n\\ \/usr\/local\/sbin\/bb-mesh-activate-gateway/u,
  );
  assert.doesNotMatch(calls, /activate-gateway-config\.sh/u);
  assert.doesNotMatch(calls, /\/etc\/caddy\/Caddyfile/u);
});
