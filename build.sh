#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_root"

npm run tauri -- build --no-bundle
src-tauri/target/release/inpaint-desktop --check-assets

# Replace atomically so a running app can keep using the previous executable.
staged_binary="$(mktemp "$project_root/.inpaint-desktop.XXXXXX")"
trap 'rm -f -- "$staged_binary"' EXIT
install -m 755 src-tauri/target/release/inpaint-desktop "$staged_binary"
mv -f -- "$staged_binary" "$project_root/inpaint-desktop"
trap - EXIT

echo "Built $project_root/inpaint-desktop"
if [[ "${1:-}" == "--portable" ]]; then
  ./scripts/bundle-portable.sh
fi
