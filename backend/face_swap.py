# SPDX-License-Identifier: AGPL-3.0-only
# Adapted from a local ONNX proof of concept based on Deep-Live-Cam.
# Upstream: https://github.com/hacksider/Deep-Live-Cam
# Credit: Deep-Live-Cam authors and contributors.
# Modified for Inpaint, 2026-09-09: persistent models, donor caching, target
# selection, face restoration, strength blending, color matching, and alpha.
# Copyright (c) 2026 Inpaint contributors, for the Inpaint modifications.
# See LICENSE and THIRD_PARTY_NOTICES.md for license terms and attribution.
"""Persistent InsightFace/INSwapper image editing."""

import hashlib
from pathlib import Path


class FaceSwap:
    def __init__(self, models_dir: Path):
        # Loading torch first exposes its CUDA/cuDNN libraries to ONNX Runtime.
        import torch
        import onnxruntime as ort
        import insightface
        from insightface.app import FaceAnalysis

        swapper_path = models_dir / "inswapper_128.onnx"
        analysis_dir = models_dir / "models" / "buffalo_l"
        required = [swapper_path, analysis_dir / "det_10g.onnx", analysis_dir / "w600k_r50.onnx"]
        if not all(path.is_file() for path in required):
            from downloads import face_models
            face_models(models_dir)

        use_cuda = torch.cuda.is_available() and "CUDAExecutionProvider" in ort.get_available_providers()
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_cuda else ["CPUExecutionProvider"]
        self.analyzer = FaceAnalysis(
            name="buffalo_l", root=str(models_dir),
            allowed_modules=["detection", "recognition"], providers=providers,
        )
        self.analyzer.prepare(ctx_id=0 if use_cuda else -1, det_size=(1280, 1280))
        self.swapper = insightface.model_zoo.get_model(str(swapper_path), providers=providers)
        if self.swapper is None:
            raise RuntimeError("The face-swap model could not be loaded.")
        self.donor_digest = None
        self.donor_face = None

    def largest_face(self, image, label):
        faces = self.analyzer.get(image)
        if not faces:
            raise ValueError(f"No face detected in {label}. Choose a photo with a clear, visible face.")
        return max(faces, key=lambda face: max(0, face.bbox[2] - face.bbox[0]) * max(0, face.bbox[3] - face.bbox[1]))

    def detect(self, input_path):
        import cv2
        import numpy as np
        from editing import read_rgba
        image = read_rgba(input_path)
        faces = self.analyzer.get(cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR))
        return [{"id": index, "box": [float(face.bbox[0] / image.width),
                    float(face.bbox[1] / image.height), float((face.bbox[2] - face.bbox[0]) / image.width),
                    float((face.bbox[3] - face.bbox[1]) / image.height)]}
                for index, face in enumerate(sorted(faces, key=lambda face: float(face.bbox[0])))]

    def selected_face(self, image, point):
        if point is None:
            return self.largest_face(image, "the current picture")
        from editing import number
        if len(point) != 2:
            raise ValueError("Invalid face selection.")
        x = number(point[0], 0, 1, "Face position") * image.shape[1]
        y = number(point[1], 0, 1, "Face position") * image.shape[0]
        faces = [face for face in self.analyzer.get(image)
                 if face.bbox[0] <= x <= face.bbox[2] and face.bbox[1] <= y <= face.bbox[3]]
        if not faces:
            raise ValueError("The selected face is no longer at that position. Detect faces again.")
        return min(faces, key=lambda face: (x - (face.bbox[0] + face.bbox[2]) / 2) ** 2
                   + (y - (face.bbox[1] + face.bbox[3]) / 2) ** 2)

    @staticmethod
    def restore_face(swapped, target_face, restorer):
        """Restore only the selected face, using its existing landmarks and a soft face mask."""
        import numpy as np
        import torch
        from iopaint.plugins.basicsr.img_util import img2tensor, tensor2img

        if restorer is None:
            raise RuntimeError("GFPGAN is required to finish face replacement.")
        landmarks = np.asarray(target_face.kps, dtype=np.float32)
        if landmarks.shape != (5, 2) or not np.isfinite(landmarks).all():
            raise RuntimeError("Could not align the replaced face for restoration.")
        enhancer = restorer.face_enhancer
        helper = enhancer.face_helper
        helper.clean_all()
        try:
            with torch.inference_mode():
                helper.read_image(swapped)
                # Do not detect faces again: only the face selected for swapping is restored.
                helper.all_landmarks_5 = [landmarks]
                helper.align_warp_face()
                crop = helper.cropped_faces[0]
                tensor = img2tensor(crop / 255.0, bgr2rgb=True, float32=True)
                tensor = ((tensor - 0.5) / 0.5).unsqueeze(0).to(enhancer.device)
                # Call the network directly so inference failures abort the edit instead
                # of GFPGAN's convenience wrapper silently returning the blurry crop.
                output = enhancer.gfpgan(tensor, return_rgb=False, weight=0.5)[0]
                restored = tensor2img(output.squeeze(0), rgb2bgr=True, min_max=(-1, 1))
                helper.add_restored_face(restored)
                helper.get_inverse_affine(None)
                return helper.paste_faces_to_input_image()
        finally:
            helper.clean_all()
            helper.input_img = None

    @staticmethod
    def match_color(image, target, face, amount):
        import cv2
        import numpy as np
        if amount <= 0:
            return image
        h, w = image.shape[:2]
        x1, y1, x2, y2 = np.asarray(face.bbox, dtype=int)
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        if x2 <= x1 or y2 <= y1:
            return image
        roi = image[y1:y2, x1:x2]
        original = target[y1:y2, x1:x2]
        height, width = roi.shape[:2]
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.ellipse(mask, (width // 2, height // 2), (max(1, int(width * .38)), max(1, int(height * .42))), 0, 0, 360, 255, -1)
        source_lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB).astype(np.float32)
        target_lab = cv2.cvtColor(original, cv2.COLOR_BGR2LAB).astype(np.float32)
        selected = mask > 0
        for channel in range(3):
            a, b = source_lab[:, :, channel][selected], target_lab[:, :, channel][selected]
            ratio = np.clip(b.std() / max(a.std(), 1), .7, 1.4)
            source_lab[:, :, channel] = (source_lab[:, :, channel] - a.mean()) * ratio + b.mean()
        corrected = cv2.cvtColor(np.clip(source_lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
        soft = cv2.GaussianBlur(mask.astype(np.float32) / 255, (0, 0), max(1, width * .08))[:, :, None] * amount
        output = image.copy()
        output[y1:y2, x1:x2] = np.rint(roi * (1 - soft) + corrected * soft).astype(np.uint8)
        return output

    def replace(self, input_path: Path, donor_path: Path, output_path: Path, restorer,
                strength=1.0, target_point=None, raw_output=None, color_match=0):
        import cv2
        import numpy as np
        from PIL import Image, ImageOps

        digest = hashlib.sha256(donor_path.read_bytes()).digest()
        if digest != self.donor_digest:
            with Image.open(donor_path) as image:
                donor = ImageOps.exif_transpose(image).convert("RGB")
            donor_bgr = cv2.cvtColor(np.array(donor), cv2.COLOR_RGB2BGR)
            face = self.largest_face(donor_bgr, "the selected source photo")
            if getattr(face, "normed_embedding", None) is None:
                raise RuntimeError("Could not extract the face from the selected source photo.")
            self.donor_face = face
            self.donor_digest = digest

        with Image.open(input_path) as image:
            target = ImageOps.exif_transpose(image).convert("RGBA")
        target_bgr = cv2.cvtColor(np.array(target.convert("RGB")), cv2.COLOR_RGB2BGR)
        from editing import number
        strength = number(strength, 0, 1, "Restoration strength")
        color_match = number(color_match, 0, 1, "Color matching")
        target_face = self.selected_face(target_bgr, target_point)
        swapped = self.swapper.get(target_bgr, target_face, self.donor_face, paste_back=True)
        if swapped.shape != target_bgr.shape:
            raise RuntimeError("Face replacement returned an unexpected image size.")
        raw = swapped
        restored = self.restore_face(swapped, target_face, restorer)
        raw = self.match_color(raw, target_bgr, target_face, color_match)
        restored = self.match_color(restored, target_bgr, target_face, color_match)
        swapped = np.rint(raw.astype(np.float32) * (1 - strength) + restored.astype(np.float32) * strength).astype(np.uint8)
        result = Image.fromarray(cv2.cvtColor(swapped, cv2.COLOR_BGR2RGB))
        result.putalpha(target.getchannel("A"))
        result.save(output_path, format="PNG", optimize=True)
        if raw_output is not None:
            raw_image = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB))
            raw_image.putalpha(target.getchannel("A"))
            raw_image.save(raw_output, "PNG")
