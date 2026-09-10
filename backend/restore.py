"""Same-size detail restoration. A mode runs one or two networks over the picture at its own resolution:
FBCNN removes JPEG compression, SCUNet removes camera noise, Real-ESRGAN 2x and Real-HAT 4x add detail by
enlarging each tile and shrinking it straight back, and Restormer reduces motion blur. Tiles overlap and
are feathered together, so GPU memory holds one tile at a time."""
import math
from pathlib import Path

from downloads import download, progress
from upscale import HAT_DRIVE_ID, HAT_FILENAME, checkpoint, read_image

# name: (label, file name, download address, tile size on the GPU, scale)
NETWORKS = {
    "fbcnn": ("JPEG cleanup", "fbcnn_color.pth", "https://github.com/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth", 512, 1),
    "scunet": ("Noise removal", "scunet_color_real_psnr.pth", "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth", 512, 1),
    "realesrgan": ("Real-ESRGAN detail", "RealESRGAN_x2plus.pth", "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth", 384, 2),
    "hat": ("Real-HAT detail", HAT_FILENAME, None, 192, 4),
    "restormer": ("Motion deblurring", "motion_deblurring.pth", None, 512, 1),
}
# Measured on shrunk, JPEG-compressed and blurred photos: cleaning compression before adding detail keeps
# the detail networks from sharpening JPEG blocks.
MODES = {
    "compressed": ("fbcnn", "realesrgan"),
    "natural": ("fbcnn", "hat"),
    "jpeg": ("fbcnn",),
    "noise": ("scunet",),
    "motion": ("restormer",),
}
MIN_TILE = 64


def tile_starts(length, size, overlap):
    if length <= size:
        return [0]
    return list(range(0, length - size, size - overlap)) + [length - size]


def feather(start, end, limit, overlap):
    """Weights along one side of a tile, fading the edges that a neighbouring tile overlaps."""
    import numpy as np

    weight = np.ones(end - start, dtype=np.float32)
    count = min(overlap, len(weight))
    ramp = np.linspace(1 / (count + 1), 1, count, dtype=np.float32)
    if start > 0:
        weight[:count] *= ramp
    if end < limit:
        weight[-count:] *= ramp[::-1]
    return weight


class DetailRestorer:
    def __init__(self, models_dir, checkpoints_dir, restormer_dir):
        import torch

        self.models_dir = Path(models_dir)
        self.checkpoints_dir = Path(checkpoints_dir)
        self.restormer_dir = Path(restormer_dir)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        # Networks load on first use and stay loaded, so modes that share one reuse it.
        self.networks = {}
        # Halved for every network when the GPU runs out of memory.
        self.tile_scale = 1.0 if self.device.type == "cuda" else 0.5

    def _network(self, name):
        if name in self.networks:
            return self.networks[name]
        label, filename, url, _, scale = NETWORKS[name]
        progress(f"Restore detail · {label}", None, "Loading cached weights or downloading on first use")
        if name == "restormer":
            from restormer import MotionDeblur
            network = MotionDeblur(self.restormer_dir)
        else:
            from spandrel import ImageModelDescriptor, ModelLoader
            if name == "hat":
                path = checkpoint(self.checkpoints_dir / filename, drive_id=HAT_DRIVE_ID)
            else:
                path = download(url, self.models_dir / filename)
            network = ModelLoader().load_from_file(path)
            if not isinstance(network, ImageModelDescriptor):
                raise RuntimeError(f"{filename} is not an image restoration model.")
            network.model.float().eval().requires_grad_(False)
        if network.scale != scale:
            raise RuntimeError(f"{filename} works at {network.scale}×, expected {scale}×.")
        self.networks[name] = network
        network.to(self.device)
        return network

    def _tile_size(self, name):
        return max(MIN_TILE, int(NETWORKS[name][3] * self.tile_scale))

    def _run(self, name, pixels, step, steps):
        import numpy as np
        import torch
        import torch.nn.functional as F

        network = self._network(name)
        label = NETWORKS[name][0]
        height, width = pixels.shape[:2]
        tile = self._tile_size(name)
        overlap = min(tile // 2, max(16, tile // 8))
        xs, ys = tile_starts(width, tile, overlap), tile_starts(height, tile, overlap)
        # Accumulate on the CPU at the original size.
        result = np.zeros_like(pixels)
        weights = np.zeros((height, width, 1), dtype=np.float32)
        total, completed = len(xs) * len(ys), 0
        for y in ys:
            for x in xs:
                bottom, right = min(height, y + tile), min(width, x + tile)
                part = pixels[y:bottom, x:right]
                tensor = torch.from_numpy(np.ascontiguousarray(part.transpose(2, 0, 1))).unsqueeze(0).to(self.device)
                with torch.inference_mode():
                    output = network(tensor)
                    if network.scale != 1:
                        output = F.interpolate(output, size=part.shape[:2], mode="bicubic", antialias=True)
                    if not torch.isfinite(output).all():
                        raise RuntimeError(f"{label} produced invalid pixels; the image was not changed.")
                    output = output[0].clamp(0, 1).permute(1, 2, 0).cpu().numpy()
                weight = feather(y, bottom, height, overlap)[:, None, None] * feather(x, right, width, overlap)[None, :, None]
                result[y:bottom, x:right] += output * weight
                weights[y:bottom, x:right] += weight
                completed += 1
                progress(f"Restore detail · {label}", round(completed * 100 / total),
                         f"Step {step}/{steps} · tile {completed}/{total} · {self.device.type.upper()}")
        return result / weights

    def restore(self, input_path, output_path, mode, strength=1.0):
        import numpy as np
        import torch
        from PIL import Image

        if mode not in MODES:
            raise ValueError("Choose a supported restoration mode.")
        if not math.isfinite(strength) or not 0 <= strength <= 1:
            raise ValueError("Restoration strength must be between 0 and 1.")
        source = read_image(input_path)
        if source.width * source.height > 64_000_000:
            raise ValueError("Restore detail supports images up to 64 megapixels.")
        if strength == 0:
            source.save(output_path, format="PNG")
            return
        original = np.asarray(source.convert("RGB"), dtype=np.float32) / 255
        names = MODES[mode]
        while True:
            try:
                pixels = original
                for step, name in enumerate(names, 1):
                    pixels = self._run(name, pixels, step, len(names))
                break
            except torch.cuda.OutOfMemoryError:
                if self.device.type != "cuda":
                    raise
                torch.cuda.empty_cache()
                if min(self._tile_size(name) for name in names) > MIN_TILE:
                    self.tile_scale /= 2
                    detail = "Using smaller tiles to fit GPU memory"
                else:
                    self.device = torch.device("cpu")
                    for network in self.networks.values():
                        network.to(self.device)
                    torch.cuda.empty_cache()
                    detail = "GPU memory is full; continuing on CPU"
                progress("Restore detail", None, detail)
        result = original * (1 - strength) + pixels * strength if strength < 1 else pixels
        result = np.rint(np.clip(result * 255, 0, 255)).astype(np.uint8)
        output = Image.fromarray(result, "RGB")
        if source.mode == "RGBA":
            output.putalpha(source.getchannel("A"))
        output.save(output_path, format="PNG")
