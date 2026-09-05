#!/bin/bash

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077

readonly DEPLOY_USER="pierback-updates"
readonly INSTALL_DIRECTORY="/usr/local/libexec/bb-mesh"
readonly ACTIVATION_CORE="$INSTALL_DIRECTORY/activate-gateway-config.sh"
readonly CANDIDATE_READER="$INSTALL_DIRECTORY/read-gateway-candidate.py"
readonly PRIVILEGED_HELPER="/usr/local/sbin/bb-mesh-activate-gateway"
readonly SUDOERS_FILE="/etc/sudoers.d/bb-mesh-gateway-deployer"
readonly SUDOERS_RULE="pierback-updates ALL=(root) NOPASSWD: /usr/local/sbin/bb-mesh-activate-gateway"

if [[ "$#" -ne 0 ]]; then
  echo "Usage: install-gateway-deployer.sh" >&2
  exit 64
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "install-gateway-deployer.sh must run as root." >&2
  exit 77
fi

source_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly source_directory
readonly source_installer="$source_directory/install-gateway-deployer.sh"
readonly source_core="$source_directory/activate-gateway-config.sh"
readonly source_reader="$source_directory/read-gateway-candidate.py"
readonly source_helper="$source_directory/activate-gateway-config-privileged.sh"

require_root_owned_source() {
  local source_path="$1"
  local mode
  if [[ ! -f "$source_path" || -L "$source_path" ]]; then
    echo "Installer source must be a regular file: $source_path" >&2
    exit 66
  fi
  if [[ "$(/usr/bin/stat -c '%U:%G' -- "$source_path")" != "root:root" ]]; then
    echo "Installer source must be owned by root:root: $source_path" >&2
    exit 77
  fi
  mode="$(/usr/bin/stat -c '%a' -- "$source_path")"
  if (( (8#$mode & 0022) != 0 )); then
    echo "Installer source must not be group- or world-writable: $source_path" >&2
    exit 77
  fi
}

for source_path in "$source_installer" "$source_core" "$source_reader" "$source_helper"; do
  require_root_owned_source "$source_path"
done
if ! /usr/bin/id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Missing deployment account: $DEPLOY_USER" >&2
  exit 67
fi
if ! /usr/bin/id -u caddy >/dev/null 2>&1; then
  echo "Missing Caddy service account: caddy" >&2
  exit 67
fi

require_trusted_dependency() {
  local trusted_path="$1"
  local mode
  if [[ ! -f "$trusted_path" || -L "$trusted_path" ]]; then
    echo "Missing trusted gateway dependency: $trusted_path" >&2
    exit 66
  fi
  if [[ "$(/usr/bin/stat -c '%U:%G' -- "$trusted_path")" != "root:root" ]]; then
    echo "Gateway dependency must be owned by root:root: $trusted_path" >&2
    exit 77
  fi
  mode="$(/usr/bin/stat -c '%a' -- "$trusted_path")"
  if (( (8#$mode & 0022) != 0 )); then
    echo "Gateway dependency must not be group- or world-writable: $trusted_path" >&2
    exit 77
  fi
}

require_trusted_python() {
  local logical_path="/usr/bin/python3"
  local resolved_path
  if [[ ! -f "$logical_path" || ! -x "$logical_path" ]]; then
    echo "Missing trusted gateway dependency: $logical_path" >&2
    exit 66
  fi
  if [[ -L "$logical_path" && "$(/usr/bin/stat -c '%U:%G' -- "$logical_path")" != "root:root" ]]; then
    echo "Python interpreter link must be owned by root:root." >&2
    exit 77
  fi
  resolved_path="$(/usr/bin/realpath -e -- "$logical_path")"
  if [[ ! "$resolved_path" =~ ^/usr/bin/python3([.][0-9]+)*$ ]]; then
    echo "Python interpreter resolves outside the trusted system path." >&2
    exit 77
  fi
  require_trusted_dependency "$resolved_path"
}

require_trusted_directory() {
  local directory_path="$1"
  local mode
  if [[ ! -d "$directory_path" || -L "$directory_path" ]]; then
    echo "Missing trusted installation directory: $directory_path" >&2
    exit 66
  fi
  if [[ "$(/usr/bin/stat -c '%U:%G' -- "$directory_path")" != "root:root" ]]; then
    echo "Installation directory must be owned by root:root: $directory_path" >&2
    exit 77
  fi
  mode="$(/usr/bin/stat -c '%a' -- "$directory_path")"
  if (( (8#$mode & 0022) != 0 )); then
    echo "Installation directory must not be group- or world-writable: $directory_path" >&2
    exit 77
  fi
}

for trusted_path in \
  /etc/caddy/Caddyfile \
  /usr/local/bin/caddy \
  /usr/bin/env \
  /usr/bin/systemctl \
  /usr/sbin/runuser \
  /usr/sbin/visudo; do
  require_trusted_dependency "$trusted_path"
done
require_trusted_python
for directory_path in /usr/local /usr/local/sbin /etc/sudoers.d; do
  require_trusted_directory "$directory_path"
done
if [[ -e /usr/local/libexec || -L /usr/local/libexec ]]; then
  require_trusted_directory /usr/local/libexec
else
  /usr/bin/install -d -o root -g root -m 0755 -- /usr/local/libexec
fi

temporary_directory="$(/usr/bin/mktemp -d /tmp/bb-mesh-gateway-installer.XXXXXX)"
if [[ ! "$temporary_directory" =~ ^/tmp/bb-mesh-gateway-installer\.[A-Za-z0-9]+$ ]]; then
  echo "Could not create a trusted installer directory." >&2
  exit 70
fi
readonly temporary_directory
readonly staged_sudoers="$temporary_directory/sudoers"
readonly core_next="$ACTIVATION_CORE.next.$$"
readonly reader_next="$CANDIDATE_READER.next.$$"
readonly helper_next="$PRIVILEGED_HELPER.next.$$"
readonly sudoers_next="$SUDOERS_FILE.next.$$"

printf '%s\n' "$SUDOERS_RULE" > "$staged_sudoers"
/usr/bin/chown root:root "$staged_sudoers"
/usr/bin/chmod 0440 "$staged_sudoers"
/usr/sbin/visudo -cf "$staged_sudoers"

declare -A existed=()
mutated="false"
installation_complete="false"

backup_target() {
  local target_path="$1"
  local backup_name="$2"
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    if [[ ! -f "$target_path" || -L "$target_path" ]]; then
      echo "Refusing to replace a linked or non-regular file: $target_path" >&2
      exit 66
    fi
    /usr/bin/cp -a -- "$target_path" "$temporary_directory/$backup_name"
    existed["$target_path"]="true"
  else
    existed["$target_path"]="false"
  fi
}

restore_target() {
  local target_path="$1"
  local backup_name="$2"
  local next_path="$target_path.rollback.$$"
  if [[ "${existed[$target_path]}" == "true" ]]; then
    /usr/bin/cp -a -- "$temporary_directory/$backup_name" "$next_path"
    /usr/bin/mv -f -- "$next_path" "$target_path"
  else
    /usr/bin/rm -f -- "$target_path"
  fi
}

cleanup() {
  local exit_code="$?"
  if [[ "$mutated" == "true" && "$installation_complete" != "true" ]]; then
    restore_target "$SUDOERS_FILE" sudoers.previous || true
    restore_target "$PRIVILEGED_HELPER" helper.previous || true
    restore_target "$CANDIDATE_READER" reader.previous || true
    restore_target "$ACTIVATION_CORE" core.previous || true
    /usr/sbin/visudo -cf /etc/sudoers >/dev/null 2>&1 || \
      echo "WARNING: sudoers validation still fails after installer rollback." >&2
  fi
  /usr/bin/rm -f -- "$core_next" "$reader_next" "$helper_next" "$sudoers_next"
  /usr/bin/rm -rf -- "$temporary_directory"
  return "$exit_code"
}
trap cleanup EXIT

/usr/bin/install -d -o root -g root -m 0755 -- "$INSTALL_DIRECTORY"
require_trusted_directory "$INSTALL_DIRECTORY"
backup_target "$ACTIVATION_CORE" core.previous
backup_target "$CANDIDATE_READER" reader.previous
backup_target "$PRIVILEGED_HELPER" helper.previous
backup_target "$SUDOERS_FILE" sudoers.previous
mutated="true"

/usr/bin/install -o root -g root -m 0755 -- "$source_core" "$core_next"
/usr/bin/mv -f -- "$core_next" "$ACTIVATION_CORE"
/usr/bin/install -o root -g root -m 0644 -- "$source_reader" "$reader_next"
/usr/bin/mv -f -- "$reader_next" "$CANDIDATE_READER"
/usr/bin/install -o root -g root -m 0755 -- "$source_helper" "$helper_next"
/usr/bin/mv -f -- "$helper_next" "$PRIVILEGED_HELPER"
/usr/bin/install -o root -g root -m 0440 -- "$staged_sudoers" "$sudoers_next"
/usr/sbin/visudo -cf "$sudoers_next"
/usr/bin/mv -f -- "$sudoers_next" "$SUDOERS_FILE"
/usr/sbin/visudo -cf /etc/sudoers

installation_complete="true"
echo "Installed the BB Mesh gateway deployer with one restricted sudo command."
