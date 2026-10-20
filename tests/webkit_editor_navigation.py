"""Run the editor navigation regression in WebKitGTK using synthetic images.

xvfb-run -a /usr/bin/python3 tests/webkit_editor_navigation.py [previous/Editor.tsx]
Requires PyGObject and WebKit2 4.1, plus the project's npm dependencies.
"""
import os
from pathlib import Path
import subprocess
import sys

os.environ.setdefault("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1")
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2

root = Path(__file__).resolve().parents[1]
bundle = """
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const previous = process.argv[1];
const plugins = previous ? [{name:'previous-editor', setup(build) {
    build.onLoad({filter:/\\/Editor\\.tsx$/}, () => ({
        contents:readFileSync(previous, 'utf8'), loader:'tsx', resolveDir:resolve('src')
    }));
}}] : [];
const result = await build({entryPoints:['tests/editorNavigation.tsx'], bundle:true,
    write:false, format:'iife', plugins, define:{'process.env.NODE_ENV':'"production"'}});
process.stdout.write(result.outputFiles[0].text);
"""
script = subprocess.check_output([
    "node", "--input-type=module", "-e", bundle, *sys.argv[1:2],
], cwd=root, text=True)
css = (root / "src/styles.css").read_text()
window = Gtk.Window()
window.set_default_size(1380, 860)
view = WebKit2.WebView()
window.add(view)
exit_code = 1

def finish(message):
    global exit_code
    print(message, flush=True)
    exit_code = 0 if message.startswith("PASS:") else 1
    window.destroy()
    Gtk.main_quit()
    return False

def result(webview, operation, _):
    try:
        text = webview.evaluate_javascript_finish(operation).to_string()
        if text:
            finish(text)
    except GLib.Error as error:
        finish(f"FAIL: {error}")

def poll():
    view.evaluate_javascript("window.testResult || ''", -1, None, None, None, result, None)
    return True

view.load_html(f"<html><head><style>{css}</style></head><body><div id='root'></div><script>{script}</script></body></html>", "file:///tmp/")
window.show_all()
GLib.timeout_add(250, poll)
GLib.timeout_add_seconds(15, lambda: finish("FAIL: timed out"))
Gtk.main()
sys.exit(exit_code)
