"""Cached, same-resolution Restormer restoration with overlapping inference tiles."""
import math
from pathlib import Path

from downloads import download, progress
from upscale import read_image

MODELS = {
    "motion": ("motion_deblurring.pth", "Motion blur", "WithBias"),
    "defocus": ("single_image_defocus_deblurring.pth", "Out-of-focus blur", "WithBias"),
    "denoise": ("real_denoising.pth", "Photo noise", "BiasFree"),
}
MODEL_URL = "https://github.com/swz30/Restormer/releases/download/v1.0/"


def tile_starts(length, size, overlap):
    if length <= size:
        return [0]
    return list(range(0, length - size, size - overlap)) + [length - size]


class RestormerRestorer:
    def __init__(self, models_dir, variant):
        import torch
        from restormer_arch import Restormer

        if variant not in MODELS:
            raise ValueError("Choose a supported Restormer model.")
        filename, self.label, norm = MODELS[variant]
        path = download(MODEL_URL + filename, Path(models_dir) / filename)
        self.model = Restormer(LayerNorm_type=norm).float()
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
        self.model.load_state_dict(checkpoint["params"], strict=True)
        del checkpoint
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.eval().requires_grad_(False)
        try:
            self.model.to(self.device)
        except torch.cuda.OutOfMemoryError:
            self.model.cpu()
            self.device = torch.device("cpu")
            torch.cuda.empty_cache()
            progress("Restormer", None, "GPU memory is full; using CPU")
        self.tile_size = 512 if self.device.type == "cuda" else 256

    def _predict(self, pixels):
        import numpy as np
        import torch
        import torch.nn.functional as F

        height, width = pixels.shape[:2]
        tensor = torch.from_numpy(np.ascontiguousarray(pixels.transpose(2, 0, 1))).unsqueeze(0).to(self.device)
        pad_h, pad_w = (-height) % 8, (-width) % 8
        if pad_h or pad_w:
            # Reflection requires each padding size to be smaller than its axis.
            mode = "reflect" if height > pad_h and width > pad_w else "replicate"
            tensor = F.pad(tensor, (0, pad_w, 0, pad_h), mode=mode)
        with torch.inference_mode():
            prediction = self.model(tensor)[0, :, :height, :width]
            if not torch.isfinite(prediction).all():
                raise RuntimeError("Restormer produced invalid pixels; the image was not changed.")
            return prediction.clamp(0, 1).permute(1, 2, 0).cpu().numpy()

    def _restore(self, rgb, strength):
        import numpy as np
        from PIL import Image

        width, height = rgb.size
        overlap = min(64, self.tile_size // 4)
        xs = tile_starts(width, self.tile_size, overlap)
        ys = tile_starts(height, self.tile_size, overlap)
        # Accumulate on CPU; GPU working memory only contains one padded tile.
        result = np.zeros((height, width, 3), dtype=np.float32)
        weights = np.zeros((height, width, 1), dtype=np.float32)
        total, completed = len(xs) * len(ys), 0
        for y in ys:
            for x in xs:
                right, bottom = min(width, x + self.tile_size), min(height, y + self.tile_size)
                pixels = np.asarray(rgb.crop((x, y, right, bottom)), dtype=np.float32) / 255.0
                prediction = self._predict(pixels)
                tile_h, tile_w = pixels.shape[:2]
                wy, wx = np.ones(tile_h, dtype=np.float32), np.ones(tile_w, dtype=np.float32)
                # Feather overlaps to avoid hard boundaries between tile results.
                for weight, start, end, limit in ((wy, y, bottom, height), (wx, x, right, width)):
                    count = min(overlap, len(weight))
                    ramp = np.linspace(1 / (count + 1), 1, count, dtype=np.float32)
                    if start > 0:
                        weight[:count] *= ramp
                    if end < limit:
                        weight[-count:] *= ramp[::-1]
                weight = (wy[:, None] * wx[None, :])[:, :, None]
                result[y:bottom, x:right] += (pixels * (1 - strength) + prediction * strength) * weight
                weights[y:bottom, x:right] += weight
                completed += 1
                progress(f"Restormer · {self.label}", round(completed * 100 / total),
                         f"Restoring tile {completed}/{total} · {self.device.type.upper()}")
        result /= weights
        result *= 255
        np.clip(result, 0, 255, out=result)
        np.rint(result, out=result)
        return Image.fromarray(result.astype(np.uint8), "RGB")

    def restore(self, input_path, output_path, strength=1.0):
        import torch

        if not math.isfinite(strength) or not 0 <= strength <= 1:
            raise ValueError("Restormer strength must be between 0 and 1.")
        source = read_image(input_path)
        if source.width * source.height > 64_000_000:
            raise ValueError("Restormer supports images up to 64 megapixels.")
        if strength == 0:
            source.save(output_path, format="PNG")
            return
        rgb = source.convert("RGB")
        while True:
            try:
                result = self._restore(rgb, strength)
                break
            except torch.cuda.OutOfMemoryError:
                if self.device.type != "cuda":
                    raise
                if self.tile_size > 128:
                    self.tile_size //= 2
                    detail = f"Using smaller {self.tile_size}px tiles to fit GPU memory"
                else:
                    self.model.cpu()
                    self.device = torch.device("cpu")
                    detail = "GPU memory is full; continuing on CPU"
                torch.cuda.empty_cache()
                progress("Restormer", None, detail)
        if source.mode == "RGBA":
            result.putalpha(source.getchannel("A"))
        result.save(output_path, format="PNG")
