from __future__ import annotations

import copy
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.jobs.stages import image_flow  # noqa: E402


def paragraph(pid, index, x, text):
    bounds = [x, 20, x + 16, 120]
    return {"id": pid, "para_index": index, "text": text,
            "bounds_px": bounds,
            "items": [{"text": text, "bounds_px": bounds,
                       "box": {"rotation_deg": 90}}]}


class ImageFlowDetectorFreeTests(unittest.TestCase):
    def test_ai_dispatch_observes_one_projected_partition(self):
        original = {"paragraphs": [
            paragraph("r", 0, 100, "本文"), paragraph("l", 1, 76, "続き")]}
        translated = {"paragraphs": [
            paragraph("r", 0, 100, "ข้อความ"), paragraph("l", 1, 76, "ต่อ") ]}
        observed = {}

        def run_ai(out, original_tree, translated_tree, *_args, **_kwargs):
            observed["original"] = [g["para_indices"]
                                    for g in original_tree["bubble_groups"]]
            observed["translated"] = [g["para_indices"]
                                      for g in translated_tree["bubble_groups"]]
            observed["aiSource"] = _kwargs["ai_source_tree"]
            observed["useLensTemplate"] = _kwargs["use_lens_template"]
            out["Ai"] = {"aiTree": {"paragraphs": []}}

        with tempfile.TemporaryDirectory() as directory:
            image_path = pathlib.Path(directory) / "page.png"
            Image.new("RGB", (180, 160), "white").save(image_path)
            data = {"originalParagraphs": [], "translatedParagraphs": []}
            ai = SimpleNamespace(provider="local", base_url="http://local",
                                 api_key="")
            with patch.object(image_flow.lens_stage, "fetch", return_value=(data, 0.0)), \
                 patch.object(image_flow.lens_stage, "decode",
                              return_value=(copy.deepcopy(original), copy.deepcopy(translated))), \
                 patch.object(image_flow, "resolve_font_pair", return_value=(None, None)), \
                 patch.object(image_flow, "is_local_target", return_value=True), \
                 patch.object(image_flow.render_stage, "annotate_text_light"), \
                 patch.object(image_flow, "fit_tree_font_sizes"), \
                 patch.object(image_flow, "render_tree_overlay", return_value="<svg/>"), \
                 patch.object(image_flow.ai_stage, "run_ai_layer", side_effect=run_ai), \
                 patch.object(image_flow.lens_document, "attach_ai_layer", return_value=0), \
                 patch.object(image_flow, "settings", SimpleNamespace(
                     lens_direct_erase=False, lens_direct_png=False)):
                result = image_flow.process_image(
                    str(image_path), "th", "lens_text", ai, source="ai",
                    layout_opts={"client_background": False,
                                 "lens_document": False,
                                 "relayout_translated": False})
        self.assertEqual(observed["original"], observed["translated"])
        self.assertEqual(observed["original"], [[0, 1]])
        self.assertEqual(observed["aiSource"]["schema"], "tp.canonical-original-tree/1")
        self.assertEqual(len(observed["aiSource"]["paragraphs"]), 1)
        self.assertFalse(observed["useLensTemplate"])
        self.assertEqual(result["perfStages"]["ai_reason"], "direction_change")
        self.assertEqual(result["perfStages"]["grouping"],
                         "canonical_original_tree")
        self.assertIn("grouping_partition_hash", result["perfStages"])

    def test_file_contains_no_legacy_grouping_or_textblock_decision(self):
        source = pathlib.Path(image_flow.__file__).read_text(encoding="utf-8")
        for forbidden in ("group_stage", "textblocks", "detect_blocks",
                          "group_paragraphs_into_bubbles", "tb_authority"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
