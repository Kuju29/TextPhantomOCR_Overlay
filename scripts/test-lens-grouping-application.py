from __future__ import annotations

import asyncio
import base64
import io
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from fastapi import HTTPException  # noqa: E402
from backend.application import lens_grouping  # noqa: E402
from backend.grouping.detector_free_service import DetectorFreeGroupingError  # noqa: E402
from backend.grouping.adapter import raw_tree_fingerprint  # noqa: E402


def png_bytes() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (37, 29), "white").save(stream, format="PNG")
    return stream.getvalue()


class FakeRequest:
    def __init__(self):
        self.url = SimpleNamespace(path="/v2/engine/runsextension/groups")
        self.headers = {
            "x-tp-request-id": "req-1",
            "x-tp-client-version": "2026.test",
        }
        self.query_params = {}


def source_tree():
    return {
        "paragraphs": [{
            "id": "raw-0",
            "para_index": 7,
            "text": "本文",
            "bounds_px": [10, 2, 22, 20],
            "items": [{"text": "本文", "bounds_px": [10, 2, 22, 20]}],
        }]
    }


def service_output(tree=None):
    tree = tree or source_tree()
    contract = {
        "version": "tp.group-source/2",
        "separator": "",
        "fullParts": ["本文"],
        "translationParts": ["本文"],
        "members": [{"rawId": "raw-0", "rawParagraphIndex": 0,
                     "documentParagraphId": "p3", "sourceText": "本文",
                     "translationText": "本文", "omission": None,
                     "rubyItemsDropped": 0}],
    }
    grouping = {
        "schema": "tp.grouping-result/2",
        "status": "usable",
        "treeFingerprint": raw_tree_fingerprint(tree),
        "unresolvedIds": [],
        "groups": [{"id": "g0", "text": "本文", "direction": "v",
                    "rotation": 90.0, "boundsPx": [10, 2, 22, 20],
                    "fontPx": 12.0, "rubyItemsDropped": 0,
                    "rubyParagraphsDropped": 0, "sourceContract": contract}],
    }
    bubbles = [{"para_indices": [7], "text": "本文", "source_contract": contract}]
    return {
        "grouping_result": grouping,
        "bubble_groups": bubbles,
        "debug": {"status": "resolved", "trace": {"resolver": "case"}},
    }


class LensGroupingApplicationTests(unittest.TestCase):
    def run_call(self, payload):
        return asyncio.run(lens_grouping.group_paragraphs(payload, FakeRequest()))

    def test_inline_image_calls_service_once_and_returns_migration_shapes(self):
        tree = source_tree()
        uri = "data:image/png;base64," + base64.b64encode(png_bytes()).decode("ascii")
        mapping = {"raw-0": 3}
        with patch.object(lens_grouping, "group_vertical_lens",
                          return_value=service_output()) as group:
            result = self.run_call({
                "tree": tree,
                "rawToDocument": mapping,
                "imageDataUri": uri,
                "context": {"tp_trace": "trace-1"},
            })
        group.assert_called_once()
        args, kwargs = group.call_args
        self.assertIs(args[0], tree)
        self.assertEqual(args[1:3], (37, 29))
        self.assertEqual(kwargs["raw_to_document"], mapping)
        self.assertEqual(kwargs["image"].size, (37, 29))
        self.assertEqual(result["groupingResult"]["status"], "usable")
        self.assertEqual(result["tree"]["schema"], "tp.canonical-original-tree/1")
        self.assertNotIn("groups", result)
        self.assertNotIn("bubble_groups", tree)
        self.assertTrue(result["merge"]["usable"])
        self.assertTrue(result["coverage"]["complete"])

    def test_artifact_resolution_uses_request_identity(self):
        with patch("backend.jobs.image_artifacts.image_artifacts.get",
                   return_value=png_bytes()) as get, \
             patch.object(lens_grouping, "group_vertical_lens",
                          return_value=service_output()):
            result = self.run_call({
                "tree": source_tree(),
                "imageArtifactToken": "ia_" + "a" * 40,
                "context": {"tp_tab_session": "tab-a"},
            })
        get.assert_called_once_with("ia_" + "a" * 40, "s:tab-a")
        self.assertEqual(result["imageArtifact"], "hit")

    def test_detector_free_failure_is_structured_and_stops(self):
        uri = "data:image/png;base64," + base64.b64encode(png_bytes()).decode("ascii")
        failure = DetectorFreeGroupingError(
            "vertical_grouping_unresolved",
            {"unresolvedIds": ["raw-0"], "reason": "separator_ambiguous",
             "sourceText": "must not leak"},
        )
        with patch.object(lens_grouping, "group_vertical_lens",
                          side_effect=failure) as group:
            with self.assertRaises(HTTPException) as caught:
                self.run_call({"tree": source_tree(), "imageDataUri": uri})
        group.assert_called_once()
        self.assertEqual(caught.exception.status_code, 422)
        detail = caught.exception.detail
        self.assertEqual(detail["code"], "vertical_grouping_unresolved")
        self.assertEqual(detail["stage"], "lens_grouping")
        self.assertFalse(detail["retryable"])
        self.assertEqual(len(detail["unresolvedIds"]), 1)
        self.assertTrue(detail["unresolvedIds"][0].startswith("id#"))
        self.assertNotIn("sourceText", detail)

    def test_failure_ids_preserve_only_structural_grammar(self):
        details = lens_grouping._safe_failure_details(
            DetectorFreeGroupingError("broken", {
                "rawId": "OCR secret sentence",
                "rubyId": "p3",
                "unresolvedIds": ["p5", "private source"],
            }))
        self.assertTrue(details["rawId"].startswith("id#"))
        self.assertEqual(details["rubyId"], "p3")
        self.assertEqual(details["unresolvedIds"][0], "p5")
        self.assertTrue(details["unresolvedIds"][1].startswith("id#"))
        self.assertNotIn("OCR secret sentence", str(details))

    def test_invalid_mapping_fails_before_image_or_service(self):
        with patch.object(lens_grouping, "group_vertical_lens") as group:
            with self.assertRaises(HTTPException) as caught:
                self.run_call({
                    "tree": source_tree(), "rawToDocument": "not-a-map",
                    "imageDataUri": "data:image/png;base64,ignored",
                })
        self.assertEqual(caught.exception.status_code, 400)
        group.assert_not_called()

    def test_empty_tree_fails_before_dispatch(self):
        with patch.object(lens_grouping, "group_vertical_lens") as group:
            with self.assertRaises(HTTPException) as caught:
                self.run_call({"tree": {"paragraphs": []}})
        self.assertEqual(caught.exception.status_code, 400)
        group.assert_not_called()


if __name__ == "__main__":
    unittest.main()
