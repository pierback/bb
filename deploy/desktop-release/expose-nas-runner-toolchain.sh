#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${GITHUB_PATH:-}" ]]; then
  echo "::error::GITHUB_PATH is required to configure the NAS signing job."
  exit 1
fi

tool_directory=""
for candidate in /opt/homebrew/bin /usr/local/bin; do
  if [[ -x "$candidate/gh" ]]; then
    tool_directory="$candidate"
    break
  fi
done

if [[ -z "$tool_directory" ]]; then
  echo "::error::The NAS signing runner requires the GitHub CLI in a managed Homebrew bin directory."
  exit 1
fi

printf '%s\n' "$tool_directory" >> "$GITHUB_PATH"
