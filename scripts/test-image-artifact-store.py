from __future__ import annotations

import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.application import lens_request  # noqa: E402
from backend.jobs.image_artifacts import ArtifactError, ImageArtifactStore  # noqa: E402


class ImageArtifactLifecycleTests(unittest.TestCase):
    def test_grouping_consume_frees_bytes_immediately(self):
        store = ImageArtifactStore(ttl_sec=600, byte_budget=10)
        token, _ = store.put(b"123456", "scope")
        self.assertEqual(store.stats()["bytes"], 6)
        self.assertEqual(store.consume(token, "scope"), b"123456")
        stats = store.stats()
        self.assertEqual(stats["bytes"], 0)
        self.assertEqual(stats["entries"], 0)
        self.assertEqual(stats["consumed"], 1)
        with self.assertRaises(ArtifactError) as caught:
            store.consume(token, "scope")
        self.assertEqual(caught.exception.code, "artifact_unavailable")
        # Freed capacity is reusable immediately instead of waiting 10 minutes.
        store.put(b"abcdefghij", "scope")
        self.assertEqual(store.stats()["bytes"], 10)

    def test_cache_admission_skips_confident_horizontal_pages(self):
        lens = {"originalParagraphs": ["encoded"], "originalTextFull": "text"}
        tree = {"paragraphs": [{"items": [{"text": "hello"}]}]}
        with patch("backend.lens.tree.decode_tree", return_value=tree), \
             patch("backend.render.region.paragraph_reading_axis", return_value="h"):
            self.assertEqual(lens_request.image_artifact_candidate(lens, 100, 100), (False, "horizontal"))
        with patch("backend.lens.tree.decode_tree", return_value=tree), \
             patch("backend.render.region.paragraph_reading_axis", return_value="v"):
            self.assertEqual(lens_request.image_artifact_candidate(lens, 100, 100), (True, "vertical_candidate"))

    def test_cache_admission_is_fail_open_for_handoff(self):
        lens = {"originalParagraphs": ["encoded"], "originalTextFull": "text"}
        with patch("backend.lens.tree.decode_tree", side_effect=ValueError("fixture decode drift")):
            self.assertEqual(lens_request.image_artifact_candidate(lens, 100, 100), (True, "undetermined"))

    def test_optional_artifact_does_not_store_no_text_or_horizontal(self):
        class Store:
            def __init__(self): self.calls = 0
            def put(self, raw, identity):
                self.calls += 1
                return "ia_" + "a" * 40, 600
        store = Store()
        info, outcome = lens_request.optional_image_artifact(
            store, b"image", "scope", lens={"originalParagraphs": []}, width=100, height=100)
        self.assertIsNone(info)
        self.assertEqual(outcome, "skipped_no_text")
        self.assertEqual(store.calls, 0)


if __name__ == "__main__":
    unittest.main()
