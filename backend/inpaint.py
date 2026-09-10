#!/usr/bin/env python3
"""Persistent multi-model worker (and one-shot runner) for the desktop app."""

import os
from pathlib import Path
import sys
import gc
import json
import math
import traceback


SDXL_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
LAMA_MODEL_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"
ERASE_MODELS = {"mat", "zits", "migan"}
PLUGIN_NAMES = {"restore", "gfpgan", "realesrgan", "remove_bg", "face_swap", "hat", "lanczos"}


def configure_cache(models_dir: Path) -> None:
    """Keep every runtime cache inside the project model directory."""
    models_dir.mkdir(parents=True, exist_ok=True)
    torch_home = models_dir / "torch"
    hf_home = models_dir / "huggingface"
    torch_home.mkdir(parents=True, exist_ok=True)
    hf_home.mkdir(parents=True, exist_ok=True)
    os.environ["XDG_CACHE_HOME"] = str(models_dir)
    os.environ["TORCH_HOME"] = str(torch_home)
    os.environ["HF_HOME"] = str(hf_home)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hf_home / "hub")
    os.environ["MPLCONFIGDIR"] = str(models_dir / "matplotlib")
    os.environ["LAMA_MODEL"] = str(models_dir / "lama" / "big-lama.pt")


def load_model(model_name: str):
    from downloads import progress
    progress(f"Preparing {model_name}", None, "Loading cached weights or downloading on first use")
    if model_name == "lama":
        import torch
        from simple_lama_inpainting import SimpleLama

        model_path = Path(os.environ["LAMA_MODEL"])
        if not model_path.is_file():
            model_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = model_path.with_suffix(".download")
            try:
                torch.hub.download_url_to_file(
                    LAMA_MODEL_URL, str(temporary_path), progress=True
                )
                temporary_path.replace(model_path)
            finally:
                temporary_path.unlink(missing_ok=True)
        return SimpleLama()

    import torch
    from iopaint.model_manager import ModelManager

    runtime_name = ensure_iopaint_model(model_name)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return ModelManager(name=runtime_name, device=device)


def release_memory() -> None:
    """Release allocator memory after callers drop their model references."""
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def run_lama(model, source, mask):
    original_size = source.size
    result = model(source, mask)
    # The TorchScript network pads to a multiple of eight. Never allow that
    # implementation detail to alter the user's image dimensions.
    return result.crop((0, 0, original_size[0], original_size[1]))


def ensure_iopaint_model(name: str) -> str:
    from iopaint.download import cli_download_model, scan_models

    runtime_name = SDXL_MODEL if name == "sdxl" else name
    if runtime_name not in {model.name for model in scan_models()}:
        cli_download_model(runtime_name)
    return runtime_name


def run_iopaint(model, source, mask, prompt):
    import cv2
    import numpy as np
    from iopaint.schema import HDStrategy, InpaintRequest

    config = InpaintRequest(
        hd_strategy=HDStrategy.CROP,
        hd_strategy_crop_trigger_size=1024,
        hd_strategy_crop_margin=192,
        prompt=prompt or "clean natural background, seamless continuation of the surrounding scene",
        negative_prompt="object, person, artifact, distortion, blur, watermark, text",
        sd_steps=30,
        sd_guidance_scale=7.0,
        sd_keep_unmasked_area=True,
        sd_match_histograms=True,
    )
    # np.asarray(PIL.Image) may return a read-only view. Some IOPaint models
    # normalize or reshape their inputs in place, which then fails with
    # "assignment destination is read-only" depending on the selected model.
    source_array = np.array(source.convert("RGB"), dtype=np.uint8, copy=True, order="C")
    mask_array = np.array(mask.convert("L"), dtype=np.uint8, copy=True, order="C")
    result_bgr = model(source_array, mask_array, config)
    result_rgb = cv2.cvtColor(result_bgr, cv2.COLOR_BGR2RGB)
    from PIL import Image

    return Image.fromarray(result_rgb).crop((0, 0, source.width, source.height))


def process_image(model_name, loaded_model, input_path, mask_path, output_path, prompt):
    from PIL import Image

    source = Image.open(input_path).convert("RGBA")
    mask = Image.open(mask_path).convert("L")
    if mask.size != source.size:
        mask = mask.resize(source.size, Image.Resampling.NEAREST)

    if model_name == "lama":
        result = run_lama(loaded_model, source.convert("RGB"), mask)
    else:
        result = run_iopaint(loaded_model, source.convert("RGB"), mask, prompt)
    result = Image.composite(result.convert("RGB"), source.convert("RGB"), mask)
    result.putalpha(source.getchannel("A"))
    result.save(output_path, format="PNG", optimize=True)


