import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

import duplicates


def scene(seed, size=(900, 600)):
    """A picture with enough texture for keypoints: noise blobs, shapes and lines."""
    random = np.random.default_rng(seed)
    base = random.integers(0, 255, (size[1] // 20, size[0] // 20, 3), dtype=np.uint8)
    image = Image.fromarray(base).resize(size, Image.BICUBIC)
    draw = ImageDraw.Draw(image)
    for _ in range(60):
        x, y = random.integers(0, size[0]), random.integers(0, size[1])
        radius = int(random.integers(8, 60))
        colour = tuple(int(value) for value in random.integers(0, 255, 3))
        if random.random() < 0.5:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=colour, width=4)
        else:
            draw.rectangle((x - radius, y - radius, x + radius, y + radius), fill=colour)
    return image


class SamePictureTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.level = duplicates.LEVELS["normal"]

    def tearDown(self):
        self.folder.cleanup()

    def save(self, image, name, **options):
        path = os.path.join(self.folder.name, name)
        image.save(path, **options)
        return path

    def test_resized_recompressed_and_cropped_copies_match(self):
        original = scene(1)
        first = self.save(original, "original.png")
        smaller = self.save(original.resize((600, 400), Image.LANCZOS), "smaller.jpg", quality=70)
        cropped = self.save(original.crop((150, 100, 750, 520)), "cropped.jpg", quality=85)
        keypoints = duplicates.Keypoints()
        self.assertTrue(duplicates.same_picture(keypoints, first, smaller, self.level))
        self.assertTrue(duplicates.same_picture(keypoints, first, cropped, self.level))
        self.assertTrue(duplicates.same_picture(keypoints, cropped, smaller, self.level))

    def test_other_pictures_and_changed_content_do_not_match(self):
        original = scene(1)
        changed = original.copy()
        # The same layout with a third of it replaced, like two screenshots of one program.
        changed.paste(scene(3).crop((0, 0, 300, 600)), (600, 0))
        first = self.save(original, "original.png")
        other = self.save(scene(2), "other.png")
        edited = self.save(changed, "changed.png")
        keypoints = duplicates.Keypoints()
        self.assertFalse(duplicates.same_picture(keypoints, first, other, self.level))
        self.assertFalse(duplicates.same_picture(keypoints, first, edited, self.level))

    def test_groups_do_not_treat_matching_as_transitive(self):
        groups = sorted(sorted(group) for group in duplicates.groups_of(6, [(0, 1), (1, 2), (4, 5)]))
        self.assertEqual(groups, [[0, 1], [4, 5]])
        self.assertEqual(duplicates.groups_of(3, [(0, 1), (1, 2), (0, 2)]), [[0, 1, 2]])

    def test_every_group_is_disjoint_and_every_pair_was_verified(self):
        import itertools
        random = np.random.default_rng(15)
        pairs = {pair for pair in itertools.combinations(range(150), 2) if random.random() < 0.1}
        groups = duplicates.groups_of(150, pairs)
        members = [member for group in groups for member in group]
        self.assertEqual(len(members), len(set(members)))
        self.assertTrue(all(pair in pairs for group in groups for pair in itertools.combinations(group, 2)))

    def test_many_disjoint_groups(self):
        pairs = [(index, index + 1) for index in range(0, 40_000, 2)]
        self.assertEqual(duplicates.groups_of(40_000, pairs), [list(pair) for pair in pairs])

    def test_animations_are_not_compared_using_only_the_first_frame(self):
        path = self.save(Image.new("RGB", (32, 32), "red"), "animation.gif", save_all=True,
                         append_images=[Image.new("RGB", (32, 32), "blue")], duration=100)
        with self.assertRaisesRegex(ValueError, "frame-by-frame"):
            duplicates.open_picture(path, 32)


class CacheLifecycleTests(unittest.TestCase):
    def test_deleted_cached_pictures_do_not_return_and_cache_is_pruned(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "deleted.png")
            Image.new("RGB", (20, 20)).save(path)
            pictures = duplicates.current_pictures([{"path": path}])
            key = duplicates.picture_key(pictures[0])
            cache = duplicates.Cache(os.path.join(folder, "cache.npz"))
            cache.pictures[key] = (np.zeros((len(duplicates.REGIONS), 384), np.float16), 20, 20)
            cache.remember(key, key, "normal5", True)
            cache.save([key])
            cache.close()
            os.remove(path)
            request_path = os.path.join(folder, "request.json")
            output = os.path.join(folder, "output.json")
            with open(request_path, "w") as handle:
                json.dump({"pictures": pictures, "cache": cache.path, "output": output}, handle)
            with patch("sys.argv", ["duplicates.py", request_path]), patch.object(duplicates, "load_model") as model, \
                    patch.object(duplicates.worker_protocol, "configure_worker_output"), patch.object(duplicates.worker_protocol, "emit"):
                duplicates.main()
                model.assert_not_called()
            with open(output) as handle:
                self.assertEqual(json.load(handle), {"groups": [], "pictures": 0, "unreadable": 0, "partial": False})
            loaded = duplicates.Cache(cache.path)
            self.assertEqual(loaded.pictures, {})
            self.assertEqual(loaded.pairs.execute("SELECT COUNT(*) FROM verdicts").fetchone()[0], 0)
            loaded.close()

    def test_edited_files_get_fresh_cache_keys_and_directories_are_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "edited.png")
            Image.new("RGB", (20, 20)).save(path)
            old = duplicates.current_pictures([{"path": path}])[0]
            with open(path, "ab") as handle:
                handle.write(b"changed")
            current = duplicates.current_pictures([old, {"path": folder}])
            self.assertEqual(len(current), 1)
            self.assertNotEqual(duplicates.picture_key(old), duplicates.picture_key(current[0]))


