# Sourced by setup-model.sh and setup-face-swap.sh: the same private Python 3.11 and uv the app's own
# installer uses (src-tauri/src/runtime.rs), whatever Python the system has.

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="$project_dir/.venv"
python_version=3.11
torch_packages=(torch==2.11.0 torchvision==0.26.0)
face_wheel="$project_dir/resources/insightface-0.7.3-cp311-cp311-linux_x86_64.whl"

# Python and uv settings of the shell would point the install at another Python or other packages.
for variable in $(compgen -e); do
  case "$variable" in
    PYTHON*|UV_*|PIP_*|CONDA*|VIRTUAL_ENV|PYENV_VERSION) unset "$variable" ;;
  esac
done
export PYTHONNOUSERSITE=1
export UV_PYTHON_INSTALL_DIR="$project_dir/python"
export UV_CACHE_DIR="$project_dir/.cache/uv"
export UV_NO_CONFIG=1

# The uv embedded in the app, so scripts and app resolve alike.
uv="$project_dir/runtime-tools/uv"
if [[ ! -x "$uv" || "$project_dir/resources/uv.gz" -nt "$uv" ]]; then
  mkdir -p "$project_dir/runtime-tools"
  gzip -dc "$project_dir/resources/uv.gz" > "$uv.installing"
  chmod 755 "$uv.installing"
  mv -f "$uv.installing" "$uv"
fi

# The Python version a virtual environment was made with (`version` from venv, `version_info` from uv).
venv_version() {
  sed -n -E 's/^(version|version_info)[[:space:]]*=[[:space:]]*([0-9.]+).*/\2/p' "$venv_dir/pyvenv.cfg" 2> /dev/null | head -n 1
}

venv_usable() {
  local version
  version="$(venv_version)"
  [[ "$version" == "$python_version" || "$version" == "$python_version".* ]] && "$venv_dir/bin/python" -c pass 2> /dev/null
}

# Makes .venv with Python 3.11, replacing one made with another Python.
ensure_venv() {
  if [[ -e "$venv_dir" ]] && ! venv_usable; then
    echo "Replacing $venv_dir, made with Python $(venv_version || true); it needs Python $python_version." >&2
    rm -rf -- "$venv_dir"
  fi
  if [[ ! -x "$venv_dir/bin/python" ]]; then
    # A Python 3.11 of the system works too; uv downloads its own when there is none.
    "$uv" python install "$python_version"
    "$uv" venv --python "$python_version" "$venv_dir"
  fi
}

uv_pip() {
  "$uv" pip "$1" --python "$venv_dir/bin/python" "${@:2}"
}

# IOPaint asks for OpenCV's GUI build, which needs libGL and writes the same cv2 module as the headless
# build; removing it and reinstalling the headless build leaves one cv2 that loads without a display stack.
use_headless_opencv() {
  local headless
  headless="$(grep -E '^opencv-python-headless==' "$project_dir/resources/requirements.txt")"
  uv_pip uninstall opencv-python
  uv_pip install --reinstall --no-deps "$headless"
}
