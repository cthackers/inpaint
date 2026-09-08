# Third-party software and models

Inpaint is distributed under [AGPL-3.0-only](LICENSE). It uses software and
model weights from other projects, whose own licenses and notices continue to
apply. Model weights download separately and are not included in the repository
or desktop executable.

## Face-swap code provenance

`backend/face_swap.py` was adapted from a local ONNX proof of concept based on
an older version of [Deep-Live-Cam](https://github.com/hacksider/Deep-Live-Cam).
Credit belongs to the Deep-Live-Cam authors and contributors for that upstream
work. Its [AGPL-3.0 license](https://github.com/hacksider/Deep-Live-Cam/blob/main/LICENSE)
is reproduced in [LICENSE](LICENSE).

Inpaint's adaptation adds persistent model loading, source-face caching,
target-face selection, face-only GFPGAN restoration, adjustable restoration
strength, color matching, and transparency preservation. The adaptation is
marked in the source header, with a modification date of 2026-09-09.
Inpaint is distributed as a whole under AGPL-3.0-only. The InsightFace library
and downloaded model weights retain their separate terms below.

## Included resources

| Component | Included material | License and attribution |
| --- | --- | --- |
| [uv](https://github.com/astral-sh/uv) | Compressed runtime installer in `resources/uv.gz` | MIT option, Copyright Astral Software Inc. See [uv-LICENSE-MIT](resources/uv-LICENSE-MIT). |
| [InsightFace 0.7.3](https://pypi.org/project/insightface/0.7.3/) | Python wheel in `resources/` | MIT, Copyright 2022 Jiankang Deng and Jia Guo. See [InsightFace-LICENSE](resources/InsightFace-LICENSE). This covers the software, not the pretrained models. |
| [Restormer](https://github.com/swz30/Restormer) | Adapted architecture in `backend/restormer_arch.py` | MIT, Copyright 2022 Syed Waqas Zamir and contributors. See [Restormer-LICENSE](resources/Restormer-LICENSE). Changes are described in the source header and [resource notes](resources/README.md). |

## Main software dependencies

| Dependency | Upstream license |
| --- | --- |
| [Tauri and its dialog plugin](https://github.com/tauri-apps/tauri#licenses) | MIT or Apache-2.0 |
| [React](https://github.com/facebook/react/blob/main/LICENSE) | MIT |
| [Lucide](https://github.com/lucide-icons/lucide/blob/main/LICENSE) | ISC, with retained MIT notices for Feather-derived icons |
| [IOPaint](https://github.com/Sanster/IOPaint/blob/main/LICENSE) | Apache-2.0; its model integrations also depend on the original model terms below |
| [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting/blob/main/LICENSE) | Apache-2.0 |
| [PyTorch](https://github.com/pytorch/pytorch/blob/main/LICENSE) | BSD-style, with additional third-party notices |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) | MIT |
| [rembg](https://github.com/danielgatis/rembg/blob/main/LICENSE.txt) | MIT |
| [Spandrel](https://github.com/chaiNNer-org/spandrel/blob/main/LICENSE) | MIT; included architectures retain their own notices |

This is an overview, not a complete list of transitive dependencies. Preserve
the license and copyright files supplied by installed packages. AppImage
desktop libraries and optional NVIDIA runtime packages also have their own
redistribution terms. A source-code license alone does not establish compliance
for a binary release.

## Model terms

**Some tools are restricted to non-commercial use or research.** Downloading a
model automatically does not waive its terms, and receiving a Hugging Face
access token does not grant commercial permission.

| Tool or model | Upstream terms |
| --- | --- |
| InsightFace `buffalo_l` and `inswapper_128.onnx` | The [InsightFace model policy](https://github.com/deepinsight/insightface#license) restricts public pretrained models to non-commercial research. Contact InsightFace for other licensing, including commercial use. The code's MIT license does not cover these weights. |
| BRIA RMBG 1.4 | [BRIA's model card and license](https://huggingface.co/briaai/RMBG-1.4) permit non-commercial use; commercial use needs an agreement with BRIA. No-login access is not unrestricted use. |
| BRIA RMBG 2.0 | The [model card](https://huggingface.co/briaai/RMBG-2.0) lists CC BY-NC 4.0 and requires a separate agreement for commercial use. Access approval is also required to download it. |
| MAT | The [upstream project license](https://github.com/fenglinglwb/MAT/blob/main/LICENSE) is CC BY-NC 4.0. Its non-commercial terms are not replaced by IOPaint's Apache license. |
| SDXL Inpainting | The [inpainting model](https://huggingface.co/diffusers/stable-diffusion-xl-1.0-inpainting-0.1) uses CreativeML Open RAIL++-M, which includes use restrictions. |
| SDXL VAE FP16 fix | The [VAE model card](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix) lists MIT. This does not change the separate inpainting model's license. |
| LaMa | [Upstream project](https://github.com/advimman/lama) under Apache-2.0; the app downloads a checkpoint distributed by [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting). |
| ZITS | [Upstream project](https://github.com/DQiaole/ZITS_inpainting) under Apache-2.0; checkpoints are distributed through IOPaint's model releases. |
| MI-GAN | [Upstream project](https://github.com/Picsart-AI-Research/MI-GAN) under MIT; the app uses IOPaint's traced checkpoint. |
| GFPGAN | [Upstream project](https://github.com/TencentARC/GFPGAN#scroll-license-and-acknowledgement) under Apache-2.0, with its supporting face-detection and parsing components. |
| Real-ESRGAN | [Upstream project license](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE) is BSD-3-Clause. |
| HAT | [Upstream project license](https://github.com/XPixelGroup/HAT/blob/main/LICENSE) is Apache-2.0. |
| Restormer | [Upstream project license](https://github.com/swz30/Restormer/blob/main/LICENSE.md) is MIT; checkpoints come from its v1.0 release. |
| MobileSAM | [Upstream project license](https://github.com/ChaoningZhang/MobileSAM/blob/master/LICENSE) is Apache-2.0. |
| U²-Net | [Upstream project license](https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE) is Apache-2.0; models are downloaded through rembg. |

Project license entries identify the upstream software license. They are not
a blanket clearance of every checkpoint, training dataset, supporting model,
or use of generated images. Check the terms supplied with the specific weights
before commercial use or redistribution. Keep model weights out of release
archives unless their redistribution terms have been checked.

## Screenshot photos

The README screenshots contain third-party photos, including NASA portraits.
Their credits and reuse terms are in [the screenshot notes](docs/screenshots/README.md#photo-credits).
They are not relicensed as Inpaint source code.
