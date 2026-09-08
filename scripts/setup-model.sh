#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="$project_dir/.venv"
python_bin="${PYTHON_BIN:-}"

if [[ -z "$python_bin" ]]; then
  if command -v python3.11 >/dev/null 2>&1; then
    python_bin="python3.11"
  else
    python_bin="python3"
  fi
fi

"$python_bin" -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install --upgrade pip wheel
"$venv_dir/bin/python" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
"$venv_dir/bin/python" -m pip install simple-lama-inpainting
"$venv_dir/bin/python" -m pip install iopaint==1.6.0
"$venv_dir/bin/python" -m pip install \
  "numpy==1.26.4" "Pillow==9.5.0" "onnxruntime==1.19.2" \
  "scikit-image==0.24.0" "rembg==2.0.57"
"$venv_dir/bin/python" -m pip install "spandrel==0.4.2" "gdown==5.2.0"

# Install face tools as well; model weights remain on demand.
"$project_dir/scripts/setup-face-swap.sh"

"$venv_dir/bin/python" -c 'import torch; print("PyTorch", torch.__version__); print("CUDA available:", torch.cuda.is_available()); print("Device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")'

echo "Model environment is ready. The LaMa weights will download automatically on the first removal."
