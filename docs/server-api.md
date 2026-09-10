# Local API server

Inpaint can run an HTTP API so other programs, such as a browser extension,
can send pictures to the app. Requests run in the open app window with the same
operations and saved workflows as the editor, and they reuse loaded models.

## Enable the server

In the folder browser, click **API server** at the bottom of the sidebar.

- **Enable the API server** starts listening when you apply. The app starts the
  server again on its next launch.
- **Listen on**: `127.0.0.1` accepts requests from this computer only.
  `0.0.0.0` accepts requests from your network. Plain HTTP sends the token and
  pictures unencrypted.
- **Port**: 7865 by default.
- **Access token**: required on every request.
- **Folders the API may read and write**: every disk path in a request must be
  inside one of these folders, after symbolic links are resolved.
- **Save folder**: where `/save` writes pictures sent without a path. The
  default is `~/Pictures/Inpaint`.
- **Download pictures from http(s) URLs**: lets requests pass a URL instead of
  the picture. The app downloads it itself, following up to five redirects.

Settings are stored in `inpaint.db` in the app data directory, readable only
by your Linux user. The window must be open and past the runtime setup;
otherwise requests return `503`.

## Authentication

Send the token with every request:

```text
Authorization: Bearer <token>
```

`X-Inpaint-Token: <token>` also works. While the server listens on
`127.0.0.1`, the `Host` header must be `127.0.0.1:<port>` or
`localhost:<port>`, which blocks DNS-rebinding pages.

The server sends no CORS headers, so web pages cannot read its responses. A
browser extension should call it from its background service worker, with the
server address in `host_permissions`.

## Sending pictures

Requests can use either style.

**JSON** with `Content-Type: application/json`:

```json
{ "image": "/mnt/nas/photos/IMG_0001.jpg", "options": { "method": "lanczos", "scale": 2 } }
```

**Raw bytes** as the body, for example with `Content-Type: image/jpeg`. Put
everything else in the query string: options as separate parameters
(`?method=lanczos&scale=2`) or as `?options=<JSON object>`.

The picture fields `image`, `mask`, `donor` and `background` accept:

| Form | Example |
| --- | --- |
| Absolute disk path | `"/mnt/nas/a.jpg"` or `{ "path": "/mnt/nas/a.jpg" }` |
| http(s) URL | `"https://example.com/a.jpg"` or `{ "url": "…" }` |
| Data URL | `"data:image/png;base64,iVBORw0…"` |
| Base64 without a prefix | `{ "data": "iVBORw0…" }` |

In the raw-bytes style, `mask`, `donor` and `background` can be query
parameters holding a path or URL.

PNG, JPEG and WebP are used as sent. Other formats that decode, such as GIF,
BMP or TIFF, become PNG. Pictures with an EXIF orientation are rotated upright
first, so the result never needs that tag.

Other request fields:

| Field | Endpoints | Meaning |
| --- | --- | --- |
| `write` | operations, workflows | `true` overwrites the picture's own disk path. |
| `outputPath` | operations, workflows | Writes the result to this path instead. |
| `format` | operations, workflows | Response format: `auto` (default), `png`, `jpeg` or `webp`. `auto` keeps JPEG unless the result has transparency, otherwise PNG. |
| `path` | `/save`, `/load` | `/save`: file to replace or create. `/load`: file that Save in the editor overwrites, when the picture is sent as bytes. |
| `name` | `/save`, `/load` | File name for a picture sent without a path. |

## Responses

An operation returns the picture bytes with `Content-Type`, `X-Image-Width` and
`X-Image-Height`. With `write` or `outputPath`, and for `/save`, it returns:

```json
{ "ok": true, "path": "/mnt/nas/photos/IMG_0001.jpg", "width": 4000, "height": 3000, "bytes": 3481123 }
```

Errors are JSON, `{ "ok": false, "error": "…" }`:

| Status | Cause |
| --- | --- |
| 400 | Invalid request or option |
| 401 | Missing or wrong token |
| 403 | Path outside the allowed folders, URL downloads turned off, or a wrong `Host` |
| 404 | Unknown endpoint, operation, workflow or file |
| 413 | Body larger than 256 MB |
| 415 | The data is not a picture |
| 502 | URL download failed |
| 503 | The app window is not ready |
| 500 | Processing failed |

