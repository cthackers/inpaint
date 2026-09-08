"""Cached photo upscalers and adjustable Real-ESRGAN denoising."""

import math
from pathlib import Path


HAT_FILENAME = "Real_HAT_GAN_sharper.pth"
# XPixelGroup/HAT's official pretrained-model Google Drive folder.
HAT_DRIVE_ID = "1EioFq5-mKmv1uqta_Byd9cgXp9SU3zjj"
GENERAL_MODEL = "realesr-general-x4v3"
WEAK_FILENAME = "realesr-general-wdn-x4v3.pth"
WEAK_URL = f"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/{WEAK_FILENAME}"


def checkpoint(path: Path, *, url=None, drive_id=None):
    if path.is_file():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    try:
        if drive_id:
            import gdown
            if not gdown.download(id=drive_id, output=str(temporary), use_cookies=False):
                raise RuntimeError(f"Could not download {path.name}.")
        else:
            import torch
            torch.hub.download_url_to_file(url, str(temporary))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def output_size(size, scale):
    if not math.isfinite(scale) or not 1 <= scale <= 4:
        raise ValueError("Upscale factor must be between 1 and 4.")
    return tuple(max(1, round(side * scale)) for side in size)


def read_image(path):
    from PIL import Image, ImageOps
    with Image.open(path) as image:
        source = ImageOps.exif_transpose(image)
        return source.convert("RGBA" if "A" in source.getbands() or "transparency" in source.info else "RGB")


class LanczosUpscaler:
    def upscale(self, input_path, output_path, scale):
        from PIL import Image
        source = read_image(input_path)
        source.resize(output_size(source.size, scale), Image.Resampling.LANCZOS).save(output_path, format="PNG")


class HatUpscaler:
    def __init__(self, models_dir):
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        path = checkpoint(Path(models_dir) / HAT_FILENAME, drive_id=HAT_DRIVE_ID)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = ModelLoader().load_from_file(path)
        if not isinstance(self.model, ImageModelDescriptor) or self.model.scale != 4:
            raise RuntimeError("Expected a 4× HAT image upscaling checkpoint.")
        # FP32 avoids half-precision overflows in HAT's attention layers.
        self.model.to(self.device).float().eval()
        self.tile_size = 128
        self.tile_pad = 32

    def upscale(self, input_path, output_path, scale):
        import numpy as np
        import torch
        from PIL import Image

        source = read_image(input_path)
        size = output_size(source.size, scale)
        rgb = source.convert("RGB")
        width, height = rgb.size
        factor = self.model.scale
        result = Image.new("RGB", (width * factor, height * factor))
        with torch.inference_mode():
            for y in range(0, height, self.tile_size):
                for x in range(0, width, self.tile_size):
                    right, bottom = min(x + self.tile_size, width), min(y + self.tile_size, height)
                    left_pad, top_pad = max(x - self.tile_pad, 0), max(y - self.tile_pad, 0)
                    right_pad, bottom_pad = min(right + self.tile_pad, width), min(bottom + self.tile_pad, height)
                    tile = np.array(rgb.crop((left_pad, top_pad, right_pad, bottom_pad)), dtype=np.float32) / 255.0
                    tensor = torch.from_numpy(tile.transpose(2, 0, 1)).unsqueeze(0).to(self.device)
                    prediction = self.model(tensor)
                    if not torch.isfinite(prediction).all():
                        raise RuntimeError("HAT produced invalid pixels; the image was not changed.")
                    pixels = prediction.squeeze(0).clamp(0, 1).mul(255).round().to(device="cpu", dtype=torch.uint8)
                    rendered = Image.fromarray(pixels.numpy().transpose(1, 2, 0))
                    # Discard the contextual border and keep every output pixel once.
                    core = rendered.crop(((x - left_pad) * factor, (y - top_pad) * factor,
                                          (right - left_pad) * factor, (bottom - top_pad) * factor))
                    result.paste(core, (x * factor, y * factor))
        if result.size != size:
            result = result.resize(size, Image.Resampling.LANCZOS)
        if "A" in source.getbands():
            result.putalpha(source.getchannel("A").resize(size, Image.Resampling.LANCZOS))
        result.save(output_path, format="PNG", optimize=True)


class GeneralUpscaler:
    def __init__(self, models_dir, device):
        import torch
        from iopaint.plugins.realesrgan import RealESRGANUpscaler
        from iopaint.schema import RealESRGANModel

        weak_path = checkpoint(Path(models_dir) / WEAK_FILENAME, url=WEAK_URL)
        self.plugin = RealESRGANUpscaler(RealESRGANModel(GENERAL_MODEL), device)
        self.strong = torch.load(Path(models_dir) / f"{GENERAL_MODEL}.pth", map_location="cpu", weights_only=True)["params"]
        self.weak = torch.load(weak_path, map_location="cpu", weights_only=True)["params"]
        self.strength = 1.0

    def set_denoise(self, strength):
        import torch
        if not math.isfinite(strength) or not 0 <= strength <= 1:
            raise ValueError("Denoising strength must be between 0 and 1.")
        if strength == self.strength:
            return
        # Upstream deep network interpolation, using cached CPU weights.
        # Update the existing network instead of loading a model per slider value.
        with torch.no_grad():
            weights = {name: strength * value + (1 - strength) * self.weak[name]
                       for name, value in self.strong.items()}
            self.plugin.model.model.load_state_dict(weights, strict=True)
        self.strength = strength

    def gen_image(self, source, request):
        return self.plugin.gen_image(source, request)
