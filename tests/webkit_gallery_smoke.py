"""Exercise GIF cards, scrolling, and hide/show with the system WebKitGTK renderer.

Run: xvfb-run -a /usr/bin/python3 tests/webkit_gallery_smoke.py [path/to/styles.css]
Requires PyGObject, WebKit2 4.1, and Pillow. Uses synthetic images and no app data.
Pass an older stylesheet to compare renderer responsiveness before a CSS change.
"""

import base64
import io
import os
from pathlib import Path
import sys
import time

os.environ.setdefault("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2
from PIL import Image


css = Path(sys.argv[1] if len(sys.argv) > 1 else "src/styles.css").read_text()
gif = io.BytesIO()
frames = [Image.new("RGB", (160, 120), color) for color in ("#92663c", "#466d85", "#508056")]
frames[0].save(gif, format="GIF", save_all=True, append_images=frames[1:], duration=60, loop=0)
source = "data:image/gif;base64," + base64.b64encode(gif.getvalue()).decode()
card = f'''<button class="image-card"><div class="thumbnail-wrap">
<img class="shown" src="{source}"><div class="edit-hint" style="opacity:1">Double-click to edit</div>
</div><span class="image-marks"><span class="image-mark">A</span><span class="image-mark">B</span>
<span class="image-mark">C</span></span></button>'''
rows = "".join(f'<div class="image-row" style="top:{row * 155}px;grid-template-columns:repeat(8,1fr)">{card * 8}</div>' for row in range(10))
html = f'''<html><head><style>{css}</style></head><body><div class="browser-shell">
<aside class="sidebar">Synthetic gallery regression</aside><main class="gallery">
<header class="gallery-header"><h1>Animated gallery</h1></header>
<div class="image-grid" style="height:1550px">{rows}</div></main></div>
<script>window.ticks=0; function tick() {{ window.ticks++; requestAnimationFrame(tick); }} tick();</script>
</body></html>'''

window = Gtk.Window()
window.set_default_size(1600, 1000)
view = WebKit2.WebView()
window.add(view)
start = time.monotonic()
samples = []
errors = []


def result(webview, operation, _):
    try:
        samples.append((time.monotonic() - start, webview.evaluate_javascript_finish(operation).to_int32()))
    except GLib.Error as error:
        errors.append(str(error))


def sample():
    seconds = time.monotonic() - start
    scroll = 400 if int(seconds) % 2 else 0
    view.evaluate_javascript(f"document.querySelector('.gallery').scrollTop={scroll}; window.ticks", -1, None, None, None, result, None)
    return True


def finish():
    print(f"samples={len(samples)}, ticks={samples[-1][1] if samples else 0}, errors={errors}", flush=True)
    # Require the renderer to answer after both tray-like hide/show cycles.
    passed = not errors and len(samples) >= 10 and samples[-1][0] >= 13 and samples[-1][1] > 20
    window.destroy()
    Gtk.main_quit()
    global exit_code
    exit_code = 0 if passed else 1
    return False


exit_code = 1
view.load_html(html, "file:///tmp/")
window.show_all()
GLib.timeout_add(500, sample)
GLib.timeout_add_seconds(4, lambda: (window.hide(), False)[1])
GLib.timeout_add_seconds(6, lambda: (window.show_all(), False)[1])
GLib.timeout_add_seconds(9, lambda: (window.hide(), False)[1])
GLib.timeout_add_seconds(11, lambda: (window.show_all(), False)[1])
GLib.timeout_add_seconds(15, finish)
Gtk.main()
sys.exit(exit_code)
