# Inpaint

A Linux desktop image editor with local AI object removal, face replacement,
restoration, upscaling, and background tools. Open a folder, double-click an
image, and combine edits without reloading models between operations.

Inpaint supports PNG, JPEG, and WebP files. Processing stays on your computer;
the application only uses the network to install dependencies and download
model weights.

> [!WARNING]
> Saving overwrites the original image. The application does not create a
> backup, so keep a copy of anything you cannot replace.

## Features

- Folder tree and a responsive thumbnail gallery for large photo collections.
- Mask painting with adjustable brush size, zoom, and pan.
- Five selectable inpainting models for different kinds of repair.
- GFPGAN face restoration, HAT/RealESRGAN upscaling, Lanczos resizing, and background removal tools.
- Restormer detail restoration for defocus blur, motion blur, and noise without upscaling.
- Face replacement using a selected source photo, with a persistent InsightFace/INSwapper model.
- Smart selection, clone/healing brushes, live color adjustments, crop/straighten, and canvas outpainting.
- Background replacement with a color, another image, or a blurred background, plus cutout edge refinement.
- Automatic removal after a Shift+paint stroke, or manual removal with Space.
- Image and mask undo/redo.
- Horizontal/vertical image flips and 90° left/right rotations from the top toolbar, with undo/redo.
- Keyboard navigation between images.
- Current output resolution and actual display zoom beside the filename.
- Model weights stored together in the app's data directory.
- A persistent worker that keeps all used models loaded between edits and tool switches.
- Reusable workflows, batch queues, export copies, and a visual edit history.
- Collapsible tool sections, remembered settings, and an in-app keyboard shortcut guide.

## Screenshots

Real captures from the desktop application. Click an image to view it at full
size; expand the sections below to explore the tools. Demo photo credits and
capture notes are in [docs/screenshots](docs/screenshots/README.md).

### Object removal

Paint over the unwanted object, then press **Space**. This example removes the
spoon with LaMa while keeping the image at 600 × 400 pixels.

You can also hold Shift and draw and the removal will happen as soon as you release the mouse.

| Paint the mask | Apply inpainting |
| --- | --- |
| [![Coffee photo with the spoon masked for removal](docs/screenshots/object-mask.webp)](docs/screenshots/object-mask.webp) | [![Coffee photo after removing the spoon with LaMa](docs/screenshots/object-result.webp)](docs/screenshots/object-result.webp) |

### Face replacement

Select a source photo and press **Replace**. The selected face is replaced and
restored with GFPGAN. This is an **altered demonstration image**, combining
NASA portraits of Neil Armstrong and Eileen Collins.

[![Face replacement completed, with the source-photo picker and color-matching controls](docs/screenshots/face-result.webp)](docs/screenshots/face-result.webp)

<details>
<summary><strong>Upscaling and before/after comparison</strong></summary>

Real-HAT enlarges this image from 451 × 300 to 902 × 600 pixels. The comparison
slider shows the previous image on the left and the edited image on the right,
aligned to the same frame.

| Upscale controls and result | Before/after slider |
| --- | --- |
| [![Real-HAT 2× upscale with updated output resolution](docs/screenshots/upscale.webp)](docs/screenshots/upscale.webp) | [![Original and upscaled cat image compared with a draggable divider](docs/screenshots/comparison.webp)](docs/screenshots/comparison.webp) |

</details>

<details>
<summary><strong>Face restoration and Restormer detail restoration</strong></summary>

GFPGAN restores faces; Restormer offers separate models for defocus blur, motion
blur, and noise. These captures show GFPGAN followed by Restormer's defocus
model, with the portrait remaining 512 × 512 pixels.

| GFPGAN | Restormer |
| --- | --- |
| [![GFPGAN face restoration completed](docs/screenshots/gfpgan.webp)](docs/screenshots/gfpgan.webp) | [![Restormer defocus restoration completed at the original resolution](docs/screenshots/restormer.webp)](docs/screenshots/restormer.webp) |

</details>

<details>
<summary><strong>Background removal, edge refinement, and replacement</strong></summary>

Remove the background to transparency, refine the cutout edges, and choose a
replacement. Shown here: a BRIA RMBG 1.4 cutout with its edge controls, followed
by a solid white background.

