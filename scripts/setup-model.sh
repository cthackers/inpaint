#!/usr/bin/env bash
# Installs the processing runtime into .venv with Python 3.11, whatever Python the system has.
# Usage: scripts/setup-model.sh [--cpu]   (default: NVIDIA CUDA 12.8)
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/python-runtime.sh"

backend=cu128
if [[ "${1:-}" == "--cpu" ]]; then
  backend=cpu
fi

ensure_venv
uv_pip install --index-url "https://download.pytorch.org/whl/$backend" "${torch_packages[@]}"
uv_pip install -r "$project_dir/resources/requirements.txt" "$face_wheel"
use_headless_opencv

# Install face tools as well; model weights remain on demand.
FACE_SWAP_BACKEND="$backend" "$project_dir/scripts/setup-face-swap.sh"

"$venv_dir/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 11), sys.version; import numpy, torch, torchvision, cv2, PIL, onnxruntime, insightface, rembg, spandrel, iopaint, simple_lama_inpainting; print("Python", sys.version.split()[0], "· PyTorch", torch.__version__, "· NumPy", numpy.__version__); print("CUDA available:", torch.cuda.is_available())'

echo "Model environment is ready. The LaMa weights will download automatically on the first removal."
