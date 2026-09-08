"""Interactive selections, manual retouching and edge refinement."""
import hashlib
import numpy as np
from PIL import Image, ImageFilter
from editing import read_rgba, number


class SmartSelection:
    def __init__(self):
        import torch
        from iopaint.helper import download_model
        from iopaint.plugins.segment_anything import sam_model_registry, SamPredictor
        checkpoint = download_model("https://github.com/Sanster/models/releases/download/MobileSAM/mobile_sam.pt",
                                    "f3c0d8cda613564d499310dab6c812cd")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.predictor = SamPredictor(sam_model_registry["mobile_sam"](checkpoint=checkpoint).to(device))
        self.digest = None

    def select(self, input_path, output_path, options):
        import torch
        image = np.array(read_rgba(input_path).convert("RGB"))
        points = options.get("points", [])
        if not points or len(points) > 100:
            raise ValueError("Add between 1 and 100 selection points.")
        coords = [[number(p[0], 0, 1, "Point") * (image.shape[1] - 1),
                   number(p[1], 0, 1, "Point") * (image.shape[0] - 1)] for p in points]
        labels = [int(number(p[2], 0, 1, "Point label")) for p in points]
        digest = hashlib.sha256(image.tobytes()).digest()
        with torch.inference_mode():
            if digest != self.digest:
                self.predictor.set_image(image)
                self.digest = digest
            masks, scores, _ = self.predictor.predict(point_coords=np.array(coords), point_labels=np.array(labels), multimask_output=True)
        Image.fromarray(masks[int(np.argmax(scores))].astype(np.uint8) * 255).save(output_path, "PNG")


def mask_edit(input_path, output_path, options):
    image = read_rgba(input_path)
    mask = image.getchannel("A") if options.get("alpha") else image.convert("L")
    amount = round(number(options.get("grow", 0), -64, 64, "Mask grow"))
    if amount:
        mask = mask.filter(ImageFilter.MaxFilter(abs(amount) * 2 + 1) if amount > 0 else ImageFilter.MinFilter(abs(amount) * 2 + 1))
    feather = number(options.get("feather", 0), 0, 64, "Mask feather")
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    mask.save(output_path, "PNG")


def refine_edges(input_path, output_path, options):
    import cv2
    image = read_rgba(input_path)
    rgba = np.array(image)
    alpha = image.getchannel("A")
    if alpha.getextrema() == (255, 255):
        raise ValueError("Remove the background before refining its edges.")
    shrink = round(number(options.get("shrink", 1), -16, 16, "Edge shrink"))
    if shrink:
        alpha = alpha.filter(ImageFilter.MinFilter(abs(shrink) * 2 + 1) if shrink > 0 else ImageFilter.MaxFilter(abs(shrink) * 2 + 1))
    soft = number(options.get("soften", .5), 0, 10, "Edge softness")
    if soft:
        alpha = alpha.filter(ImageFilter.GaussianBlur(soft))
    decontaminate = number(options.get("decontaminate", .5), 0, 1, "Remove halos")
    if decontaminate:
        a = rgba[:, :, 3]
        edge = ((a > 0) & (a < 250)).astype(np.uint8) * 255
        # Extend nearby opaque foreground colors into the transition pixels.
        opaque = a >= 250
        if np.any(opaque):
            _, labels = cv2.distanceTransformWithLabels((~opaque).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
            palette = np.zeros((int(labels.max()) + 1, 3), dtype=np.uint8)
            palette[labels[opaque]] = rgba[:, :, :3][opaque]
            rgb = palette[labels]
            blend = (edge[:, :, None] / 255 * decontaminate).astype(np.float32)
            rgba[:, :, :3] = np.rint(rgba[:, :, :3] * (1 - blend) + rgb * blend).astype(np.uint8)
    rgba[:, :, 3] = np.array(alpha)
    Image.fromarray(rgba).save(output_path, "PNG")


def retouch(input_path, output_path, options):
    import cv2
    source = read_rgba(input_path)
    pixels = np.array(source)
    h, w = pixels.shape[:2]
    radius = number(options.get("size", 30), 1, 1000, "Brush size") / 2
    hardness = number(options.get("hardness", .5), 0, 1, "Hardness")
    opacity = number(options.get("opacity", 1), 0, 1, "Opacity")
    points = options.get("points", [])
    if not points or len(points) > 20000:
        raise ValueError("Invalid brush stroke.")
    coords = [(round(number(p[0], 0, 1, "Stroke position") * (w - 1)), round(number(p[1], 0, 1, "Stroke position") * (h - 1))) for p in points]
    donor = options.get("source")
    if donor is None:
        raise ValueError("Alt-click a source point before cloning or healing.")
    dx = round(number(donor[0], 0, 1, "Source point") * (w - 1)) - coords[0][0]
    dy = round(number(donor[1], 0, 1, "Source point") * (h - 1)) - coords[0][1]
    mask = np.zeros((h, w), dtype=np.uint8)
    for start, end in zip(coords, coords[1:] or coords):
        cv2.line(mask, start, end, 255, max(1, round(radius * 2 * (.3 + .7 * hardness))), cv2.LINE_AA)
    for point in (coords[0], coords[-1]):
        cv2.circle(mask, point, max(1, round(radius * (.3 + .7 * hardness))), 255, -1)
    blur = radius * (1 - hardness) * .35
    if blur > .1:
        mask = cv2.GaussianBlur(mask, (0, 0), blur)
    translated = cv2.warpAffine(pixels[:, :, :3], np.float32([[1, 0, -dx], [0, 1, -dy]]), (w, h), borderMode=cv2.BORDER_REFLECT_101)
    valid = cv2.warpAffine(np.ones((h, w), np.uint8), np.float32([[1, 0, -dx], [0, 1, -dy]]), (w, h))
    mask = mask * valid
    if options.get("mode") == "heal":
        # Preserve source texture while matching the destination's local lighting/color.
        sigma = max(2, radius)
        texture = translated.astype(np.float32) - cv2.GaussianBlur(translated.astype(np.float32), (0, 0), sigma)
        translated = np.clip(texture + cv2.GaussianBlur(pixels[:, :, :3].astype(np.float32), (0, 0), sigma), 0, 255)
    mix = mask[:, :, None].astype(np.float32) / 255 * opacity
    pixels[:, :, :3] = np.rint(pixels[:, :, :3] * (1 - mix) + translated * mix).astype(np.uint8)
    Image.fromarray(pixels).save(output_path, "PNG")
