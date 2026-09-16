#!/usr/bin/env bash
# Runs inside the build container that scripts/bundle-portable.sh starts.
set -euo pipefail

# linuxdeploy's bundled strip does not handle every ELF section; the libraries it bundles are already stripped.
NO_STRIP=1 npm run tauri -- build --bundles appimage "$@"

# Every bundled file must load with the oldest glibc the AppImage supports.
bundle="$CARGO_TARGET_DIR/release/bundle/appimage"
newest="$(find "$bundle"/*.AppDir -type f -exec objdump -T {} + 2> /dev/null | grep -o 'GLIBC_2\.[0-9]*' | sort -uV | tail -n 1 || true)"
if [[ "$(printf '%s\n' "$newest" "GLIBC_$OLDEST_GLIBC" | sort -V | tail -n 1)" != "GLIBC_$OLDEST_GLIBC" ]]; then
  echo "The AppImage needs $newest, newer than glibc $OLDEST_GLIBC." >&2
  exit 1
fi
echo "Bundled files need at most $newest."
