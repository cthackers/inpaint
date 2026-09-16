#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/python-runtime.sh"

if [[ ! -x "$venv_dir/bin/python" ]]; then
  echo "Run scripts/setup-model.sh first." >&2
  exit 1
fi
ensure_venv

uv_pip install -r "$project_dir/resources/requirements.txt" "$face_wheel"
use_headless_opencv

# CPU and GPU distributions share the onnxruntime module; install only one.
if [[ "${FACE_SWAP_BACKEND:-cu128}" != "cpu" ]]; then
  uv_pip uninstall onnxruntime
  uv_pip install --no-deps "onnxruntime-gpu==1.23.2"
fi

"$venv_dir/bin/python" - "$project_dir" <<'PY'
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
