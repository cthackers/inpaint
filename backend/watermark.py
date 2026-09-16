"""Watermark detection with Florence-2, as WatermarkRemover-AI (MIT, github.com/D-Ogi/WatermarkRemover-AI)
does it: open-vocabulary detection boxes for a few text prompts become a mask for inpainting."""
from PIL import Image, ImageDraw
from editing import read_rgba, number

# Microsoft's own checkpoint (MIT), pinned: its model code ships in the repository and runs with the
# Transformers release IOPaint needs, where the native Florence-2 class of later releases does not exist.
FLORENCE_REPO = "microsoft/Florence-2-large"
FLORENCE_REVISION = "21a599d414c4d928c9032694c424fb94458e3594"
DETECTION_TASK = "<OPEN_VOCABULARY_DETECTION>"
# Each prompt yields one box; measured on stock-style marks, these three find a large translucent word, a
# small corner credit and logo-like marks between them.
DEFAULT_PROMPTS = ["watermark", "watermark text", "translucent text overlay"]


class WatermarkDetector:
    def __init__(self):
        import torch
        from unittest.mock import patch
        from transformers import AutoModelForCausalLM, AutoProcessor
        from transformers.dynamic_module_utils import get_imports

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if self.device == "cuda" else torch.float32

        # The model code names flash_attn as an import it only uses when installed; Transformers refuses
        # remote code with missing imports, so that one is left out of the check.
        def imports(filename):
            return [name for name in get_imports(filename) if name != "flash_attn"]

        with patch("transformers.dynamic_module_utils.get_imports", imports):
            self.model = AutoModelForCausalLM.from_pretrained(
                FLORENCE_REPO, revision=FLORENCE_REVISION, trust_remote_code=True,
                torch_dtype=dtype, attn_implementation="eager",
            ).to(self.device).eval()
            self.processor = AutoProcessor.from_pretrained(FLORENCE_REPO, revision=FLORENCE_REVISION, trust_remote_code=True)

    def boxes(self, image, prompt):
        import torch
        inputs = self.processor(text=DETECTION_TASK + prompt, images=image, return_tensors="pt")
        inputs = {key: value.to(self.device).to(self.model.dtype) if value.is_floating_point() else value.to(self.device)
                  for key, value in inputs.items()}
        with torch.inference_mode():
            ids = self.model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                                      max_new_tokens=1024, do_sample=False, num_beams=3)
        text = self.processor.batch_decode(ids, skip_special_tokens=False)[0]
        parsed = self.processor.post_process_generation(text, task=DETECTION_TASK, image_size=image.size)
        return parsed.get(DETECTION_TASK, {}).get("bboxes", [])

    def mask(self, input_path, options):
        """A mask of every accepted box, and how many boxes were found and accepted."""
        image = read_rgba(input_path).convert("RGB")
        prompts = checked_prompts(options.get("prompts"))
        limit = number(options.get("maxPercent", 10), 1, 100, "Largest watermark size")
        boxes = [box for prompt in prompts for box in self.boxes(image, prompt)]
        accepted = accepted_boxes(boxes, image.width, image.height, limit)
        return box_mask(accepted, image.width, image.height), len(boxes), len(accepted)


def checked_prompts(prompts):
    if prompts is None:
        return DEFAULT_PROMPTS
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= 8:
        raise ValueError("Give between 1 and 8 things to look for.")
    cleaned = [str(prompt).strip() for prompt in prompts]
    if any(not prompt or len(prompt) > 100 for prompt in cleaned):
        raise ValueError("Each thing to look for needs 1 to 100 characters.")
    return list(dict.fromkeys(cleaned))


def accepted_boxes(boxes, width, height, max_percent):
    """Boxes inside the picture that cover at most max_percent of it; larger ones are usually the subject."""
    accepted = []
    for box in boxes:
        left, top, right, bottom = (max(0, min(limit, value)) for value, limit in zip(box, (width, height, width, height)))
        if right - left < 1 or bottom - top < 1:
            continue
        if (right - left) * (bottom - top) / (width * height) * 100 <= max_percent:
            accepted.append((left, top, right, bottom))
    return accepted


def box_mask(boxes, width, height):
    """The boxes filled, each grown by the margin smart selections get, since detection hugs the glyphs."""
    from advanced import select_margin
    margin = select_margin(width, height)
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for left, top, right, bottom in boxes:
        draw.rectangle([max(0, left - margin), max(0, top - margin), min(width - 1, right + margin), min(height - 1, bottom + margin)], fill=255)
    return mask
