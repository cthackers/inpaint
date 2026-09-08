import tempfile
from pathlib import Path
import unittest

import numpy as np
from PIL import Image
import torch

from upscale import GeneralUpscaler, HatUpscaler, LanczosUpscaler


class UpscaleTests(unittest.TestCase):
    def test_denoise_interpolates_weights_without_replacing_network(self):
        from types import SimpleNamespace
        model = GeneralUpscaler.__new__(GeneralUpscaler)
        network = torch.nn.Linear(2, 1, bias=False)
        model.plugin = SimpleNamespace(model=SimpleNamespace(model=network))
        model.strong = {"weight": torch.tensor([[1.0, 0.0]])}
        model.weak = {"weight": torch.tensor([[0.0, 1.0]])}
        model.strength = None
        for strength, expected in [(0, [0, 1]), (1, [1, 0]), (0.25, [0.25, 0.75]), (0, [0, 1])]:
            model.set_denoise(strength)
            self.assertIs(model.plugin.model.model, network)
            torch.testing.assert_close(network.weight[0], torch.tensor(expected, dtype=torch.float32))
        torch.testing.assert_close(model.strong["weight"], torch.tensor([[1.0, 0.0]]))
        for invalid in [-1, 2, float("nan")]:
            with self.assertRaises(ValueError):
                model.set_denoise(invalid)

    def test_tiled_output_covers_odd_sizes_and_preserves_alpha(self):
        class NearestModel:
            scale = 4
            def __call__(self, tensor):
                return torch.nn.functional.interpolate(tensor, scale_factor=4, mode="nearest")

        model = HatUpscaler.__new__(HatUpscaler)
        model.model = NearestModel()
        model.device = torch.device("cpu")
        model.tile_size = 16
        model.tile_pad = 16
        pixels = np.random.default_rng(7).integers(0, 256, size=(19, 35, 4), dtype=np.uint8)
        source = Image.fromarray(pixels, "RGBA")
        with tempfile.TemporaryDirectory() as directory:
            input_path, output_path = Path(directory) / "in.png", Path(directory) / "out.png"
            source.save(input_path)
            for scale in [2, 3, 4]:
                model.upscale(input_path, output_path, scale)
                with Image.open(output_path) as output:
                    self.assertEqual(output.size, (35 * scale, 19 * scale))
                    alpha = source.getchannel("A").resize(output.size, Image.Resampling.LANCZOS)
                    np.testing.assert_array_equal(np.array(output.getchannel("A")), np.array(alpha))
                    expected = Image.fromarray(np.repeat(np.repeat(pixels[:, :, :3], 4, axis=0), 4, axis=1))
                    if scale != 4:
                        expected = expected.resize(output.size, Image.Resampling.LANCZOS)
                    np.testing.assert_array_equal(np.array(output.convert("RGB")), np.array(expected))

    def test_lanczos_matches_standard_resize_including_palette_transparency(self):
        source = Image.new("P", (7, 5))
        source.putpalette([255, 0, 0, 0, 255, 0] + [0] * 762)
        source.putpixel((3, 2), 1)
        source.info["transparency"] = 0
        with tempfile.TemporaryDirectory() as directory:
            input_path, output_path = Path(directory) / "in.png", Path(directory) / "out.png"
            source.save(input_path)
            LanczosUpscaler().upscale(input_path, output_path, 3)
            with Image.open(output_path) as output:
                expected = source.convert("RGBA").resize((21, 15), Image.Resampling.LANCZOS)
                np.testing.assert_array_equal(np.array(output), np.array(expected))


if __name__ == "__main__":
    unittest.main()
