# Inpaint integration

Sends pictures from web pages and Immich to the Inpaint desktop app
(`/media/sy/Projects/rand/inpaint`) through its local API, and shows the results
in place. The app's `docs/server-api.md` describes the API.

## Setup

Install the extension first: load the `browser-extension` folder unpacked, or
build `inpaint-extension.crx` with `./build-extension.sh`. Inpaint's README
explains both under **Browser extension**.

1. In Inpaint, click **API server** in the folder browser. Enable it, copy the
   access token, and add the folders Inpaint may read and write, such as the
   NAS mount that holds the Immich library.
2. Open the extension options (right-click the extension icon → Options) and
   enter the API address, token, Immich address, Immich API key and library
   folder mappings. Use **Save and test** for both.

The Immich API key needs `asset.read`, `asset.view`, `asset.download` and
`job.create`.

## Use

- **Alt+Shift+I**, or the page context menu **Inpaint panel**, toggles the
  panel. **Pick pictures**, click a picture, adjust the suggested CSS selector
  and save it. Every matching picture on that site gets an Inpaint button in its
  top-right corner. On the Immich server and on pages that show a single picture,
  pictures match without picking.
- Hover the button for the menu: the operations and workflows chosen in the
  panel, then **Open in Inpaint editor**, **Save**, **Undo** and **Show
  original**. Results replace the picture on the page only. Further actions
  apply to the edited result. Actions run with the models and settings
  currently chosen in Inpaint's editor.
- Face swap uses the face source photo selected in the Face swap section of
  Inpaint, which the panel shows. Choose or clear it there.
- **Save** writes an Immich asset back to its library file when its folder is
  mapped, then asks Immich to regenerate the thumbnail (and metadata when the
  size changed). Anything else goes to Inpaint's save folder.
- The image context menu **Open in Inpaint** opens any picture in the editor.

## Files

| File | Role |
| --- | --- |
| `background.js` | Service worker: all requests to Inpaint and Immich, context menu, shortcut |
| `content.js` | Picture matching, hover button and menu, results on the page, picking |
| `panel.js` | In-page panel: site selectors, menu actions and options, face source |
| `options.html`, `options.js`, `options.css` | Addresses, token, Immich key and folder mappings |
| `settings.js` | Settings storage shared by the service worker and options page |

Storage keys in `chrome.storage.local`: `inpaintSettings`, `inpaintSites`
(selectors per hostname) and `inpaintMenu` (actions, workflows, options).