| Transparent cutout and edge controls | Replace the background |
| --- | --- |
| [![Transparent portrait with background-removal and edge-refinement controls](docs/screenshots/background-result.webp)](docs/screenshots/background-result.webp) | [![Portrait placed on a solid white background](docs/screenshots/background-replace.webp)](docs/screenshots/background-replace.webp) |

</details>

<details>
<summary><strong>Color, crop, and canvas extension</strong></summary>

Preview exposure, contrast, temperature, saturation, shadows, and highlights.
Choose a crop ratio and straighten the image, or configure extra canvas space
for outpainting. Flip and rotation controls sit in the top toolbar.

| Live color preview | Square crop preview |
| --- | --- |
| [![Live exposure, contrast, and saturation adjustments](docs/screenshots/color.webp)](docs/screenshots/color.webp) | [![Square crop selection with a 600 by 600 pixel output preview](docs/screenshots/crop.webp)](docs/screenshots/crop.webp) |

[![Canvas-extension settings with separate margins for each side](docs/screenshots/outpaint.webp)](docs/screenshots/outpaint.webp)

</details>

<details>
<summary><strong>Workflows, batch processing, and export</strong></summary>

Build a sequence from the current tool settings, save it as a workflow, and
queue multiple pictures. Export settings control format, quality, filename
suffix, and output dimensions. The batch capture shows two queued demo images.

| Build a workflow | Queue pictures |
| --- | --- |
| [![A Photo finish workflow combining color adjustments and Real-HAT upscaling](docs/screenshots/workflows.webp)](docs/screenshots/workflows.webp) | [![Two demo images queued with the Photo finish workflow](docs/screenshots/batch.webp)](docs/screenshots/batch.webp) |

[![Export settings for format, quality, filename suffix, and output dimensions](docs/screenshots/export.webp)](docs/screenshots/export.webp)

</details>

<details>
<summary><strong>Edit history and models in memory</strong></summary>

Return to a previous edit using its thumbnail. Used models stay loaded across
operations; the memory panel lists them and offers manual unloading.

| Visual history | Loaded models |
| --- | --- |
| [![History showing restoration, background removal, and background replacement](docs/screenshots/history.webp)](docs/screenshots/history.webp) | [![Memory panel showing LaMa, face swap, GFPGAN, Restormer, and background removal loaded together](docs/screenshots/memory.webp)](docs/screenshots/memory.webp) |

</details>

<details>
<summary><strong>Folder browsing and keyboard shortcuts</strong></summary>

Browse a folder's thumbnails and double-click to edit. The **?** overlay lists
navigation, painting, and action shortcuts; tool buttons also show their keys.

| Image gallery | Shortcut overlay |
| --- | --- |
| [![Folder tree and image thumbnail gallery](docs/screenshots/gallery.webp)](docs/screenshots/gallery.webp) | [![In-app keyboard shortcut overlay](docs/screenshots/shortcuts.webp)](docs/screenshots/shortcuts.webp) |

</details>

## Platform and hardware

The application currently supports Linux only.

### Portable deployment

`./build-portable.sh` (or `./build.sh --portable`) builds the desktop executable
and `inpaint-desktop.AppImage` at the project root. Use the AppImage for deployment:
it packages the Linux desktop libraries; the plain executable still needs those
libraries installed on the destination machine. This is an x86-64 Linux build;
the destination must meet the build system's glibc and graphics-driver requirements.
Building on an older supported Linux distribution gives wider compatibility.

On a fresh machine, the setup screen installs a private Python 3.11 runtime and
dependencies using the embedded uv installer. Choose NVIDIA/CUDA or CPU. Setup
shows progress and logs and can be retried after a failed download. The first
installation requires internet and several gigabytes of free disk space.

Installed runtime data goes into `$XDG_DATA_HOME/inpaint-desktop` (normally
`~/.local/share/inpaint-desktop`). The regular executable continues to use an
adjacent `.venv/` or `models/` directory when present. `INPAINT_PROJECT_DIR` can
override the data location.

Model weights download on first use, including the face-swap models and MobileSAM.
Downloads show progress and reuse weights already on disk. Some Hugging Face
models require approval from their publisher before downloading.