def load_plugin(plugin_name: str, option: str):
    from downloads import progress
    progress(f"Preparing {plugin_name}", None, "Loading cached weights or downloading on first use")
    if plugin_name == "restore":
        from restore import DetailRestorer
        cache = Path(os.environ["XDG_CACHE_HOME"])
        return DetailRestorer(cache / "restore", Path(os.environ["TORCH_HOME"]) / "hub/checkpoints", cache / "restormer"), "restore"
    if plugin_name in {"hat", "lanczos"}:
        from upscale import HatUpscaler, LanczosUpscaler
        if plugin_name == "lanczos":
            return LanczosUpscaler(), "lanczos"
        return HatUpscaler(Path(os.environ["TORCH_HOME"]) / "hub/checkpoints"), "hat"

    if plugin_name == "face_swap":
        try:
            from face_swap import FaceSwap
            return FaceSwap(Path(os.environ["XDG_CACHE_HOME"]) / "faceswap"), "face_swap"
        except ImportError as error:
            raise RuntimeError("Face-swap dependencies are missing. Run scripts/setup-face-swap.sh.") from error

    import torch
    from iopaint.schema import Device, RealESRGANModel, RemoveBGModel

    device = Device.cuda if torch.cuda.is_available() else Device.cpu
    if plugin_name == "gfpgan":
        from iopaint.plugins.gfpgan_plugin import GFPGANPlugin

        return GFPGANPlugin(device), "gfpgan"
    if plugin_name == "realesrgan":
        if option == "realesr-general-x4v3":
            from upscale import GeneralUpscaler
            return GeneralUpscaler(Path(os.environ["TORCH_HOME"]) / "hub/checkpoints", device), f"realesrgan:{option}"
        from iopaint.plugins.realesrgan import RealESRGANUpscaler

        model = RealESRGANModel(option)
        return RealESRGANUpscaler(model, device), f"realesrgan:{option}"
    if plugin_name == "remove_bg":
        try:
            import rembg
        except ImportError as error:
            raise RuntimeError(
                "Background removal dependencies are missing. Run scripts/setup-model.sh again."
            ) from error
        from iopaint.plugins.remove_bg import RemoveBG

        model = RemoveBGModel(option)
        if option.startswith("briaai/"):
            try:
                return RemoveBG(model, device), f"remove_bg:{option}"
            except Exception as error:
                if "gated" in str(error).lower() or "401" in str(error) or "403" in str(error):
                    raise RuntimeError("BRIA 2.0 requires approved Hugging Face access. Open its access page and save your read token in the background-removal panel, or choose BRIA 1.4 / U²-Net without login.") from error
                raise

        class CpuRemoveBG(RemoveBG):
            def _init_session(self, model_name):
                # U2Net keeps using CPU even with the shared CUDA runtime installed.
                # rembg otherwise tries every provider, including uninstalled TensorRT.
                self.session = rembg.new_session(model_name, providers=["CPUExecutionProvider"])
                self.remove = lambda _device, *args, **kwargs: rembg.remove(*args, **kwargs)

        return CpuRemoveBG(model, Device.cpu), f"remove_bg:{option}"
    raise ValueError(f"unsupported plugin: {plugin_name}")


