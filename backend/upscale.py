"""Cached photo upscalers and adjustable Real-ESRGAN denoising."""

import math
from pathlib import Path


HAT_FILENAME = "Real_HAT_GAN_sharper.pth"
# XPixelGroup/HAT's official pretrained-model Google Drive folder.
HAT_DRIVE_ID = "1EioFq5-mKmv1uqta_Byd9cgXp9SU3zjj"
GENERAL_MODEL = "realesr-general-x4v3"
WEAK_FILENAME = "realesr-general-wdn-x4v3.pth"
WEAK_URL = f"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/{WEAK_FILENAME}"


# Upscalers that keep a photo's own texture, chosen by measurement: on shrunk photos the Real-ESRGAN and
# Real-HAT GAN models kept 43-52% of the original fine detail (the smooth, plastic look), these 66-92%.
# name: (file, download address, SHA-256). Both by Philip Hofmann (Phhofm/models), CC-BY-4.0.
PHOTO_MODELS = {
    # Trained on web-like degradations: keeps texture without sharpening JPEG artifacts into it.
    "realwebphoto-dat2": ("4xRealWebPhoto_v4_dat2.pth",
                          "https://github.com/Phhofm/models/releases/download/4xRealWebPhoto_v4_dat2/4xRealWebPhoto_v4_dat2.pth",
                          "9b82f8f60826e59b9d2e56a6e6ad9a842b84d57a9ec5ed7377bf120032b2c4c9"),
    # Trained on clean photos: the most detail, but it also sharpens compression artifacts.
    "nomos2-hq-atd": ("4xNomos2_hq_atd.pth",
                      "https://github.com/Phhofm/models/releases/download/4xNomos2_hq_atd/4xNomos2_hq_atd.pth",
                      "06e007a70af59c4e3acfbfbd5dca4ed20dfaeadd9857ffca63c8c807a8c40283"),
}


def checkpoint(path: Path, *, url=None, drive_id=None, sha256=None):
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
            torch.hub.download_url_to_file(url, str(temporary), hash_prefix=sha256)
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


class SpandrelUpscaler:
    """A 4× network spandrel loads, run in overlapping tiles and resized to the asked scale."""

    def __init__(self, path, name):
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        self.name = name
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = ModelLoader().load_from_file(path)
        if not isinstance(self.model, ImageModelDescriptor) or self.model.scale != 4:
            raise RuntimeError(f"Expected a 4× {name} image upscaling checkpoint.")
        # FP32 avoids half-precision overflows in the attention layers these networks share.
        self.model.to(self.device).float().eval()
        # Larger tiles run about 30% faster (measured on DAT2 and ATD, 256 px: 1.6-2.3 GB), where the GPU
        # has the room; smaller cards keep 128 px tiles, under 1 GB.
        roomy = self.device.type == "cuda" and torch.cuda.mem_get_info()[0] > 6 * 2**30
        self.tile_size = 256 if roomy else 128
        self.tile_pad = 24 if roomy else 32

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
                        raise RuntimeError(f"{self.name} produced invalid pixels; the image was not changed.")
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


def HatUpscaler(models_dir):
    return SpandrelUpscaler(checkpoint(Path(models_dir) / HAT_FILENAME, drive_id=HAT_DRIVE_ID), "HAT")


def PhotoUpscaler(models_dir, option):
    if option not in PHOTO_MODELS:
        raise ValueError(f"unsupported upscaler: {option}")
    file, url, sha256 = PHOTO_MODELS[option]
    return SpandrelUpscaler(checkpoint(Path(models_dir) / file, url=url, sha256=sha256), file.removesuffix(".pth"))


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
