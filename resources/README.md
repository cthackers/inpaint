Runtime bootstrap: uv 0.12.11, official x86_64 Linux build, embedded compressed. Archive SHA256: 4ae93e0f148a18434cc094072547cec88912fc4a72b984183c7d0d0e9586cb5e.
InsightFace 0.7.3 CPython 3.11 wheel built locally from the upstream source distribution (MIT). Model weights are downloaded separately.
The wheel's software license is in `InsightFace-LICENSE`, copied from the
[upstream v0.7 release](https://github.com/deepinsight/insightface/blob/v0.7/LICENSE).

## Restormer

`backend/restormer_arch.py` embeds the architecture from
https://github.com/swz30/Restormer/blob/main/basicsr/models/archs/restormer_arch.py
(downloaded 2026-09-09; upstream file SHA-256
`3be243fa3c8e2cb2c9459eeac062b04d6084dbcc328292dae1c3e52ba6f7434a`).
The MIT copyright and license are included in its header and in
`resources/Restormer-LICENSE`. Local changes remove the unused debugger import
and replace einops reshapes with equivalent PyTorch tensor operations.

Weights are downloaded on demand from the author's v1.0 release:
https://github.com/swz30/Restormer/releases/tag/v1.0
The app uses the motion deblurring, single-image defocus deblurring, and real
image denoising checkpoints. Dual-pixel/grayscale models are not used.

## Watermark detection

`backend/watermark.py` follows the approach of
[WatermarkRemover-AI](https://github.com/D-Ogi/WatermarkRemover-AI) (MIT, © 2025 D-Ogi): Florence-2
open-vocabulary detection boxes for text prompts become an inpainting mask. No code is bundled from it.
Florence-2 is downloaded on first use from
[microsoft/Florence-2-large](https://huggingface.co/microsoft/Florence-2-large) (MIT) at the pinned revision
`21a599d414c4d928c9032694c424fb94458e3594`; its model code comes with the weights and runs with
`trust_remote_code`.

## Photo upscalers

The Upscale tool's DAT2 and ATD options download, on first use, `4xRealWebPhoto_v4_dat2` and
`4xNomos2_hq_atd` by Philip Hofmann ([Phhofm/models](https://github.com/Phhofm/models), CC-BY-4.0), pinned by
SHA-256 in `backend/upscale.py`. They load through spandrel (DAT, MIT; ATD, Apache-2.0 architectures).
