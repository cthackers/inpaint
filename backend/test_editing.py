import tempfile
import unittest
from pathlib import Path

from PIL import Image

from editing import edit_image


class DownscaleTests(unittest.TestCase):
    def run_resize(self, image, **options):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder, "in.png"), Path(folder, "out.png")
            image.save(source)
            edit_image(source, output, {"kind": "resize", **options})
            with Image.open(output) as result:
                return result.convert("RGBA").copy()

    def test_longest_side_shrinks_and_keeps_the_shape(self):
        result = self.run_resize(Image.new("RGBA", (4000, 1000), (200, 40, 40, 255)), longest=1000, filter="lanczos")
        self.assertEqual(result.size, (1000, 250))

    def test_every_filter_keeps_transparency(self):
        image = Image.new("RGBA", (600, 400), (0, 0, 0, 0))
        image.paste((30, 200, 30, 255), (100, 100, 500, 300))
        for name in ("lanczos", "bicubic", "hamming", "bilinear", "box"):
            result = self.run_resize(image, longest=300, filter=name)
            self.assertEqual(result.size, (300, 200), name)
            self.assertEqual(result.getpixel((5, 5))[3], 0, name)
            self.assertEqual(result.getpixel((150, 100)), (30, 200, 30, 255), name)

    def test_a_smaller_picture_is_left_as_it_is(self):
        result = self.run_resize(Image.new("RGBA", (800, 600), (1, 2, 3, 255)), longest=1920, filter="box")
        self.assertEqual(result.size, (800, 600))

    def test_unknown_filters_and_sizes_are_refused(self):
        with self.assertRaises(ValueError):
            self.run_resize(Image.new("RGBA", (100, 100)), longest=50, filter="nearest")
        with self.assertRaises(ValueError):
            self.run_resize(Image.new("RGBA", (100, 100)), longest=4, filter="box")



class SmartSelectionMarginTests(unittest.TestCase):
    def test_margin_follows_the_picture_size_within_limits(self):
        from advanced import select_margin
        self.assertEqual(select_margin(600, 400), 7)
        self.assertEqual(select_margin(4000, 3000), 48)
        self.assertEqual(select_margin(120, 80), 4)
        self.assertEqual(select_margin(80, 2000), 24)



class WatermarkMaskTests(unittest.TestCase):
    def test_boxes_are_clipped_filtered_by_size_and_grown(self):
        from watermark import accepted_boxes, box_mask, checked_prompts, DEFAULT_PROMPTS
        boxes = accepted_boxes([[-10, 90, 30, 110], [0, 0, 600, 400], [50, 50, 50, 80]], 600, 400, 10)
        self.assertEqual(boxes, [(0, 90, 30, 110)])
        mask = box_mask(boxes, 600, 400)
        self.assertEqual(mask.size, (600, 400))
        # Grown by the smart-selection margin (7 px here) around the clipped box.
        self.assertEqual(mask.getpixel((36, 100)), 255)
        self.assertEqual(mask.getpixel((40, 100)), 0)
        self.assertEqual(mask.getpixel((10, 83)), 255)
        self.assertEqual(mask.getpixel((10, 82)), 0)
        self.assertEqual(checked_prompts(None), DEFAULT_PROMPTS)
        self.assertEqual(checked_prompts([" logo ", "logo", "text"]), ["logo", "text"])
        with self.assertRaises(ValueError):
            checked_prompts([])


if __name__ == "__main__":
    unittest.main()
