"""Model downloads with progress, bounded retries and resumable partial files."""
import hashlib
import os
from pathlib import Path
import time
import urllib.request
import urllib.error
from worker_protocol import emit


def progress(label, percent=None, detail=""):
    emit({"event": "progress", "label": label, "percent": percent, "detail": detail})


def download(url, destination, sha256=None):
    destination = Path(destination)
    if destination.is_file():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    for attempt in range(3):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {"User-Agent": "Inpaint-Desktop"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                resumed = response.status == 206 and response.headers.get("Content-Range", "").startswith(f"bytes {offset}-")
                if not resumed:
                    offset = 0
                total = int(response.headers.get("Content-Length", 0)) + offset
                received, last = offset, 0
                with partial.open("ab" if resumed else "wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        received += len(chunk)
                        if time.monotonic() - last > .3:
                            progress(destination.name, round(received / total * 100) if total else None,
                                     f"{received // (1024 * 1024)} MB downloaded")
                            last = time.monotonic()
                if total and received != total:
                    raise IOError("Download ended before the file was complete.")
            if sha256:
                with partial.open("rb") as handle:
                    digest = hashlib.file_digest(handle, "sha256").hexdigest()
                if digest != sha256:
                    partial.unlink(missing_ok=True)
                    raise ValueError("Downloaded model checksum does not match.")
            partial.replace(destination)
            progress(destination.name, 100, "Download complete")
            return destination
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 416:
                partial.unlink(missing_ok=True)
            if attempt == 2:
                raise RuntimeError(f"Could not download {destination.name}: {error}. Run the operation again to retry.") from error
            progress(destination.name, None, f"Retrying download ({attempt + 2}/3)…")
            time.sleep(1 + attempt)


def install_hooks():
    import torch.hub
    def fetch(url, dst, hash_prefix=None, progress=True):
        path = download(url, dst)
        if hash_prefix:
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if not digest.startswith(hash_prefix):
                path.unlink(missing_ok=True)
                raise RuntimeError("Model download checksum mismatch. Retry the operation.")
    torch.hub.download_url_to_file = fetch


def face_models(models_dir):
    import zipfile
    root = Path(models_dir)
    download("https://github.com/deepinsight/insightface/releases/download/v0.7/inswapper_128.onnx",
             root / "inswapper_128.onnx", "e4a3f08c753cb72d04e10aa0f7dbe3deebbf39567d4ead6dce08e98aa49e16af")
    target = root / "models/buffalo_l"
    names = ["det_10g.onnx", "w600k_r50.onnx"]
    if all((target / name).is_file() for name in names):
        return
    archive = download("https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip", root / "buffalo_l.zip")
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for name in names:
            if (target / name).is_file():
                continue
            member = next(item for item in bundle.namelist() if Path(item).name == name)
            temporary = target / (name + ".extracting")
            with bundle.open(member) as source, temporary.open("wb") as output:
                import shutil
                shutil.copyfileobj(source, output)
            temporary.replace(target / name)