If the destination lacks FUSE, run the AppImage with `--appimage-extract-and-run`.
GPU drivers remain a host requirement and are not bundled.

An NVIDIA CUDA GPU is strongly recommended. The setup script installs the
CUDA 12.8 PyTorch wheels, so a recent compatible NVIDIA driver is required. A
separate system CUDA Toolkit installation is normally not necessary. The
models can fall back to the CPU, but most of them will be impractically slow.

GPU memory requirements vary by model and image. LaMa, MAT, ZITS, and MIGAN
are the lighter choices. SDXL is substantially larger and benefits from a GPU
with generous VRAM.

## Build prerequisites

Install the following tools before building:

- Git
- Node.js 20 or newer and npm
- Rust stable and Cargo (installation through [rustup](https://rustup.rs/) is recommended)
- Python 3.11 with virtual-environment support
- Tauri's Linux/WebKitGTK development libraries
- A recent NVIDIA driver for GPU inference
- ImageMagick, recommended for fast gallery thumbnails

### Fedora

```bash
sudo dnf group install "C Development Tools and Libraries"
sudo dnf install \
  webkit2gtk4.1-devel libsoup3-devel openssl-devel libappindicator-gtk3-devel \
  librsvg2-devel python3.11 python3.11-devel nodejs npm git curl wget file ImageMagick
```

Install Rust if it is not already available:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install \
  build-essential libwebkit2gtk-4.1-dev libssl-dev \
  libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev python3 python3-venv \
  python3-dev git curl wget file imagemagick
```

Install Node.js 20+ using your preferred Node.js package source, then install
Rust with [rustup](https://rustup.rs/). Distribution repositories sometimes
provide versions of Node.js or Rust that are too old for current Tauri tooling.

For other distributions, follow the
[Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run from source

Clone the repository and enter it:

```bash
git clone YOUR_REPOSITORY_URL
cd inpaint
```

Install the frontend and model runtime dependencies:

```bash
npm install
./scripts/setup-model.sh
```

The model setup script creates `.venv/` inside the project and installs CUDA
PyTorch, `simple-lama-inpainting`, and IOPaint. It prints whether PyTorch can
see CUDA and the detected GPU. If it reports `CUDA available: False`, verify
the NVIDIA driver before continuing.

Start the desktop application:

```bash
npm run desktop
```

The first Rust build takes longer than later launches. Model weights are not
downloaded during `npm install`; each model downloads when it is selected and
used for the first time.

## Inpainting models

All models are provided by their respective upstream projects. Their weights
have separate licenses and terms; review the linked sources before
redistributing them.

| Model | Best for | Download source |
| --- | --- | --- |
| **LaMa** | Fast general-purpose object removal, people, blemishes, and natural textures | [`big-lama.pt`](https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt) from [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting) |
| **MAT** | Large masks, landscapes, rooms, and broader scene reconstruction | [`Places_512_FullData_G.pth`](https://github.com/Sanster/models/releases/download/add_mat/Places_512_FullData_G.pth), distributed by IOPaint; original [MAT project](https://github.com/fenglinglwb/MAT) |
| **ZITS** | Architecture, fences, horizons, edges, and straight structural lines | Four [ZITS checkpoints](https://github.com/Sanster/models/releases/tag/add_zits), distributed by IOPaint; original [ZITS project](https://github.com/qianyuezqy/ZITS_inpainting) |
| **MIGAN** | Quick small or medium repairs on uncomplicated backgrounds; internally works with 512px crops | [`migan_traced.pt`](https://github.com/Sanster/models/releases/download/migan/migan_traced.pt), distributed by IOPaint; original [MI-GAN project](https://github.com/Picsart-AI-Research/MI-GAN) |
| **SDXL Inpainting** | Slower, prompt-guided generation when a region needs new semantic detail | [`diffusers/stable-diffusion-xl-1.0-inpainting-0.1`](https://huggingface.co/diffusers/stable-diffusion-xl-1.0-inpainting-0.1) and the [`sdxl-vae-fp16-fix`](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix) VAE from Hugging Face |

LaMa is approximately 197 MB. MAT, ZITS, and MIGAN are downloaded on demand
through IOPaint. SDXL is a multi-gigabyte download.

### Model storage

Model weights and caches live under `models/` in the app's data directory.
In a configured source checkout, they live in the repository's `models/` directory.

```text
models/
├── lama/          # LaMa checkpoint
├── torch/         # Inpainting, GFPGAN, and upscaling checkpoints
├── huggingface/   # SDXL, BRIA, and Hugging Face cache data
├── faceswap/      # InsightFace and INSwapper models
├── restormer/     # Detail restoration models
└── .runtime/      # Generated persistent-worker script
```

In a source checkout, this directory is ignored by Git except for its README.
Downloaded models can be used offline. Each model loads when first used and
stays in memory across tool and image changes. Upscale factors and denoising
settings reuse the same network.

Open **Workspace > Memory** to unload models you no longer need. This frees RAM
and VRAM for other operations, especially on large images. Closing the app
releases all loaded models.

### Image enhancement plugins

The editor also includes:

- **Smart selection** with MobileSAM: click to include an object and Alt-click to
  exclude an area. Switch back to paint
  or erase to refine the resulting selection.
- **Mask brushes** with size, hardness, opacity, an eraser, grow/shrink, and
  feathering. Feathered selections blend the result into the untouched image.
- **Clone and healing brushes**: Alt-click a source point, then paint a destination.
  Healing retains sampled texture while matching local lighting.
- **Color and lighting** with live exposure, contrast, temperature, saturation,
  shadows, and highlights previews. Apply renders the full-resolution result.
- **Face color matching** with adjustable strength for brightness/skin-tone
  matching on the next replacement. It is separate from the live GFPGAN slider.
- **Background edge refinement** with shrink/expand, softness, and color-halo
  removal using nearby opaque foreground colors.
- **Outpainting** with independent canvas extension on all four sides, a choice
  of the existing inpainting models, and a prompt for SDXL. Original pixels and
  transparency stay intact inside the expanded image.
- **Shared restoration strength** for GFPGAN and face replacement. After either
  operation, the slider blends the raw and restored result without another model
  run. A later edit or history jump ends that live adjustment.
- **Face selection**: detect faces, click a numbered face, then choose its source
  photo. Different faces can have different sources; use Replace individually or
  Replace all assigned faces. Without a selection, the largest face is used.
- **Before/after comparison** against the original or the previous history step,
  with a draggable divider and shared zoom/pan. Different sizes fit the current frame.
- **Crop and straighten** from the top bar, with free cropping, common aspect
  ratios, and an angle preview. Drag on the image to set the crop. Rotated corners
  are transparent until cropped away.
- **Background replacement** with a color, an image, or a blurred original. The
  optional first removal step uses the background model selected in the panel.

The top-bar History, Workflows, and Export buttons open the **Workspace** drawer:

- History contains named previews for the current picture. Selecting a step
  restores its image and dimensions; a new edit discards subsequent steps.
- Workflows save ordered operations with the current tool settings. Add, reorder,
  and remove steps, then save a named workflow. Workflows persist across restarts;
  referenced source photos and background images must remain at their saved paths.
  Reusable face swaps select the largest face in each image.
- Batch accepts multiple pictures and applies a saved workflow sequentially,
  reusing loaded models. Each file has progress and error reporting. Stop takes
  effect after the current operation; completed exports remain available. Batch
  reads pictures from disk, independently of unsaved editor changes.
- Export writes PNG, JPEG, or WebP copies with format quality, dimensions, aspect
  ratio controls, filename suffix, and a JPEG transparency fill color. Zero in
  both dimensions keeps the edited size. Files are never overwritten: collisions
  receive numbered names. The original Save button still saves over the source.
- Memory lists cached models and worker RAM, with individual and all-model unload
  controls. GPU figures cover PyTorch allocations, not ONNX/driver allocations.

The left panel also provides:

- **GFPGAN 1.4** for restoring facial detail.
- **Face swap** with automatic GFPGAN restoration of the replaced face.
- **RealESRGAN** with photo, anime, and general-purpose models at 2× to 4× output scale.
- **Real-HAT Sharper** for sharper AI upscaling, and **Lanczos** for standard resizing without AI reconstruction.
- **Background removal** with BRIA RMBG 1.4/2.0 and U²-Net general/human models.

BRIA 1.4 works without a login. To use BRIA 2.0, open **Set up model access**
below its dropdown, request access on Hugging Face, and save a read token from
the approved account. You can change or remove the token using the links below
the dropdown. The token is stored locally with access limited to your Linux user.

Use PNG or WebP to keep a transparent background. JPEG does not support transparency.

### Upscaling

The Upscale menu offers 2×, 3×, and 4× output for every method. **General v3**
also has a **Denoising** slider: 0% uses the weak-denoising model to retain more
texture/noise; 100% uses the strong-denoising model. The initial setting is 25%.

HAT uses the official `Real_HAT_GAN_sharper.pth` checkpoint from
[XPixelGroup/HAT](https://github.com/XPixelGroup/HAT), loaded through Spandrel.
It processes the image in tiles to limit GPU memory use. Its native 4× output
is resized with Lanczos when 2× or 3× is selected. HAT is slower than RealESRGAN
and can change textures. Choose Lanczos for ordinary resizing without AI.

The HAT checkpoint (about 170 MB) and General v3 weak-denoising checkpoint
(about 4.9 MB) download into `models/torch/hub/checkpoints/` on first use.
`scripts/setup-model.sh` installs the required `spandrel` and `gdown` packages.
To install those dependencies separately:

```bash
.venv/bin/python -m pip install spandrel==0.4.2 gdown==5.2.0
```

### Restore detail without upscaling

**Restore detail · Restormer** (or **Alt+T**) restores the current image at its
existing resolution. Choose **Out-of-focus blur**, **Motion blur**, or **Photo
noise** to match the problem. Strength blends the restored result with the
original and applies on the next run. Image dimensions and transparency are preserved.

The [official Restormer models](https://github.com/swz30/Restormer/releases/tag/v1.0)
are about 100 MiB each and download on first use into `models/restormer/`.
Restormer processes overlapping tiles to limit GPU memory use. If it runs out
of GPU memory, it tries smaller tiles, then falls back to the CPU. CPU processing
is slower. The maximum input size is 64 megapixels, and severe blur may remain
after restoration.

Restormer is included in the app's runtime, with its upstream MIT license.

### Face replacement

In the left panel, click the square **Select photo** picker, choose a PNG, JPEG,
or WebP containing the face to use, then click **Replace**. The tool uses the
largest face in the source photo. In the target image, it replaces the face
you selected, or the largest face if none is selected, then restores that area
with GFPGAN. Replacement and restoration form one undoable edit and keep the
image's dimensions and transparency. If no face is detected, choose a clearer photo.

The first-launch installer and main setup script include face replacement.
To reinstall its dependencies in a source checkout:

```bash
./scripts/setup-face-swap.sh
```

The script installs InsightFace 0.7.3 and the CUDA-capable ONNX runtime, which
also supports CPU fallback. Model weights go in `models/faceswap/` and download
on first use. To copy weights from an existing installation, set
`FACE_SWAP_PROJECT_DIR` to a directory containing `models/inswapper_128.onnx`
and `INSIGHTFACE_MODELS_DIR` to the directory containing the `buffalo_l` models
before running the script.

Face replacement uses [InsightFace's INSwapper](https://github.com/deepinsight/insightface/tree/master/examples/in_swapper).
Model weights have their own upstream license terms.

## Editor controls

Hover over the `?` button in the lower-left corner of the editor to see these
controls in the application.

| Input | Action |
| --- | --- |
| Left mouse drag | Paint the mask |
| Mouse wheel | Zoom around the pointer |
| Ctrl + mouse wheel | Change brush size |
| Space + drag or middle mouse drag | Pan |
| Shift + paint | Apply the mask when the stroke ends |
| Space | Apply the current mask |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Left / Right or A / D | Previous / next image |
| Home / End | First / last image in the folder |
| Numpad `*` / Numpad `/` | Fit to window / actual size |
| Numpad `+` / Numpad `-` | Zoom in / out |
| Ctrl+S | Overwrite the current image |
| O | Toggle between the original and edited image |
| Esc | Return to the folder browser |
| Alt+T | Restore detail with the selected Restormer model and strength |
| Alt+U | Upscale using the selected method, scale, and denoising |
| Alt+F | Restore faces with GFPGAN and the shared strength |
| Alt+R | Replace the selected/largest face with the selected source |
| Alt+B | Remove the background using the selected model |
| Alt+G | Apply the replacement background settings |
| Alt+D | Detect faces for selection |
| Alt+E | Apply background edge refinement |
| Alt+C | Toggle crop and straighten |
| Alt+H / Alt+V | Flip horizontally / vertically |
| Alt+[ / Alt+] | Rotate left / right |

Action shortcuts also appear on tool buttons and in the scrollable help overlay.
They use the current tool settings, including when the tool's section is collapsed.
Shortcuts are disabled while typing or running an operation.

Every tool section has an icon and a collapsible heading. Expanded states, brush
settings, model choices, prompts, color/edge/outpaint settings, background choices,
and workspace/export selections persist between pictures and application restarts.
The last face source is remembered as a single file path and reloaded when available.
Masks, detected face coordinates, crop rectangles, and image edit history belong to
the current image and are cleared when you leave it.

## Build an executable or package

### Plain Linux executable (no installer)

Build and run the desktop executable:

```bash
./build.sh
./inpaint-desktop
```

`build.sh` builds the frontend and optimized desktop application, verifies
that the executable can read its embedded `index.html` and referenced scripts
and styles, then copies it to `inpaint-desktop` in the project root, replacing
an existing copy. It can be invoked from any working directory. If the build
or asset check fails, the existing root executable is preserved. Restart a
running app to use the update.

The frontend is embedded; `dist/` is not needed beside the executable at runtime.
To check the embedded assets without opening a window, run:

```bash
./inpaint-desktop --check-assets
```

The executable embeds the Rust backend and web frontend. It still needs the
host's Linux desktop libraries. In a configured source checkout, it reuses
the adjacent `.venv/` and `models/`. On a fresh machine, the setup screen
installs the Python runtime as described under [Portable deployment](#portable-deployment).

### AppImage (no system installation)

Build an AppImage with the desktop libraries included:

```bash
./build-portable.sh
./inpaint-desktop.AppImage
```

The script builds the app and copies the AppImage to the project root. Tauri's
package output also remains under `src-tauri/target/release/bundle/appimage/`.
Distribute `inpaint-desktop.AppImage`; Python dependencies install during setup,
and model weights download when first used. They are stored outside the AppImage.

### DEB or RPM

Create a distribution package only if system installation is desired:

```bash
# Debian and Ubuntu
npm run tauri -- build --bundles deb

# Fedora and other RPM-based distributions
npm run tauri -- build --bundles rpm
```

DEB and RPM packages install the binary, desktop entry, and icons into system
locations such as `/usr/bin` and `/usr/share`. The first-launch setup installs
the Python runtime in the user's app data directory. Model weights download
on first use. Set `INPAINT_PROJECT_DIR` to reuse a prepared runtime directory.

To build all package formats configured in `src-tauri/tauri.conf.json`, run:

```bash
npm run tauri -- build
```

All package output is written below `src-tauri/target/release/bundle/`.
Package compatibility varies by Linux distribution.

## License

Inpaint is licensed under the [GNU Affero General Public License, version 3](LICENSE)
(`AGPL-3.0-only`). Copyright (c) 2026 Inpaint contributors.

The face-swap integration was adapted from a local project based on
[Deep-Live-Cam](https://github.com/hacksider/Deep-Live-Cam). Its upstream credits
and license are recorded in the
[code provenance notes](THIRD_PARTY_NOTICES.md#face-swap-code-provenance).

When publishing executables or AppImages, provide the corresponding source for
that exact release, including build scripts, alongside the download. Include
`LICENSE` and `THIRD_PARTY_NOTICES.md` with the release and retain upstream notices.
Modified versions offered for remote use over a network must also offer their
corresponding source to those users, as required by section 13 of the license.
Inpaint is provided without warranty; see `LICENSE` for the full terms.

Libraries, model weights, and screenshot photos retain their upstream licenses.
Some models are restricted to non-commercial use or research. See
[Third-party software and models](THIRD_PARTY_NOTICES.md) for the license notes
and links to their terms.

## Technology

- [Tauri 2](https://tauri.app/) and Rust
- React, TypeScript, and Vite
- PyTorch with CUDA
- [IOPaint](https://github.com/Sanster/IOPaint)
- [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting)
