#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"

# An AppImage carries the GTK and WebKitGTK libraries of the system that builds it, and they only load where
# glibc is at least as new. Building in an Ubuntu 22.04 container keeps the AppImage working on older
# distributions such as Linux Mint 21; a build on this machine would only run on equally new systems.
image=inpaint-appimage-builder:ubuntu-22.04
cache=src-tauri/target/appimage

if command -v docker > /dev/null && ! docker --version 2> /dev/null | grep -qi podman; then
  engine=docker
  # Files written into the checkout belong to the current user, not root.
  run_as=(--user "$(id -u):$(id -g)")
elif command -v podman > /dev/null; then
  engine=podman
  run_as=(--userns=keep-id)
else
  echo "Building the AppImage needs Docker or Podman: it is built in an Ubuntu 22.04 container so that it runs on older distributions." >&2
  exit 1
fi

"$engine" build --tag "$image" --file scripts/appimage/Containerfile scripts/appimage
mkdir -p "$cache/home"
# label=disable lets the container read the checkout on SELinux systems without relabelling it.
"$engine" run --rm "${run_as[@]}" --security-opt label=disable \
  --volume "$project_root:/project" --workdir /project \
  --env HOME="/project/$cache/home" \
  --env CARGO_HOME="/project/$cache/home/cargo" \
  --env CARGO_TARGET_DIR="/project/$cache/target" \
  --env APPIMAGE_EXTRACT_AND_RUN=1 \
  --env OLDEST_GLIBC=2.35 \
  "$image" scripts/appimage/build.sh "$@"

portable_files=("$cache"/target/release/bundle/appimage/*.AppImage)
# Replace atomically so a running AppImage keeps working.
staged="$(mktemp "$project_root/.inpaint-desktop.AppImage.XXXXXX")"
trap 'rm -f -- "$staged"' EXIT
install -m 755 "${portable_files[0]}" "$staged"
mv -f -- "$staged" "$project_root/inpaint-desktop.AppImage"
trap - EXIT
echo "Portable package: $project_root/inpaint-desktop.AppImage"
