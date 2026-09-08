# Screenshot gallery notes

These are real, 1600 × 1000 captures of the Linux desktop application, stored as
lossless WebP so text and image detail survive compression. The screenshots
were taken in a separate demo session using copies of the source photos.

## What the examples show

- `object-mask` and `object-result`: painting over a spoon and removing it with LaMa.
- `face-result`: Neil Armstrong's face substituted into Eileen Collins's portrait,
  followed by the app's GFPGAN restoration. **This is an altered demonstration
  image, not an authentic photograph of either person.**
- `gfpgan` and `restormer`: face restoration followed by defocus restoration,
  retaining the portrait's 512 × 512 dimensions.
- `background-result` and `background-replace`: BRIA RMBG 1.4 background removal
  and a solid white replacement. The edge-refinement settings are shown; an
  additional edge-refinement pass was not applied in this example.
- `upscale` and `comparison`: Real-HAT 2× upscaling of Chelsea the cat from
  451 × 300 to 902 × 600 pixels. The comparison shows the original on the left,
  fitted to the edited image's frame, and the upscale on the right.
- `color`: a live preview of exposure +0.3 EV, contrast +12, and saturation +9
  applied to the upscaled cat image.
- `crop` and `outpaint`: configuration previews. The square crop and canvas
  extension have not been applied in these captures.
- `workflows` and `batch`: a two-step workflow and two queued images; the batch
  has not been run.
- `export`: export configuration, before selecting a destination.
- `history`, `memory`, `gallery`, and `shortcuts`: the corresponding app panels.

## Photo credits

| Photo | Creator and source | Reuse information |
| --- | --- | --- |
| Eileen Collins portrait | NASA, distributed as [scikit-image's astronaut sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut) | Public domain; edited in the restoration, face-replacement, and background examples. |
| Neil Armstrong portrait | NASA, [Official Portrait of Neil Armstrong](https://www.nasa.gov/image-article/official-portrait-of-neil-armstrong/), image S69-31741 | NASA image; used as the face source in the explicitly altered face-replacement demonstration. See [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/). |
| Grace Hopper portrait | James S. Davis / U.S. Navy, NH 96919-KN, distributed with Matplotlib; [source and public-domain notice](https://commons.wikimedia.org/wiki/File:Grace_Hopper.jpg) | Public domain U.S. government photograph; appears as a gallery thumbnail. |
| Coffee | Rachel Michetti, courtesy of Pikolo Espresso Bar; [scikit-image coffee sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.coffee) | CC0; the spoon is masked and removed in the object-removal examples. |
| Chelsea the cat | Stefan van der Walt; [scikit-image Chelsea sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.chelsea) | CC0; upscaled and color-adjusted in the editing examples. |
| Hubble eXtreme Deep Field | NASA, ESA, G. Illingworth, D. Magee, and P. Oesch (University of California, Santa Cruz), R. Bouwens (Leiden University), and the HUDF09 Team; [original image and credits](https://science.nasa.gov/asset/hubble/hubble-extreme-deep-field-xdf/) | Appears as a gallery thumbnail; see the source's image credit and [STScI image-use policy](https://www.stsci.edu/copyright). |

The people and organizations pictured do not endorse this application.

## Refreshing the captures

Use a separate application data/config directory and copies of the demo photos.
Keep the app window at 1600 × 1000, exclude desktop decorations and other apps,
and move the pointer away from controls before capture. Show completed operations
when describing results, and label configuration or queue screenshots accordingly.

Keep the filenames stable when replacing screenshots, preserve the source-photo
credits, and encode losslessly. The main [README](../../README.md#screenshots)
links to every image at full resolution.
