"""Finds pictures of a store that are copies of each other, the way TinEye does.

Every picture gets DINOv2 embeddings of the whole picture and of a few parts of it, so a crop of a
picture still lands near the part it was cut from, and a resized, recompressed or retouched copy near the
original. Pairs that come close are then checked with ORB keypoints and a RANSAC homography: two copies
share many keypoints that one geometric transform explains, while two different photos of the same kind
of thing do not. Pairs that stand this check are joined into groups.

Run as `duplicates.py <request.json>`. The request names the pictures, the cache file and where the
answer goes; progress and the answer's arrival are written as `INPAINT_RPC:` lines.
"""
import json
import hashlib
import os
import sqlite3
import stat
import sys
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from itertools import combinations

import numpy as np
from PIL import Image, ImageFile, ImageOps

import worker_protocol

ImageFile.LOAD_TRUNCATED_IMAGES = True
# Reject huge source images before a decoder allocates their full pixel buffers.
MAX_SOURCE_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS

MODEL = "vit_small_patch14_dinov2.lvd142m"
# Bumped whenever the embeddings change meaning, so an older cache is not compared with new ones.
CACHE_VERSION = 2
# Bumped whenever the check of a pair changes, so verdicts reached the old way are not reused.
CHECK_VERSION = 6
SIDE = 224
# The whole picture, its middle, its four corners, and a closer middle: a crop of another picture is
# usually near one of these.
REGIONS = [(0.0, 0.0, 1.0, 1.0), (0.15, 0.15, 0.85, 0.85), (0.0, 0.0, 0.7, 0.7), (0.3, 0.0, 1.0, 0.7),
           (0.0, 0.3, 0.7, 1.0), (0.3, 0.3, 1.0, 1.0), (0.25, 0.25, 0.75, 0.75)]
# How close embeddings must be for a pair to be checked, how many keypoints one transform must explain,
# and how well the pixels must then agree where the pictures overlap.
LEVELS = {
    "close": {"candidate": 0.88, "inliers": 30, "agreement": 0.97, "difference": 12, "structure": 0.75},
    "normal": {"candidate": 0.78, "inliers": 20, "agreement": 0.94, "difference": 16, "structure": 0.6},
    "loose": {"candidate": 0.68, "inliers": 14, "agreement": 0.88, "difference": 22, "structure": 0.45},
}
NEIGHBOURS = 24
DECODE_THREADS = 2
BATCH_PICTURES = 4
PREFETCH_PICTURES = 4
KEYPOINT_CACHE_BYTES = 64 * 1024 * 1024
COMPARE_ROWS = 128
COMPARE_COLUMNS = 2048
RESULT_INTERVAL = 2.0
CHECKPOINT_PAIRS = 128
MEMORY_LIMIT_BYTES = 4 * 1024 ** 3


