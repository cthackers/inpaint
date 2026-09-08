"""Image geometry, compositing and collision-safe exports without model dependencies."""
import math
import os
import tempfile
from pathlib import Path


def number(value, minimum, maximum, label):
    value = float(value)
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}.")
    return value


def read_rgba(path):
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        return ImageOps.exif_transpose(source).convert("RGBA")


def edit_image(input_path, output_path, options, reference_path=None):
    from PIL import Image, ImageColor, ImageFilter, ImageOps
    source = read_rgba(input_path)
    operation = options.get("kind")
    if operation == "crop":
        angle = number(options.get("angle", 0), -45, 45, "Angle")
        x, y, width, height = [number(v, 0, 1, "Crop bounds") for v in options["rect"]]
        if width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
            raise ValueError("Crop must stay inside the image.")
        source = source.rotate(-angle, resample=Image.Resampling.BICUBIC)
        box = (round(x * source.width), round(y * source.height),
               round((x + width) * source.width), round((y + height) * source.height))
        if box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError("Crop must contain at least one pixel.")
        result = source.crop(box)
    elif operation == "background":
        if source.getchannel("A").getextrema() == (255, 255):
            raise ValueError("Remove the background first, or enable automatic background removal.")
        mode = options.get("mode", "color")
        if mode == "color":
            result = Image.new("RGBA", source.size, ImageColor.getrgb(options.get("color", "#ffffff")))
        elif mode == "image":
            result = ImageOps.fit(read_rgba(options["path"]), source.size, Image.Resampling.LANCZOS)
        elif mode == "blur":
            if reference_path is None:
                raise ValueError("The original image is required for a blurred background.")
            result = ImageOps.fit(read_rgba(reference_path), source.size, Image.Resampling.LANCZOS)
            result = result.filter(ImageFilter.GaussianBlur(number(options.get("blur", 20), 1, 100, "Blur")))
        else:
            raise ValueError("Unsupported background type.")
        result = Image.alpha_composite(result, source)
    else:
        raise ValueError("Unsupported image edit.")
    result.save(output_path, "PNG")


def export_image(input_path, options):
    from PIL import Image, ImageColor
    source = read_rgba(input_path)
    format_name = options.get("format", "png")
    if format_name not in {"png", "jpeg", "webp"}:
        raise ValueError("Choose PNG, JPEG or WebP.")
    quality = round(number(options.get("quality", 95), 1, 100, "Quality"))
    width = round(number(options.get("width", 0), 0, 32768, "Width"))
    height = round(number(options.get("height", 0), 0, 32768, "Height"))
    if width or height:
        width = width or max(1, round(source.width * height / source.height))
        height = height or max(1, round(source.height * width / source.width))
        if width * height > 150_000_000:
            raise ValueError("Export is limited to 150 megapixels.")
        source = source.resize((width, height), Image.Resampling.LANCZOS)
    if format_name == "jpeg":
        background = Image.new("RGBA", source.size, ImageColor.getrgb(options.get("matte", "#ffffff")))
        source = Image.alpha_composite(background, source).convert("RGB")
    directory = Path(options["directory"])
    if not directory.is_dir():
        raise ValueError("Choose an existing export folder.")
    name = Path(options.get("name", "image")).stem
    suffix = options.get("suffix", "_edited")
    if any(c in suffix for c in '/\\\x00') or len(suffix) > 100:
        raise ValueError("Filename suffix cannot contain path separators and must be at most 100 characters.")
    if not name or name in {".", ".."}:
        name = "image"
    extension = "jpg" if format_name == "jpeg" else format_name
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".inpaint-export-", dir=directory, delete=False) as handle:
            temporary = Path(handle.name)
            kwargs = {} if format_name == "png" else {"quality": quality}
            source.save(handle, format_name.upper(), **kwargs)
        # Atomic publication with no overwrite, including concurrent exports.
        for index in range(100000):
            extra = f"_{index}" if index else ""
            destination = directory / f"{name}{suffix}{extra}.{extension}"
            try:
                os.link(temporary, destination)
                return {"path": str(destination), "width": source.width, "height": source.height,
                        "bytes": destination.stat().st_size}
            except FileExistsError:
                continue
        raise ValueError("Too many exports with the same filename.")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