class StreamingTests(unittest.TestCase):
    def test_partial_results_survive_stop_and_reuse_completed_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            pictures = []
            cache_path = os.path.join(folder, "cache.npz")
            cache = duplicates.Cache(cache_path)
            for index in range(3):
                path = os.path.join(folder, f"{index}.png")
                Image.new("RGB", (20, 20)).save(path)
                picture = duplicates.current_pictures([{"path": path}])[0]
                pictures.append(picture)
                cache.pictures[duplicates.picture_key(picture)] = (np.zeros((7, 8), np.float16), 20, 20)
            cache.save([duplicates.picture_key(picture) for picture in pictures])
            cache.close()
            output = os.path.join(folder, "output.json")
            stop = os.path.join(folder, "stop")
            request = os.path.join(folder, "request.json")
            with open(request, "w") as handle:
                json.dump({"pictures": pictures, "cache": cache_path, "output": output, "stop": stop}, handle)
            snapshots = []

            def emitted(message):
                if message.get("event") == "results":
                    with open(output) as handle:
                        snapshots.append(json.load(handle))

            def batches(*args):
                yield {(0, 1): 0.9}, 1
                # The first group must be visible BEFORE the next batch is requested.
                self.assertEqual(len(snapshots), 1)
                self.assertTrue(snapshots[0]["partial"])
                self.assertEqual(len(snapshots[0]["groups"][0]["pictures"]), 2)
                with open(stop, "w"):
                    pass
                yield {(0, 2): 0.8}, 3

            with patch("sys.argv", ["duplicates.py", request]), \
                    patch.object(duplicates, "candidates", side_effect=batches), \
                    patch.object(duplicates, "same_picture", return_value=True) as check, \
                    patch.object(duplicates.worker_protocol, "emit", side_effect=emitted):
                duplicates.run_search()
                self.assertEqual(check.call_count, 1)
            self.assertTrue(snapshots[-1]["partial"])
            os.remove(stop)
            # Starting again reuses the durable verdict, even for the reverse direction.
            with patch("sys.argv", ["duplicates.py", request]), \
                    patch.object(duplicates, "candidates", return_value=iter([({(0, 1): 0.95}, 3)])), \
                    patch.object(duplicates, "same_picture", side_effect=AssertionError("Should reuse saved check")) as check, \
                    patch.object(duplicates.worker_protocol, "emit", side_effect=emitted):
                duplicates.run_search()
                check.assert_not_called()
            self.assertFalse(snapshots[-1]["partial"])
            self.assertEqual(snapshots[-1]["groups"][0]["similarity"], 0.95)

    def test_disk_verdicts_are_symmetric_versioned_and_checkpointed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "cache.npz")
            first = duplicates.Cache(path)
            first.remember("a", "b", "loose6", False)
            first.remember("a", "c", "loose6", True)
            first.checkpoint()
            second = duplicates.Cache(path)
            self.assertIs(second.verdict("b", "a", "loose6"), False)
            self.assertIs(second.verdict("c", "a", "loose6"), True)
            self.assertIsNone(second.verdict("a", "c", "normal6"))
            self.assertIsNone(second.verdict("a-changed", "c", "loose6"))
            first.close()
            second.close()

    def test_partial_groups_never_use_unverified_transitive_matches(self):
        pictures = [{"path": str(index)} for index in range(3)]
        keys = ["0", "1", "2"]
        cache = SimpleNamespace(pictures={key: (None, 10, 10) for key in keys})
        matched = {(0, 1): 0.9, (1, 2): 0.8}
        snapshot = duplicates.result_snapshot(pictures, keys, matched, cache, 0, True)
        self.assertEqual(len(snapshot["groups"]), 1)
        self.assertEqual(len(snapshot["groups"][0]["pictures"]), 2)
        matched[(0, 2)] = 0.85
        snapshot = duplicates.result_snapshot(pictures, keys, matched, cache, 0, False)
        self.assertEqual(len(snapshot["groups"][0]["pictures"]), 3)
        self.assertEqual(snapshot["groups"][0]["similarity"], 0.8)

    def test_error_preserves_completed_verdicts_and_cached_checks_do_not_flood_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "cache.npz")
            cache = duplicates.Cache(path)
            pictures = [{"path": str(index)} for index in range(101)]
            keys = [picture["path"] for picture in pictures]
            found = {(0, index): 0.9 for index in range(1, 101)}
            level = {"name": "loose6"}

            def check(_, first, second, level):
                if second == "100":
                    raise RuntimeError("Decoder failed")
                return True

            with patch.object(duplicates, "same_picture", side_effect=check), patch.object(duplicates, "progress"):
                with self.assertRaisesRegex(RuntimeError, "Decoder failed"):
                    list(duplicates.verify(pictures, keys, found, cache, level, lambda: False, None, 101))
            # Even an unexpected decoder failure commits the already consumed results.
            cache.close()
            cache = duplicates.Cache(path)
            self.assertIs(cache.verdict("0", "99", "loose6"), True)
            self.assertIsNone(cache.verdict("0", "100", "loose6"))
            del found[(0, 100)]
            with patch.object(duplicates, "same_picture") as check, \
                    patch.object(duplicates.time, "monotonic", return_value=1), \
                    patch.object(duplicates, "progress") as progress:
                self.assertEqual(len(list(duplicates.verify(pictures, keys, found, cache, level, lambda: False, None, 101))), 99)
                check.assert_not_called()
                self.assertEqual(progress.call_count, 2)  # Initial and final counts only.
            cache.close()


