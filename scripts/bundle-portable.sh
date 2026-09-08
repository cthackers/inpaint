#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"

# The GTK deployment plugin only needs librsvg's runtime directory, not headers.
# Some distributions install that runtime without its optional development .pc file.
if ! pkg-config --exists librsvg-2.0; then
  packaging_dir="$project_root/src-tauri/target/packaging-pkgconfig"
  svg_libdir="$(pkg-config --variable=libdir gdk-pixbuf-2.0)"
  if ! compgen -G "$svg_libdir/librsvg-*.so*" > /dev/null; then
    echo "Install the librsvg runtime before creating an AppImage." >&2
    exit 1
  fi
  mkdir -p "$packaging_dir"
  cat > "$packaging_dir/librsvg-2.0.pc" <<EOF
libdir=$svg_libdir
Name: librsvg-runtime
Description: Runtime location for AppImage deployment
Version: 2.0
EOF
  export PKG_CONFIG_PATH="$packaging_dir${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi

# The linuxdeploy release bundles a strip too old for modern RELR ELF sections.
NO_STRIP=1 npm run tauri -- bundle --bundles appimage "$@"
portable_files=(src-tauri/target/release/bundle/appimage/*.AppImage)
install -m 755 "${portable_files[0]}" "$project_root/inpaint-desktop.AppImage"
echo "Portable package: $project_root/inpaint-desktop.AppImage"
