# Screenshot gallery notes

These are real, 1600 × 1000 captures of the Linux desktop application (the order
menu is cropped from one), stored as lossless WebP so text and image detail
survive compression. They were taken in a separate demo session with its own data
directory, using copies of the photos credited below.

## What the examples show

- `editor`: the editor on a photo of two macaws, with the Info panel (favourite,
  rating, description, album) and the picture strip.
- `gallery` and `masonry`: a demo image store in the grid and masonry layouts,
  with nested albums in the sidebar and tag, album, favourite and rating marks.
- `order-menu`: the order and filter menu over the masonry layout.
- `watermark-marked` and `watermark-removed`: two made-up marks, “SAMPLE PHOTO”
  and “© demo-images”, added to the macaw photo for this demonstration, found by
  **Find and mark** and removed with LaMa. They are not real watermarks.
- `upscale-comparison`: Chelsea the cat enlarged 2× with DAT2 (451 × 300 to
  902 × 600 pixels), with the original on the left of the comparison divider.
- `object-mask` and `object-result`: painting over a spoon and removing it with LaMa.
- `face-result`: Neil Armstrong's face substituted into Eileen Collins's portrait,
  followed by the app's GFPGAN restoration. **This is an altered demonstration
  image, not an authentic photograph of either person.**
- `gfpgan` and `restormer`: face restoration followed by detail restoration,
  retaining the portrait's 512 × 512 dimensions.
- `background-result` and `background-replace`: BRIA RMBG 1.4 background removal
  and a solid white replacement. The edge-refinement settings are shown; an
  additional edge-refinement pass was not applied in this example.
- `color`: a live preview of exposure +0.3 EV, contrast +12, and saturation +9
  applied to an upscaled cat image.
- `crop` and `outpaint`: configuration previews. The square crop and canvas
  extension have not been applied in these captures.
- `workflows` and `batch`: a two-step workflow and two queued images; the batch
  has not been run.
- `export`: export configuration, before selecting a destination.
- `history`, `memory`, and `shortcuts`: the corresponding app panels.

The older captures (from `object-mask` on) show an earlier version of the
interface; the features they show work the same way.

## Photo credits

| Photo | Creator and source | Reuse information |
| --- | --- | --- |
| Kodak Lossless True Color Image Suite (24 photos, including the macaws, the lighthouses and the sailing boats) | Eastman Kodak Company, [r0k.us/graphics/kodak](https://r0k.us/graphics/kodak/) | Released by Kodak for unrestricted usage; the macaw photo is edited with made-up watermarks in the watermark examples. |
| Eileen Collins portrait | NASA, distributed as [scikit-image's astronaut sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut) | Public domain; edited in the restoration, face-replacement, and background examples, and a gallery thumbnail. |
| Neil Armstrong portrait | NASA, [Official Portrait of Neil Armstrong](https://www.nasa.gov/image-article/official-portrait-of-neil-armstrong/), image S69-31741 | NASA image; used as the face source in the explicitly altered face-replacement demonstration. See [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/). |
| Coffee | Rachel Michetti, courtesy of Pikolo Espresso Bar; [scikit-image coffee sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.coffee) | CC0; the spoon is masked and removed in the object-removal examples. |
| Chelsea the cat | Stefan van der Walt; [scikit-image Chelsea sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.chelsea) | CC0; upscaled and color-adjusted in the editing examples. |
| Rocket | SpaceX, [scikit-image rocket sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.rocket) | Public domain (CC0 dedication by SpaceX); a gallery thumbnail. |

The people and organizations pictured do not endorse this application.

## Refreshing the captures

Use a separate application data/config directory and copies of the demo photos.
Keep the app window at 1600 × 1000, exclude desktop decorations and other apps,
and move the pointer away from controls before capture. Show completed operations
when describing results, and label configuration or queue screenshots accordingly.

Keep the filenames stable when replacing screenshots, preserve the source-photo
credits, and encode losslessly. The main [README](../../README.md) links to every
image at full resolution.