def linux_memory():
    """Resident bytes and available system RAM; virtual CUDA mappings are not RAM."""
    with open("/proc/self/statm") as handle:
        resident = int(handle.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    with open("/proc/meminfo") as handle:
        available = next(int(line.split()[1]) * 1024 for line in handle if line.startswith("MemAvailable:"))
    return resident, available


@contextmanager
def memory_guard():
    """Last-resort Linux guard, including native allocations and cache loading/saving.

    This is sampled protection, not an OS-enforced allocation limit. Exit the isolated worker without
    saving when tripped: serialising its cache would require yet more memory.
    """
    stopped = threading.Event()
    if not sys.platform.startswith("linux"):
        yield
        return
    _, available = linux_memory()
    limit = min(MEMORY_LIMIT_BYTES, available // 3)
    parent = int(os.environ.get("INPAINT_DUPLICATES_PARENT_PID", os.getppid()))

    def watch():
        while not stopped.wait(0.25):
            if os.getppid() != parent:
                os._exit(1)
            resident, free = linux_memory()
            if resident > limit or free < 256 * 1024 * 1024:
                try:
                    worker_protocol.emit({"ok": False, "error": "Duplicate search stopped to protect system memory. Try a smaller folder."})
                finally:
                    os._exit(1)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        yield
    finally:
        stopped.set()
        watcher.join()


def bounded_map(function, items, cancelled, limit=PREFETCH_PICTURES):
    """Keep only a fixed window of jobs/results, even when the consumer is slow."""
    source = iter(items)
    pending = deque()
    pool = ThreadPoolExecutor(DECODE_THREADS)
    try:
        for _ in range(limit):
            if cancelled():
                return
            try:
                item = next(source)
            except StopIteration:
                break
            pending.append(pool.submit(function, item))
        while pending:
            if cancelled():
                return
            result = pending.popleft().result()
            if cancelled():
                return
            yield result
            del result
            if cancelled():
                return
            try:
                item = next(source)
            except StopIteration:
                continue
            pending.append(pool.submit(function, item))
    finally:
        for future in pending:
            future.cancel()
        pool.shutdown(wait=True, cancel_futures=True)


def progress(stage, done, total, **details):
    worker_protocol.emit({"event": "progress", "stage": stage, "done": done, "total": total, **details})


def open_picture(path, side):
    """The upright picture in RGB, decoded at about `side` pixels, and its full size."""
    with Image.open(path) as image:
        if getattr(image, "is_animated", False):
            raise ValueError("Animated pictures need frame-by-frame comparison and are not included in duplicate searches")
        width, height = image.size
        if width * height > MAX_SOURCE_PIXELS:
            raise ValueError(f"Image exceeds the duplicate search's {MAX_SOURCE_PIXELS:,}-pixel limit")
        orientation = image.getexif().get(0x0112, 0)
        # JPEG decodes straight at a fraction of its size, which is most of the time saved here.
        image.draft("RGB", (side, side))
        image.thumbnail((side, side), Image.BILINEAR)
        image = ImageOps.exif_transpose(image)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGBA")
            background = Image.new("RGBA", image.size, (255, 255, 255, 255))
            image = Image.alpha_composite(background, image)
        image = image.convert("RGB")
    # Pictures turned by EXIF show as the other way round, so their size is given as seen.
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    return image, width, height


def region_tensors(image):
    """The regions of one picture as normalised 224 px tensors, squashed to a square as the model sees them."""
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    out = np.empty((len(REGIONS), 3, SIDE, SIDE), dtype=np.float32)
    for at, (left, top, right, bottom) in enumerate(REGIONS):
        box = (round(left * image.width), round(top * image.height), round(right * image.width), round(bottom * image.height))
        part = image.crop(box).resize((SIDE, SIDE), Image.BICUBIC)
        pixels = (np.asarray(part, dtype=np.float32) / 255.0 - mean) / std
        out[at] = pixels.transpose(2, 0, 1)
    return out


class Cache:
    """Embeddings and checked pairs from earlier runs, by path, size and time."""

    def __init__(self, path):
        self.path = path
        self.pictures = {}
        # Verdicts used to be a JSON dictionary inside the NPZ: hundreds of thousands of
        # repeated paths, dictionaries and a giant Unicode array when saved. Keep them on
        # disk instead. Old embeddings still work; legacy verdicts are recomputed once.
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.pairs = sqlite3.connect(f"{path}.pairs.sqlite3")
        self.pairs.execute("""CREATE TABLE IF NOT EXISTS verdicts (
            first BLOB, second BLOB, level TEXT, verdict INTEGER,
            PRIMARY KEY (first, second, level)) WITHOUT ROWID""")
        try:
            with np.load(path, allow_pickle=False) as data:
                if int(data["version"]) == CACHE_VERSION:
                    keys = data["keys"]
                    embeddings = data["embeddings"]
                    sizes = data["sizes"]
                    for at, key in enumerate(keys):
                        self.pictures[str(key)] = (embeddings[at], int(sizes[at][0]), int(sizes[at][1]))
        except (OSError, KeyError, ValueError):
            pass

    @staticmethod
    def pair_id(first, second):
        return sorted(hashlib.sha256(key.encode("utf-8")).digest() for key in (first, second))

    def verdict(self, first, second, level):
        row = self.pairs.execute("SELECT verdict FROM verdicts WHERE first=? AND second=? AND level=?",
                                 (*self.pair_id(first, second), level)).fetchone()
        return bool(row[0]) if row else None

    def remember(self, first, second, level, verdict):
        self.pairs.execute("INSERT OR REPLACE INTO verdicts VALUES (?, ?, ?, ?)",
                           (*self.pair_id(first, second), level, verdict))

    def checkpoint(self):
        self.pairs.commit()

    def close(self):
        self.checkpoint()
        self.pairs.close()

    def save(self, keep):
        keys = [key for key in keep if key in self.pictures]
        embeddings = np.stack([self.pictures[key][0] for key in keys]) if keys else np.zeros((0, len(REGIONS), 384), np.float16)
        sizes = np.array([[self.pictures[key][1], self.pictures[key][2]] for key in keys], dtype=np.int64).reshape(-1, 2)
        self.pairs.execute("CREATE TEMP TABLE IF NOT EXISTS wanted (id BLOB PRIMARY KEY) WITHOUT ROWID")
        self.pairs.execute("DELETE FROM wanted")
        self.pairs.executemany("INSERT INTO wanted VALUES (?)",
                               ((hashlib.sha256(key.encode("utf-8")).digest(),) for key in keys))
        self.pairs.execute("DELETE FROM verdicts WHERE first NOT IN (SELECT id FROM wanted) OR second NOT IN (SELECT id FROM wanted)")
        self.checkpoint()
        temporary = f"{self.path}.{os.getpid()}.tmp.npz"
        np.savez(temporary, version=CACHE_VERSION, keys=np.array(keys, dtype=str), embeddings=embeddings, sizes=sizes)
        os.replace(temporary, self.path)


def picture_key(picture):
    return f"{picture['path']}\t{picture['size']}\t{picture['modifiedMs']}"


def current_pictures(pictures):
    """Validate even cache hits: the store index can predate a deletion or edit."""
    current = []
    for picture in pictures:
        try:
            metadata = os.stat(picture["path"])
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode):
            current.append({**picture, "size": metadata.st_size, "modifiedMs": metadata.st_mtime_ns // 1_000_000})
    return current


def load_model():
    import timm
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = timm.create_model(MODEL, pretrained=True, num_classes=0, img_size=SIDE).eval().to(device)
    if device == "cuda":
        model = model.half()
    return model, device


def embed(pictures, cache, cancelled):
    """Adds the embeddings of the pictures the cache does not know yet."""
    missing = [picture for picture in pictures if picture_key(picture) not in cache.pictures]
    if not missing or cancelled():
        return
    progress("model", 0, 0)
    import torch
    model, device = load_model()
    dtype = torch.float16 if device == "cuda" else torch.float32
    total = len(missing)
    done = 0

    def prepare(picture):
        try:
            image, width, height = open_picture(picture["path"], SIDE * 2)
            return picture, region_tensors(image), width, height
        except Exception as error:  # A picture Pillow cannot read is left out, not the whole run.
            print(f"Cannot read {picture['path']}: {error}", file=sys.stderr)
            return picture, None, 0, 0

    pending = bounded_map(prepare, missing, cancelled)
    try:
        batch = []

        def run(batch):
            tensors = np.concatenate([regions for _, regions, _, _ in batch])
            with torch.inference_mode():
                features = model(torch.from_numpy(tensors).to(device, dtype))
                features = torch.nn.functional.normalize(features.float(), dim=1)
            features = features.cpu().numpy().astype(np.float16).reshape(len(batch), len(REGIONS), -1)
            for (picture, _, width, height), feature in zip(batch, features):
                cache.pictures[picture_key(picture)] = (feature, width, height)

        for picture, regions, width, height in pending:
            if cancelled():
                return
            done += 1
            if regions is not None:
                batch.append((picture, regions, width, height))
            if len(batch) >= BATCH_PICTURES:
                run(batch)
                batch = []
            if done % 16 == 0 or done == total:
                progress("embed", done, total)
        if batch and not cancelled():
            run(batch)
    finally:
        pending.close()


def candidates(keys, cache, level, cancelled):
    """Yield at most COMPARE_ROWS * NEIGHBOURS pairs, then let the verifier consume them.

    A reverse-direction candidate can occur in a later batch. Its verdict is reused from
    SQLite and its score merged by the consumer, without retaining all rejected candidates.
    """
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    count = len(keys)
    top = min(NEIGHBOURS, count - 1)
    if top <= 0:
        return
    # Tile both axes. Neither device embeddings nor the score matrix grows with the store size.
    for start in range(0, count, COMPARE_ROWS):
        if cancelled():
            return
        found = {}
        rows = torch.from_numpy(np.stack([cache.pictures[key][0][0] for key in keys[start:start + COMPARE_ROWS]])).to(device, dtype)
        values = torch.empty((len(rows), 0), device=device, dtype=dtype)
        indices = torch.empty((len(rows), 0), device=device, dtype=torch.long)
        for column in range(0, count, COMPARE_COLUMNS):
            if cancelled():
                return
            parts = torch.from_numpy(np.stack([cache.pictures[key][0] for key in keys[column:column + COMPARE_COLUMNS]])).to(device, dtype)
            columns, regions, width = parts.shape
            scores = (rows @ parts.reshape(-1, width).T).reshape(len(rows), columns, regions).amax(dim=2)
            overlap_start, overlap_end = max(start, column), min(start + len(rows), column + columns)
            if overlap_start < overlap_end:
                diagonal = torch.arange(overlap_start, overlap_end, device=device)
                scores[diagonal - start, diagonal - column] = -float("inf")
            block_values, block_indices = scores.topk(min(top, columns), dim=1)
            combined_values = torch.cat((values, block_values), dim=1)
            combined_indices = torch.cat((indices, block_indices + column), dim=1)
            values, positions = combined_values.topk(min(top, combined_values.shape[1]), dim=1)
            indices = combined_indices.gather(1, positions)
        for row, (row_values, row_indices) in enumerate(zip(values.tolist(), indices.tolist())):
            for value, other in zip(row_values, row_indices):
                if value < level["candidate"]:
                    break
                pair = (min(start + row, other), max(start + row, other))
                found[pair] = max(found.get(pair, -1.0), value)
        progress("compare", min(start + COMPARE_ROWS, count), count)
        yield found, min(start + COMPARE_ROWS, count)


class Keypoints:
    """ORB keypoints and reduced pictures in a byte-bounded least-recently-used cache."""

    def __init__(self, max_bytes=KEYPOINT_CACHE_BYTES):
        import cv2
        cv2.setNumThreads(1)
        self.cv2 = cv2
        self.lock = threading.Lock()
        self.found = OrderedDict()
        self.max_bytes = max_bytes
        self.bytes = 0

    @staticmethod
    def size(result):
        return sum(array.nbytes for array in result if array is not None)

    def of(self, path):
        with self.lock:
            if path in self.found:
                self.found.move_to_end(path)
                return self.found[path]
        cv2 = self.cv2
        try:
            image, _, _ = open_picture(path, 1024)
            image.thumbnail((1024, 1024), Image.BILINEAR)
            gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
            # One detector per call: OpenCV's are not safe to share between threads.
            points, descriptors = cv2.ORB_create(nfeatures=1500, fastThreshold=12).detectAndCompute(gray, None)
            result = (np.asarray(image), np.float32([point.pt for point in points]) if points else np.zeros((0, 2), np.float32), descriptors)
        except Exception as error:
            print(f"Cannot read {path}: {error}", file=sys.stderr)
            result = (None, np.zeros((0, 2), np.float32), None)
        with self.lock:
            # Another verifier may have loaded the same picture while this one was decoding.
            previous = self.found.pop(path, None)
            if previous is not None:
                self.bytes -= self.size(previous)
            size = self.size(result)
            if size <= self.max_bytes:
                while self.found and self.bytes + size > self.max_bytes:
                    _, evicted = self.found.popitem(last=False)
                    self.bytes -= self.size(evicted)
                self.found[path] = result
                self.bytes += size
        return result

    def forget(self, path):
        with self.lock:
            previous = self.found.pop(path, None)
            if previous is not None:
                self.bytes -= self.size(previous)


def blocks_agree(first, second, mask, level):
    """Whether two colour pictures of one size show the same thing, block by block, where the mask covers both.

    A brightness or contrast change is allowed for (one gain and offset for all channels), and so is a
    small area changed, such as a watermark or a retouch, but not pictures that share only part of their
    layout, like two screenshots of one program or two flags of one pattern.
    """
    import cv2
    # Softened first, so edges resampled a little differently in each copy do not count as changes.
    first = cv2.GaussianBlur(first.astype(np.float32), (0, 0), 1.0)
    second = cv2.GaussianBlur(second.astype(np.float32), (0, 0), 1.0)
    covered = mask[..., None].repeat(3, axis=2)
    x, y = first[covered], second[covered]
    spread = float(x.std())
    gain = float(np.clip(y.std() / spread, 0.75, 1.33)) if spread > 4 else 1.0
    offset = float(np.clip(y.mean() - gain * x.mean(), -40, 40))
    difference = np.abs(first * gain + offset - second).mean(axis=2)
    # Colour alone misses a changed text or dialog on a like background, so structure is compared too.
    from skimage.metrics import structural_similarity
    gray_first = first.mean(axis=2) * gain + offset
    gray_second = second.mean(axis=2)
    gray_first[~mask] = 0
    gray_second[~mask] = 0
    _, structure = structural_similarity(gray_first, gray_second, data_range=255, gaussian_weights=True, sigma=1.5, full=True)
    height, width = mask.shape
    step = max(8, round(max(height, width) / 16))
    agreeing = total = 0
    for top in range(0, height - step // 2, step):
        for left in range(0, width - step // 2, step):
            inside = mask[top:top + step, left:left + step]
            if inside.mean() < 0.9:
                continue
            total += 1
            if (float(difference[top:top + step, left:left + step][inside].mean()) < level["difference"]
                    and float(structure[top:top + step, left:left + step][inside].mean()) >= level["structure"]):
                agreeing += 1
    return total >= 12 and agreeing >= level["agreement"] * total


def overlap_agrees(cv2, image_a, image_b, matrix, level):
    """Lays the first picture over the second with the transform found and compares where they meet.

    Keypoints alone also line up on pictures that share a layout but not their content, such as two
    quotes set in one font on one background; the pixels themselves tell those apart.
    """
    height, width = image_b.shape[:2]
    shrink = min(1.0, 512 / max(height, width))
    size = (max(8, round(width * shrink)), max(8, round(height * shrink)))
    scaled = matrix * shrink
    warped = cv2.warpAffine(image_a, scaled, size, flags=cv2.INTER_AREA)
    cover = cv2.warpAffine(np.full(image_a.shape[:2], 255, np.uint8), scaled, size, flags=cv2.INTER_NEAREST)
    target = cv2.resize(image_b, size, interpolation=cv2.INTER_AREA)
    # Keep off the seam, where the warp blends with the black outside the picture.
    mask = cv2.erode((cover > 0).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    if mask.sum() < 0.04 * mask.size or mask.sum() < 400:
        return False
    return blocks_agree(warped, target, mask, level)


def same_picture(keypoints, first, second, level):
    """Whether one geometric transform maps many keypoints of one picture onto the other, and the
    pixels agree where it lays them over each other."""
    cv2 = keypoints.cv2
    image_a, points_a, descriptors_a = keypoints.of(first)
    image_b, points_b, descriptors_b = keypoints.of(second)
    if image_a is None or image_b is None:
        return False
    if descriptors_a is None or descriptors_b is None or len(points_a) < 40 or len(points_b) < 40:
        # Too plain for keypoints: compared whole, which only holds for pictures of one shape.
        shape_a = image_a.shape[1] / image_a.shape[0]
        shape_b = image_b.shape[1] / image_b.shape[0]
        if abs(shape_a / shape_b - 1) > 0.04:
            return False
        size = (128, max(8, round(128 / shape_b))) if shape_b >= 1 else (max(8, round(128 * shape_b)), 128)
        small_a = cv2.resize(image_a, size, interpolation=cv2.INTER_AREA)
        small_b = cv2.resize(image_b, size, interpolation=cv2.INTER_AREA)
        # Nothing is cropped here, so nearly every block has to agree.
        strict = {**level, "agreement": max(level["agreement"], 0.98), "structure": max(level["structure"], 0.7)}
        return blocks_agree(small_a, small_b, np.ones(small_b.shape[:2], bool), strict)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(descriptors_a, descriptors_b, k=2):
        if len(pair) == 2 and pair[0].distance < 0.8 * pair[1].distance:
            good.append(pair[0])
    if len(good) < level["inliers"]:
        return False
    source = points_a[[match.queryIdx for match in good]].reshape(-1, 1, 2)
    target = points_b[[match.trainIdx for match in good]].reshape(-1, 1, 2)
    # A similarity transform (scale, turn, shift) covers crops and resizes, and resists the
    # lookalike matches that a full homography can bend itself around.
    matrix, inliers = cv2.estimateAffinePartial2D(source, target, method=cv2.RANSAC, ransacReprojThreshold=6.0, maxIters=4000)
    if matrix is None or inliers is None:
        return False
    kept = int(inliers.sum())
    scale = float(np.hypot(matrix[0, 0], matrix[1, 0]))
    if kept < level["inliers"] or kept < 0.25 * len(good) or not 0.05 < scale < 20:
        return False
    return overlap_agrees(cv2, image_a, image_b, matrix, level)


def verify(pictures, keys, found, cache, level, cancelled, keypoints, pictures_done):
    """Verify one bounded batch; SQLite and progress are owned by the consuming thread."""
    def entries():
        # Keep shared pictures close together to reuse decoded keypoints.
        for first, second in sorted(found):
            yield first, second, cache.verdict(keys[first], keys[second], level["name"])

    def check(entry):
        first, second, cached = entry
        if cancelled():
            return None
        verdict = cached if cached is not None else bool(
            same_picture(keypoints, pictures[first]["path"], pictures[second]["path"], level))
        return first, second, verdict, cached is None

    total = len(found)
    last_checkpoint = last_progress = time.monotonic()
    pending = bounded_map(check, entries(), cancelled)
    try:
        progress("verify", 0, total, picturesDone=pictures_done, picturesTotal=len(pictures))
        for done, result in enumerate(pending, 1):
            if result is None:
                continue
            first, second, verdict, fresh = result
            if fresh:
                cache.remember(keys[first], keys[second], level["name"], verdict)
            now = time.monotonic()
            if done % CHECKPOINT_PAIRS == 0 or now - last_checkpoint >= RESULT_INTERVAL:
                cache.checkpoint()
                last_checkpoint = now
            # Cache hits can complete thousands of checks per second. Bound UI traffic too.
            if now - last_progress >= 0.1 or done == total:
                progress("verify", done, total, picturesDone=pictures_done, picturesTotal=len(pictures))
                last_progress = now
            yield (first, second), verdict
    finally:
        pending.close()
        cache.checkpoint()


def groups_of(count, pairs):
    """Disjoint groups in which EVERY pair passed verification.

    Matching is not transitive: two different crops can each match the original but not each other.
    A connected component is therefore unsafe when any member can be chosen as the keeper.
    """
    neighbours = [set() for _ in range(count)]
    for first, second in pairs:
        neighbours[first].add(second)
        neighbours[second].add(first)
    used = set()
    groups = []
    for first in sorted(range(count), key=lambda index: (-len(neighbours[index]), index)):
        if first in used:
            continue
        group = [first]
        for other in sorted(neighbours[first] - used):
            if all(other in neighbours[member] for member in group):
                group.append(other)
        if len(group) > 1:
            used.update(group)
            groups.append(sorted(group))
    return groups


def main():
    worker_protocol.configure_worker_output()
    with memory_guard():
        run_search()


def result_snapshot(pictures, keys, matched, cache, unreadable, partial):
    groups = []
    for group in groups_of(len(pictures), matched):
        members = []
        for index in group:
            _, width, height = cache.pictures[keys[index]]
            members.append({**pictures[index], "width": width, "height": height})
        score = min(matched[pair] for pair in combinations(group, 2))
        groups.append({"pictures": members, "similarity": round(float(score), 4)})
    groups.sort(key=lambda group: (-len(group["pictures"]), -group["similarity"]))
    return {"groups": groups, "pictures": len(pictures), "unreadable": unreadable, "partial": partial}


def run_search():
    with open(sys.argv[1], encoding="utf-8") as handle:
        request = json.load(handle)
    stop_file = request.get("stop")
    cancelled = (lambda: os.path.exists(stop_file)) if stop_file else (lambda: False)
    name = request.get("level") if request.get("level") in LEVELS else "normal"
    level = {**LEVELS[name], "name": f"{name}{CHECK_VERSION}"}
    cache = Cache(request["cache"])
    pictures = current_pictures(request["pictures"])
    publish = None
    try:
        embed(pictures, cache, cancelled)
        # Save embeddings before verification: a stopped/killed verifier must not lose them.
        cache.save([picture_key(picture) for picture in pictures])
        if cancelled():
            worker_protocol.emit({"ok": False, "error": "cancelled"})
            return
        pictures = current_pictures(pictures)
        known = [picture for picture in pictures if picture_key(picture) in cache.pictures]
        keys = [picture_key(picture) for picture in known]
        matched = {}
        last_publish = 0.0
        dirty = False

        def publish(partial=True, force=False):
            nonlocal last_publish, dirty
            if not force and (not dirty or time.monotonic() - last_publish < RESULT_INTERVAL):
                return
            snapshot = result_snapshot(known, keys, matched, cache, len(pictures) - len(known), partial)
            temporary = request["output"] + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(snapshot, handle)
            os.replace(temporary, request["output"])
            # Send only a notification; Rust reads the atomically replaced snapshot. Large
            # group lists cannot pile up in the worker's pipe or Rust's reader queue.
            worker_protocol.emit({"event": "results"})
            last_publish, dirty = time.monotonic(), False

        keypoints = Keypoints()
        for found, pictures_done in candidates(keys, cache, level, cancelled):
            for pair, verdict in verify(known, keys, found, cache, level, cancelled, keypoints, pictures_done):
                if verdict and found[pair] > matched.get(pair, -1):
                    matched[pair] = found[pair]
                    dirty = True
                publish()
            if cancelled():
                break
        publish(partial=cancelled(), force=True)
        worker_protocol.emit({"ok": False, "error": "cancelled"} if cancelled() else {"ok": True})
    except Exception as error:
        import traceback
        traceback.print_exc()
        if publish:
            try:
                publish(force=True)
            except Exception:
                traceback.print_exc()
        worker_protocol.emit({"ok": False, "error": str(error)})
    finally:
        cache.close()


if __name__ == "__main__":
    main()
