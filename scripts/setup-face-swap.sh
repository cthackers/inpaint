#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="$project_dir/.venv/bin/python"
if [[ ! -x "$python_bin" ]]; then
  echo "Run scripts/setup-model.sh first." >&2
  exit 1
fi

"$python_bin" -m pip install -r "$project_dir/backend/requirements-face-swap.txt"

# CPU and GPU distributions share the onnxruntime module; install only one.
# Download first, so a network failure cannot remove the working runtime.
wheel_dir="$(mktemp -d)"
trap 'rm -rf -- "$wheel_dir"' EXIT
"$python_bin" -m pip download --no-deps --dest "$wheel_dir" "onnxruntime-gpu==1.23.2"
"$python_bin" -m pip uninstall -y onnxruntime
"$python_bin" -m pip install --no-index --find-links "$wheel_dir" --no-deps --force-reinstall "onnxruntime-gpu==1.23.2"

"$python_bin" - "$project_dir" <<'PY'
import os
from pathlib import Path
import shutil
import sys

project = Path(sys.argv[1])
source = Path(os.environ.get("FACE_SWAP_PROJECT_DIR", "/media/sy/Projects/open-source/face-swap"))
analysis = Path(os.environ.get("INSIGHTFACE_MODELS_DIR", str(Path.home() / ".insightface/models/buffalo_l")))
destination = project / "models/faceswap"
copies = [
    (source / "models/inswapper_128.onnx", destination / "inswapper_128.onnx"),
    (analysis / "det_10g.onnx", destination / "models/buffalo_l/det_10g.onnx"),
    (analysis / "w600k_r50.onnx", destination / "models/buffalo_l/w600k_r50.onnx"),
]
for original, target in copies:
    if target.is_file():
        continue
    if not original.is_file():
        continue  # The application downloads missing weights on first use.
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".copying")
    try:
        shutil.copyfile(original, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
print("Face-swap dependencies are ready. Missing models download automatically on first use.")
PY
