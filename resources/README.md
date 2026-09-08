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