Written files keep the original's EXIF data (capture date, camera, GPS) with
the orientation reset. Replaced files keep their permissions and are swapped
in atomically.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /health` | `{ ok, app, version, ready }` |
| `GET /operations` | Endpoints, plus every operation with its options, defaults and ranges |
| `POST /{operation}` | Run one operation |
| `GET /workflows` | Saved workflows: `{ id, name, path, steps }` |
| `POST /workflow/{id-or-name}` | Run every step of a saved workflow |
| `GET /face-source` | Face source photo selected in Inpaint: `{ path, name, preview }` with a small JPEG data URL, or `null` |
| `POST /load` | Open a picture in the editor |
| `POST /save` | Write a picture to disk |

### Operations

Options left out of a request use the current settings of Inpaint's editor, so
choosing another model or moving a slider there changes what later requests do.
The values in parentheses apply only where the editor has no setting, and
`GET /operations` reports the values currently in effect as each option's
`default`. Models download on first use, as in the editor,
so a model's first request can take minutes. Requests and the editor share one
model worker and wait for each other.

| Operation | Options | Pictures |
| --- | --- | --- |
| `inpaint` | `model`: `lama`, `mat`, `zits`, `migan`, `sdxl` (`lama`); `prompt` for SDXL | `mask` (required): white is removed |
| `face-swap` | `strength` 0–1 (1); `colorMatch` 0–1 (0); `target` `[x, y]` fractions (largest face) | `donor` (optional): the face to use; defaults to the face source photo selected in Inpaint |
| `detect-faces` | none; returns `{ "ok": true, "data": [{ "id": 0, "box": [x, y, w, h] }] }` | |
| `restore-faces` | `strength` 0–1 (1) | |
| `upscale` | `method`: `RealESRGAN_x4plus`, `hat-sharper`, `realesr-general-x4v3`, `RealESRGAN_x4plus_anime_6B`, `lanczos` (`RealESRGAN_x4plus`); `scale` 2–4 (2); `denoise` 0–1 (0.25) | |
| `restore-detail` | `model`: `compressed`, `natural`, `jpeg`, `noise`, `motion` (`compressed`); `strength` 0–1 (1) | Restormer's former names `defocus` and `denoise` mean `compressed` and `noise`. |
| `remove-background` | `model`: `briaai/RMBG-1.4`, `u2net`, `u2net_human_seg`, `briaai/RMBG-2.0` (`briaai/RMBG-1.4`) | |
| `replace-background` | `mode`: `color`, `image`, `blur` (`color`); `color` (`#ffffff`); `blur` 1–100 (20); `removeFirst` (`true`); `model` as above | `background` when `mode` is `image` |
| `refine-edges` | `shrink` −16–16 (1); `soften` 0–10 (0.5); `decontaminate` 0–1 (0.5) | |
| `outpaint` | `left`, `top`, `right`, `bottom` 0–4096 px (0, set at least one); `model` (`lama`); `prompt` | |
| `adjust` | `exposure` −3–3 EV (0); `contrast`, `temperature`, `saturation`, `shadows`, `highlights` −100–100 (0) | |
| `crop` | `rect` `[x, y, width, height]` fractions (`[0, 0, 1, 1]`); `angle` −45–45 (0) | |
| `flip-horizontal`, `flip-vertical`, `rotate-left`, `rotate-right` | none | |

Unknown option names are rejected, which catches typos.

### Workflows

`/workflow/{id-or-name}` accepts a workflow's id, its name ignoring case, or
the name as a slug: "Photo finish" is `/workflow/photo-finish`. The steps use
the settings saved in the workflow, including source photo and background
paths.

### /load

Opens the picture in the editor and brings the window forward. If the editor
has unsaved changes, the app asks about them first. A picture sent as a disk
path saves back to that file, and so does one sent with `path` (inside an
allowed folder), even as bytes or data URL. Anything else asks where to save.

### /save

- With `path`: the path must be inside an allowed folder. An existing file is
  replaced and keeps its EXIF data; a missing file is created.
- Without `path`: a new file in the save folder, named from `name`, else from
  the source file name or URL, else `image.png`. Existing files are never
  overwritten; the name gets `_1`, `_2` and so on.

The file format follows the extension. A picture already in that format is
written as sent, without re-encoding.

## Examples

```bash
TOKEN=…
API=http://127.0.0.1:7865

# Upscale a file on disk and keep the result in the response.
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"image": "/mnt/nas/photos/cat.jpg", "options": {"scale": 2}}' \
  -o cat-2x.jpg "$API/upscale"

# Send raw bytes; options in the query string.
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/jpeg" \
  --data-binary @portrait.jpg -o cutout.png "$API/remove-background?model=u2net_human_seg"

# Run a saved workflow and overwrite the file.
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"image": "/mnt/nas/photos/cat.jpg", "write": true}' "$API/workflow/photo-finish"

# Open a web picture in the editor.
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"image": "https://example.com/photo.jpg"}' "$API/load"
```

From an extension's background service worker:

```js
async function runInpaint(operation, blob, options = {}) {
  const query = new URLSearchParams({ options: JSON.stringify(options) });
  const response = await fetch(`http://127.0.0.1:7865/${operation}?${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.blob();
}
```

## Immich pictures on a mounted library

For assets in an Immich external library whose files are mounted on this
computer:

1. Read the asset with Immich's `GET /api/assets/{id}`. Its `originalPath` is
   the path inside the Immich container; replace that prefix with the local
   mount point.
2. Preview: send the local path to an operation and show the returned bytes.
3. Apply: send the preview bytes to `/save` with `path` set to the local file.
   Running the operation with `"write": true` does the same without a preview.
4. Ask Immich to rebuild its thumbnail with
   `POST /api/assets/jobs` and `{ "assetIds": ["<id>"], "name": "regenerate-thumbnail" }`.
   Use `refresh-metadata` as well when the dimensions changed. Check the job
   names against your Immich version.

Do not write into Immich's own upload library; Immich tracks those files by
checksum. Upload edits of such assets through the Immich API instead.
