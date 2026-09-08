"""Worker protocol/cache regression tests without downloading or running models."""

import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import inpaint
from face_swap import FaceSwap


def image_request(model="lama"):
    return dict(command="inpaint", model=model, input="in.png", mask="mask.png", output="out.png")


def plugin_request(plugin, option="", scale=2):
    request = dict(command="plugin", plugin=plugin, option=option, scale=scale,
                   input="in.png", output="out.png")
    if plugin == "face_swap":
        request["donor"] = "donor.png"
    return request


class WorkerCacheTests(unittest.TestCase):
    def run_worker(self, requests, *, load_model=None, process_image=None):
        output = io.StringIO()
        stream = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
        with (
            patch.object(inpaint.sys, "stdin", stream),
            patch.object(inpaint.sys, "stdout", output),
            patch.object(inpaint, "configure_cache"),
            patch.object(inpaint, "release_memory") as release,
            patch.object(inpaint, "load_model", side_effect=load_model or (lambda _: object())) as models,
            patch.object(inpaint, "load_plugin", side_effect=lambda name, option: (object(), name)) as plugins,
            patch.object(inpaint, "process_image", side_effect=process_image) as images,
            patch.object(inpaint, "process_plugin") as enhancements,
        ):
            inpaint.worker_main(Path("unused"))
        release.assert_called_once_with()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(messages.pop(0), {"ready": True})
        return messages, models, plugins, images, enhancements

    def test_switching_tools_and_variants_reuses_every_instance(self):
        sequence = [
            image_request(),
            plugin_request("gfpgan"),
            plugin_request("realesrgan", "photo"),
            plugin_request("remove_bg", "general"),
            image_request("mat"),
            plugin_request("realesrgan", "anime"),
            plugin_request("remove_bg", "human"),
        ]
        messages, models, plugins, images, enhancements = self.run_worker(
            sequence + sequence + [plugin_request("realesrgan", "photo", scale=4)]
        )
        self.assertTrue(all(message["ok"] for message in messages))
        self.assertEqual(models.call_count, 2)
        self.assertEqual(plugins.call_count, 5)
        self.assertEqual(messages[-1]["models"], ["lama", "mat"])
        self.assertEqual(len(messages[-1]["plugins"]), 5)
        for index in range(2):
            self.assertIs(images.call_args_list[index].args[1], images.call_args_list[index + 2].args[1])
        for index in range(5):
            self.assertIs(enhancements.call_args_list[index].args[1], enhancements.call_args_list[index + 5].args[1])
        self.assertIs(enhancements.call_args_list[1].args[1], enhancements.call_args_list[-1].args[1])

    def test_failed_load_preserves_cache_and_can_retry(self):
        messages, models, _, images, _ = self.run_worker(
            [image_request(), image_request("mat"), image_request(), image_request("mat")],
            load_model=[object(), RuntimeError("load failed"), object()],
        )
        self.assertFalse(messages[1]["ok"])
        self.assertEqual(messages[1]["models"], ["lama"])
        self.assertEqual(models.call_count, 3)
        self.assertIs(images.call_args_list[0].args[1], images.call_args_list[1].args[1])
        self.assertTrue(messages[-1]["ok"])

    def test_inference_error_still_reports_loaded_model(self):
        messages, models, _, images, _ = self.run_worker(
            [image_request(), image_request()],
            process_image=[RuntimeError("inference failed"), None],
        )
        self.assertFalse(messages[0]["ok"])
        self.assertEqual(messages[0]["models"], ["lama"])
        self.assertTrue(messages[1]["ok"])
        self.assertEqual(models.call_count, 1)
        self.assertIs(images.call_args_list[0].args[1], images.call_args_list[1].args[1])

    def test_shutdown_stops_processing(self):
        messages, models, _, _, _ = self.run_worker(
            [image_request(), {"command": "shutdown"}, image_request("mat")]
        )
        self.assertEqual(len(messages), 1)
        models.assert_called_once_with("lama")

    def test_face_swap_reuses_model_with_different_source_photos(self):
        first = plugin_request("face_swap")
        second = dict(first, donor="another.png")
        messages, _, plugins, _, enhancements = self.run_worker(
            [first, plugin_request("gfpgan"), second]
        )
        self.assertTrue(all(message["ok"] for message in messages))
        self.assertEqual(plugins.call_count, 2)
        self.assertEqual(messages[-1]["plugins"], ["face_swap", "gfpgan"])
        self.assertIs(enhancements.call_args_list[0].args[1], enhancements.call_args_list[2].args[1])
        self.assertEqual(enhancements.call_args_list[2].args[-1], Path("another.png"))
        restorer = enhancements.call_args_list[1].args[1]
        self.assertIs(enhancements.call_args_list[0].kwargs["face_restorer"], restorer)
        self.assertIs(enhancements.call_args_list[2].kwargs["face_restorer"], restorer)
        self.assertEqual(messages[0]["plugins"], ["face_swap", "gfpgan"])

    def test_face_swap_reuses_previously_loaded_gfpgan(self):
        messages, _, plugins, _, enhancements = self.run_worker([
            plugin_request("gfpgan"), plugin_request("face_swap"),
        ])
        self.assertTrue(all(message["ok"] for message in messages))
        self.assertEqual(plugins.call_count, 2)
        self.assertIs(enhancements.call_args_list[0].args[1],
                      enhancements.call_args_list[1].kwargs["face_restorer"])

    def test_face_restoration_failure_aborts_plugin_operation(self):
        model = Mock()
        model.replace.side_effect = RuntimeError("restoration failed")
        restorer = object()
        with self.assertRaisesRegex(RuntimeError, "restoration failed"):
            inpaint.process_plugin("face_swap", model, Path("in.png"), Path("out.png"),
                                   1, Path("donor.png"), face_restorer=restorer)
        model.replace.assert_called_once_with(Path("in.png"), Path("donor.png"),
                                              Path("out.png"), restorer)

    def test_face_swap_requires_source_before_loading(self):
        request = plugin_request("face_swap")
        request.pop("donor")
        messages, _, plugins, _, enhancements = self.run_worker([request])
        self.assertFalse(messages[0]["ok"])
        self.assertIn("Select a source photo", messages[0]["error"])
        plugins.assert_not_called()
        enhancements.assert_not_called()

    def test_upscalers_and_denoise_settings_reuse_cached_models(self):
        general = plugin_request("realesrgan", "realesr-general-x4v3")
        messages, _, plugins, _, enhancements = self.run_worker([
            dict(general, denoise=0), plugin_request("hat"),
            plugin_request("lanczos"), dict(general, denoise=1),
            dict(general, denoise=0.25), plugin_request("hat"),
        ])
        self.assertTrue(all(message["ok"] for message in messages))
        self.assertEqual(plugins.call_count, 3)
        self.assertIs(enhancements.call_args_list[0].args[1], enhancements.call_args_list[3].args[1])
        self.assertEqual(enhancements.call_args_list[4].kwargs["denoise"], 0.25)
        self.assertIs(enhancements.call_args_list[1].args[1], enhancements.call_args_list[5].args[1])

    def test_invalid_denoise_is_rejected_before_model_loading(self):
        for denoise in [-1, 2, float("nan")]:
            messages, _, plugins, _, _ = self.run_worker([
                dict(plugin_request("realesrgan", "realesr-general-x4v3"), denoise=denoise)
            ])
            self.assertFalse(messages[0]["ok"])
            plugins.assert_not_called()


class FaceSelectionTests(unittest.TestCase):
    def test_largest_face_wins_regardless_of_detection_order(self):
        small = SimpleNamespace(bbox=[0, 0, 5, 5])
        large = SimpleNamespace(bbox=[10, 10, 30, 40])
        model = FaceSwap.__new__(FaceSwap)
        model.analyzer = SimpleNamespace(get=lambda _: [small, large])
        self.assertIs(model.largest_face(None, "photo"), large)


if __name__ == "__main__":
    unittest.main()
