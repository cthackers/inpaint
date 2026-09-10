import tempfile
from pathlib import Path
import unittest
from unittest import mock

import numpy as np
from PIL import Image
import torch

import restore
from restore import DetailRestorer


class FakeNetwork:
    """Stands in for a spandrel model: enlarges by `scale` with nearest neighbour, then applies `change`."""

    def __init__(self, calls, name, scale=1, change=lambda tensor: tensor, largest=None):
        self.calls, self.name, self.scale, self.change, self.largest = calls, name, scale, change, largest

    def to(self, device):
        return self

    def __call__(self, tensor):
        if self.largest and max(tensor.shape[-2:]) > self.largest:
            raise torch.cuda.OutOfMemoryError("full")
        self.calls.append((self.name, tuple(tensor.shape[-2:])))
        if self.scale != 1:
            tensor = torch.nn.functional.interpolate(tensor, scale_factor=self.scale, mode="nearest")
        return self.change(tensor)


def restorer(networks, device="cpu"):
    model = DetailRestorer.__new__(DetailRestorer)
    model.networks = networks
    model.device = torch.device(device)
    model.tile_scale = 1.0
    return model


# Small tiles, so a test picture spans several overlapping tiles.
SMALL_TILES = {name: (label, file, url, 16, scale) for name, (label, file, url, _, scale) in restore.NETWORKS.items()}


class RestoreTests(unittest.TestCase):
    def setUp(self):
        patches = [mock.patch.dict(restore.NETWORKS, SMALL_TILES), mock.patch.object(restore, "MIN_TILE", 8),
                   mock.patch.object(restore, "progress", lambda *args: None)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.input, self.output = Path(self.directory.name) / "in.png", Path(self.directory.name) / "out.png"
        self.pixels = np.random.default_rng(5).integers(0, 256, size=(23, 37, 4), dtype=np.uint8)
        Image.fromarray(self.pixels, "RGBA").save(self.input)

    def result(self):
        with Image.open(self.output) as output:
            self.assertEqual(output.size, (37, 23))
            np.testing.assert_array_equal(np.array(output.getchannel("A")), self.pixels[:, :, 3])
            return np.array(output.convert("RGB")).astype(int)

    def test_overlapping_tiles_reassemble_the_picture_exactly(self):
        calls = []
        restorer({"fbcnn": FakeNetwork(calls, "fbcnn")}).restore(self.input, self.output, "jpeg")
        np.testing.assert_array_equal(self.result(), self.pixels[:, :, :3])
        self.assertGreater(len(calls), 4)
        self.assertTrue(all(max(size) <= 16 for _, size in calls))

    def test_modes_run_their_networks_in_order_and_shrink_enlarged_output(self):
        # A smooth picture, which enlarging with nearest neighbour and shrinking back leaves nearly unchanged.
        y, x = np.mgrid[0:23, 0:37]
        self.pixels[:, :, :3] = np.stack([x * 6, y * 10, x * 3 + y * 5], axis=2)
        Image.fromarray(self.pixels, "RGBA").save(self.input)
        calls = []
        networks = {
            "fbcnn": FakeNetwork(calls, "fbcnn", change=lambda tensor: tensor * 0.5),
            "realesrgan": FakeNetwork(calls, "realesrgan", scale=2),
        }
        restorer(networks).restore(self.input, self.output, "compressed")
        names = [name for name, _ in calls]
        self.assertEqual(names, sorted(names), "all JPEG cleanup tiles run before the detail network")
        self.assertEqual(set(names), {"fbcnn", "realesrgan"})
        np.testing.assert_allclose(self.result(), self.pixels[:, :, :3] * 0.5, atol=2)

    def test_strength_blends_with_the_original_and_zero_skips_the_networks(self):
        calls = []
        networks = {"scunet": FakeNetwork(calls, "scunet", change=torch.zeros_like)}
        restorer(networks).restore(self.input, self.output, "noise", strength=0.25)
        np.testing.assert_allclose(self.result(), self.pixels[:, :, :3] * 0.75, atol=0.51)
        calls.clear()
        restorer(networks).restore(self.input, self.output, "noise", strength=0)
        self.assertEqual(calls, [])
        np.testing.assert_array_equal(self.result(), self.pixels[:, :, :3])

    def test_invalid_requests_are_refused(self):
        model = restorer({})
        with self.assertRaises(ValueError):
            model.restore(self.input, self.output, "defocus")
        for strength in [-0.1, 1.5, float("nan")]:
            with self.assertRaises(ValueError):
                model.restore(self.input, self.output, "jpeg", strength)

    @unittest.skipUnless(torch.cuda.is_available(), "needs a CUDA device")
    def test_running_out_of_gpu_memory_retries_with_smaller_tiles(self):
        calls = []
        model = restorer({"fbcnn": FakeNetwork(calls, "fbcnn", largest=8)}, device="cuda")
        model.restore(self.input, self.output, "jpeg")
        self.assertEqual(model.tile_scale, 0.5)
        np.testing.assert_array_equal(self.result(), self.pixels[:, :, :3])


if __name__ == "__main__":
    unittest.main()
