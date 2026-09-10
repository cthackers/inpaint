#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The key decides the extension's ID, so it lives outside the checkout and is reused by every build.
key="${INPAINT_EXTENSION_KEY:-${XDG_CONFIG_HOME:-$HOME/.config}/inpaint/extension-key.pem}"
output="$project_root"

usage() {
  cat <<EOF
Usage: ./build-extension.sh [--key FILE] [--out FOLDER]

Packs browser-extension/ into inpaint-extension.crx (signed) and inpaint-extension.zip.

  --key FILE     RSA signing key in PEM format, created when missing
                 (default: \$INPAINT_EXTENSION_KEY or ${key/#$HOME/\~})
  --out FOLDER   where the packages go (default: the project root)
EOF
}

while (($#)); do
  case "$1" in
    --key) key="${2:?--key needs a file}"; shift 2 ;;
    --out) output="${2:?--out needs a folder}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null; then
  echo "Node.js is needed to pack the extension" >&2
  exit 1
fi
node "$project_root/scripts/pack-extension.mjs" "$project_root/browser-extension" "$key" "$output"