class MemoryBoundsTests(unittest.TestCase):
    def test_embedding_runs_small_batches_and_keeps_every_result(self):
        import torch
        pictures = [{"path": str(index), "size": 1, "modifiedMs": 1} for index in range(11)]
        cache = SimpleNamespace(pictures={})
        batches = []

        def model(tensors):
            batches.append(len(tensors))
            return tensors.mean(dim=(2, 3))

        with patch.object(duplicates, "load_model", return_value=(model, "cpu")), \
                patch.object(duplicates, "open_picture", side_effect=lambda *args: (Image.new("RGB", (32, 24)), 32, 24)), \
                patch.object(duplicates, "progress"):
            duplicates.embed(pictures, cache, lambda: False)
        self.assertEqual(len(cache.pictures), len(pictures))
        self.assertEqual(sum(batches), len(pictures) * len(duplicates.REGIONS))
        self.assertLessEqual(max(batches), duplicates.BATCH_PICTURES * len(duplicates.REGIONS))
        for feature, width, height in cache.pictures.values():
            self.assertEqual(feature.shape, (len(duplicates.REGIONS), 3))
            self.assertEqual((width, height), (32, 24))
            self.assertEqual(feature.dtype, np.float16)

    def test_slow_consumer_only_prefetches_a_fixed_window(self):
        submitted = []
        all_prepared = threading.Event()
        lock = threading.Lock()
        completed = 0

        def source():
            for index in range(10_000):
                submitted.append(index)
                yield index

        def prepare(index):
            nonlocal completed
            with lock:
                completed += 1
                if completed == duplicates.PREFETCH_PICTURES:
                    all_prepared.set()
            return index

        stopped = threading.Event()
        pending = duplicates.bounded_map(prepare, source(), stopped.is_set)
        try:
            self.assertEqual(next(pending), 0)
            # The consumer is paused while every prefetched job finishes.
            self.assertTrue(all_prepared.wait(5))
            self.assertEqual(len(submitted), duplicates.PREFETCH_PICTURES)
            stopped.set()
            self.assertEqual(list(pending), [])
            self.assertEqual(len(submitted), duplicates.PREFETCH_PICTURES)
        finally:
            pending.close()

    def test_cancelled_search_never_starts_decoding(self):
        with patch.object(duplicates, "open_picture") as decode:
            self.assertEqual(list(duplicates.bounded_map(decode, range(10_000), lambda: True)), [])
            decode.assert_not_called()

    def test_keypoint_cache_evicts_and_reloads_without_exceeding_budget(self):
        pixels = np.random.default_rng(4).integers(0, 255, (128, 128, 3), dtype=np.uint8)
        with patch.object(duplicates, "open_picture", side_effect=lambda *args: (Image.fromarray(pixels), 128, 128)) as decode:
            cache = duplicates.Keypoints()
            first = cache.of("first")
            cache.max_bytes = cache.size(first) * 2
            second = cache.of("second")
            self.assertIs(cache.of("first"), first)
            cache.of("third")
            self.assertNotIn("second", cache.found)
            self.assertLessEqual(cache.bytes, cache.max_bytes)
            reloaded = cache.of("second")
            np.testing.assert_array_equal(reloaded[0], second[0])
            self.assertEqual(decode.call_count, 4)
            cache.forget("second")
            self.assertEqual(cache.bytes, sum(cache.size(entry) for entry in cache.found.values()))

    def test_concurrent_keypoint_loads_account_for_shared_entries_once(self):
        barrier = threading.Barrier(2)

        def decode(*args):
            barrier.wait(timeout=5)
            return Image.new("RGB", (32, 32)), 32, 32

        cache = duplicates.Keypoints()
        with patch.object(duplicates, "open_picture", side_effect=decode), ThreadPoolExecutor(2) as pool:
            list(pool.map(cache.of, ["same", "same"]))
        self.assertEqual(cache.bytes, cache.size(cache.found["same"]))
        cache.forget("same")
        self.assertEqual(cache.bytes, 0)

    def test_decode_reduces_pixels_and_preserves_upright_source_dimensions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "portrait.png")
            exif = Image.Exif()
            exif[0x0112] = 6
            Image.new("RGB", (1200, 800)).save(path, exif=exif)
            image, width, height = duplicates.open_picture(path, 128)
            self.assertLessEqual(max(image.size), 128)
            self.assertEqual((width, height), (800, 1200))
            self.assertLess(image.width, image.height)
            with patch.object(duplicates, "MAX_SOURCE_PIXELS", 100):
                with self.assertRaisesRegex(ValueError, "pixel limit"):
                    duplicates.open_picture(path, 128)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux memory watchdog")
    def test_memory_guard_exits_worker_with_actionable_error(self):
        process = subprocess.run(
            [sys.executable, "-c", "import time, duplicates; duplicates.MEMORY_LIMIT_BYTES = 1\n"
             "with duplicates.memory_guard(): time.sleep(10)"],
            cwd=os.path.dirname(__file__), capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertIn("stopped to protect system memory", process.stdout)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux worker lifecycle")
    def test_worker_exits_when_its_desktop_parent_is_gone(self):
        process = subprocess.run(
            [sys.executable, "-c", "import time, duplicates\nwith duplicates.memory_guard(): time.sleep(10)"],
            cwd=os.path.dirname(__file__), capture_output=True, text=True, timeout=15,
            env={**os.environ, "INPAINT_DUPLICATES_PARENT_PID": "0"},
        )
        self.assertEqual(process.returncode, 1, process.stderr)


class CandidateTests(unittest.TestCase):
    def test_tiled_search_matches_exhaustive_search_across_tile_boundaries(self):
        import torch
        random = np.random.default_rng(7)
        embeddings = random.normal(size=(37, len(duplicates.REGIONS), 16)).astype(np.float32)
        embeddings /= np.linalg.norm(embeddings, axis=2, keepdims=True)
        embeddings = embeddings.astype(np.float16)
        keys = [str(index) for index in range(len(embeddings))]
        cache = SimpleNamespace(pictures={key: (embedding, 10, 10) for key, embedding in zip(keys, embeddings)})
        tensor = torch.from_numpy(embeddings).float()
        scores = (tensor[:, 0] @ tensor.reshape(-1, 16).T).reshape(37, 37, -1).amax(dim=2)
        scores.fill_diagonal_(-float("inf"))
        values, indices = scores.topk(duplicates.NEIGHBOURS, dim=1)
        level = {"candidate": 0.4}
        expected = {}
        for first, (row_values, row_indices) in enumerate(zip(values.tolist(), indices.tolist())):
            for value, second in zip(row_values, row_indices):
                if value >= level["candidate"]:
                    pair = tuple(sorted((first, second)))
                    expected[pair] = max(expected.get(pair, -1), value)
        with patch.object(torch.cuda, "is_available", return_value=False), \
                patch.object(duplicates, "COMPARE_ROWS", 5), patch.object(duplicates, "COMPARE_COLUMNS", 7), \
                patch.object(duplicates, "progress"):
            found = {}
            for batch, done in duplicates.candidates(keys, cache, level, lambda: False):
                self.assertLessEqual(len(batch), 5 * duplicates.NEIGHBOURS)
                self.assertLessEqual(done, len(keys))
                for pair, score in batch.items():
                    found[pair] = max(found.get(pair, -1), score)
            self.assertEqual(set(found), set(expected))
            for pair in found:
                self.assertAlmostEqual(found[pair], expected[pair], places=5)
            self.assertEqual(list(duplicates.candidates(keys, cache, level, lambda: True)), [])
            self.assertEqual(list(duplicates.candidates([], cache, level, lambda: False)), [])
            self.assertEqual(list(duplicates.candidates(keys[:1], cache, level, lambda: False)), [])


if __name__ == "__main__":
    unittest.main()