def process_plugin(plugin_name, plugin, input_path, output_path, scale, donor_path=None, denoise=0.25, face_restorer=None, strength=1.0, option=""):
    if plugin_name == "restore":
        plugin.restore(input_path, output_path, option, strength)
        return
    if plugin_name in {"hat", "lanczos"}:
        plugin.upscale(input_path, output_path, scale)
        return
    if plugin_name == "realesrgan" and hasattr(plugin, "set_denoise"):
        plugin.set_denoise(denoise)
    if plugin_name == "face_swap":
        if donor_path is None:
            raise ValueError("Select a source photo before replacing a face.")
        plugin.replace(input_path, donor_path, output_path, face_restorer)
        return

    import cv2
    import numpy as np
    from PIL import Image
    from iopaint.schema import RunPluginRequest

    source = Image.open(input_path)
    source_rgb = source.convert("RGB")
    source_array = np.array(source_rgb, dtype=np.uint8, copy=True, order="C")
    request = RunPluginRequest(name=plugin_name, image="", scale=scale)
    output = plugin.gen_image(source_array, request)

    if output.ndim != 3 or output.shape[2] not in (3, 4):
        raise RuntimeError(f"Plugin returned an unsupported image shape: {output.shape}")
    if output.shape[2] == 4:
        result = Image.fromarray(output.astype(np.uint8), mode="RGBA")
    else:
        result_rgb = cv2.cvtColor(output.astype(np.uint8), cv2.COLOR_BGR2RGB)
        result = Image.fromarray(result_rgb)
        if "A" in source.getbands():
            alpha = source.getchannel("A").resize(result.size, Image.Resampling.LANCZOS)
            result.putalpha(alpha)
    result.save(output_path, format="PNG", optimize=True)


