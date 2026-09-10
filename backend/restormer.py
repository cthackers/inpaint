"""Restormer's motion deblurring network, run in tiles by restore.py."""
from pathlib import Path

from downloads import download

MODEL_URL = "https://github.com/swz30/Restormer/releases/download/v1.0/motion_deblurring.pth"


class MotionDeblur:
    """Called like a spandrel model: a (1, 3, H, W) tensor in [0, 1] in, the same size out."""

    scale = 1

    def __init__(self, models_dir):
        import torch
        from restormer_arch import Restormer

        path = download(MODEL_URL, Path(models_dir) / "motion_deblurring.pth")
        self.model = Restormer(LayerNorm_type="WithBias").float()
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
        self.model.load_state_dict(checkpoint["params"], strict=True)
        del checkpoint
        self.model.eval().requires_grad_(False)

    def to(self, device):
        self.model.to(device)
        return self

    def __call__(self, tensor):
        import torch.nn.functional as F

        height, width = tensor.shape[-2:]
        pad_h, pad_w = (-height) % 8, (-width) % 8
        if pad_h or pad_w:
            # Reflection requires each padding size to be smaller than its axis.
            mode = "reflect" if height > pad_h and width > pad_w else "replicate"
            tensor = F.pad(tensor, (0, pad_w, 0, pad_h), mode=mode)
        return self.model(tensor)[:, :, :height, :width]