def worker_main(models_dir: Path) -> None:
    from worker_protocol import configure_worker_output, emit, set_request_id
    configure_worker_output()
    configure_cache(models_dir.resolve())
    from downloads import install_hooks, progress
    install_hooks()
    models = {}
    plugins = {}

    def respond(message):
        message["models"] = list(models)
        message["plugins"] = list(plugins)
        emit(message)

    emit({"ready": True})

    for line in sys.stdin:
        set_request_id(None)
        try:
            request = json.loads(line)
            set_request_id(request.get("request_id"))
            if request.get("command") == "shutdown":
                break

            command = request.get("command")
            if command in {"memory", "unload"}:
                if command == "unload":
                    options = request.get("options", {})
                    cache = models if options.get("kind") == "model" else plugins
                    if options.get("key") == "all":
                        models.clear()
                        plugins.clear()
                    else:
                        cache.pop(options.get("key"), None)
                    release_memory()
                memory = {}
                try:
                    import psutil
                    memory["ram"] = psutil.Process().memory_info().rss
                except ImportError:
                    pass
                if "torch" in sys.modules:
                    import torch
                    if torch.cuda.is_available():
                        memory["vram"] = torch.cuda.memory_allocated()
                        memory["reserved"] = torch.cuda.memory_reserved()
                respond({"ok": True, "memory": memory})
                continue

            if command in {"detect_faces", "face_preview"}:
                options = request.get("options", {})
                if command == "face_preview" and not options.get("donor"):
                    raise ValueError("Select a source photo first.")
                if "face_swap" not in plugins:
                    plugins["face_swap"] = load_plugin("face_swap", "")[0]
                if command == "detect_faces":
                    respond({"ok": True, "faces": plugins["face_swap"].detect(Path(request["input"]))})
                else:
                    if "gfpgan" not in plugins:
                        plugins["gfpgan"] = load_plugin("gfpgan", "gfpgan")[0]
                    plugins["face_swap"].replace(Path(request["input"]), Path(options["donor"]),
                        Path(request["output"]), plugins["gfpgan"], strength=options.get("strength", 1),
                        target_point=options.get("target"), raw_output=Path(request["raw_output"]), color_match=options.get("colorMatch", 0))
                    respond({"ok": True})
                continue

            if command in {"select", "mask_edit", "retouch", "refine_edges"}:
                from advanced import SmartSelection, mask_edit, retouch, refine_edges
                if command == "select":
                    if "smart_selection" not in plugins:
                        progress("Preparing smart selection", None, "Downloading MobileSAM on first use")
                        plugins["smart_selection"] = SmartSelection()
                    plugins["smart_selection"].select(Path(request["input"]), Path(request["output"]), request["options"])
                else:
                    {"mask_edit": mask_edit, "retouch": retouch, "refine_edges": refine_edges}[command](request["input"], request["output"], request["options"])
                respond({"ok": True})
                continue

            if command == "outpaint":
                from PIL import Image
                import numpy as np
                from editing import read_rgba, number
                options = request["options"]
                source = read_rgba(request["input"])
                margins = [round(number(options.get(side, 0), 0, 4096, side)) for side in ["left", "top", "right", "bottom"]]
                left, top, right, bottom = margins
                width, height = source.width + left + right, source.height + top + bottom
                if not any(margins) or width * height > 64_000_000:
                    raise ValueError("Extend at least one edge; the output limit is 64 megapixels.")
                name = options.get("model", "sdxl")
                if name not in {"lama", "mat", "zits", "migan", "sdxl"}:
                    raise ValueError("Unsupported outpainting model.")
                if name not in models:
                    models[name] = load_model(name)
                expanded = Image.fromarray(np.pad(np.array(source.convert("RGB")), ((top, bottom), (left, right), (0, 0)), mode="edge"))
                mask = Image.new("L", (width, height), 255)
                mask.paste(0, (left, top, left + source.width, top + source.height))
                progress("Extending image", None, "Generating the new canvas area")
                result = run_lama(models[name], expanded, mask) if name == "lama" else run_iopaint(models[name], expanded, mask, options.get("prompt", ""))
                result = result.convert("RGBA")
                result.paste(source, (left, top))
                result.save(request["output"], "PNG")
                respond({"ok": True})
                continue

            if command in {"edit", "export"}:
                from editing import edit_image, export_image
                if command == "edit":
                    edit_image(request["input"], request["output"], request["options"], request.get("reference"))
                    respond({"ok": True})
                else:
                    respond({"ok": True, **export_image(request["input"], request["options"])})
                continue

            if request.get("command") == "plugin":
                plugin_name = request["plugin"]
                option = request.get("option", "")
                if plugin_name not in PLUGIN_NAMES:
                    raise ValueError(f"unsupported plugin: {plugin_name}")
                denoise = float(request.get("denoise", 0.25))
                if not math.isfinite(denoise) or not 0 <= denoise <= 1:
                    raise ValueError("Denoising strength must be between 0 and 1.")
                donor_path = None
                if plugin_name == "face_swap":
                    if not request.get("donor"):
                        raise ValueError("Select a source photo before replacing a face.")
                    donor_path = Path(request["donor"])
                requested_plugin_name = (
                    plugin_name if plugin_name in {"gfpgan", "face_swap", "hat", "lanczos", "restore"} else f"{plugin_name}:{option}"
                )
                if requested_plugin_name not in plugins:
                    plugins[requested_plugin_name] = load_plugin(plugin_name, option)[0]
                if plugin_name == "face_swap" and "gfpgan" not in plugins:
                    plugins["gfpgan"] = load_plugin("gfpgan", "gfpgan")[0]
                process_plugin(
                    plugin_name,
                    plugins[requested_plugin_name],
                    Path(request["input"]),
                    Path(request["output"]),
                    float(request.get("scale", 2.0)),
                    donor_path,
                    denoise=denoise,
                    strength=float(request.get("strength", 1.0)),
                    option=option,
                    face_restorer=plugins.get("gfpgan") if plugin_name == "face_swap" else None,
                )
                respond({"ok": True, "plugin": requested_plugin_name})
                continue

            model_name = request["model"]
            if model_name not in {"lama", "mat", "zits", "migan", "sdxl"}:
                raise ValueError(f"unsupported model: {model_name}")

            if model_name not in models:
                models[model_name] = load_model(model_name)

            process_image(
                model_name,
                models[model_name],
                Path(request["input"]),
                Path(request["mask"]),
                Path(request["output"]),
                request.get("prompt", ""),
            )
            respond({"ok": True, "model": model_name})
        except Exception as error:
            respond({
                "ok": False,
                "error": str(error),
                "detail": traceback.format_exc(limit=4),
            })

    models.clear()
    plugins.clear()
    release_memory()


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        worker_main(Path(sys.argv[2]))
        return

    if len(sys.argv) != 7:
        raise SystemExit("usage: inpaint.py INPUT MASK OUTPUT MODEL MODELS_DIR PROMPT")

    try:
        from PIL import Image
    except ImportError as error:
        raise SystemExit(
            "Model dependencies are missing. Run scripts/setup-model.sh, then restart the app."
        ) from error

    input_path, mask_path, output_path = map(Path, sys.argv[1:4])
    model_name = sys.argv[4]
    models_dir = Path(sys.argv[5]).resolve()
    prompt = sys.argv[6]
    if model_name not in {"lama", "mat", "zits", "migan", "sdxl"}:
        raise SystemExit(f"unsupported model: {model_name}")

    configure_cache(models_dir)
    model = load_model(model_name)
    try:
        process_image(model_name, model, input_path, mask_path, output_path, prompt)
    finally:
        del model
        release_memory()


if __name__ == "__main__":
    main()
