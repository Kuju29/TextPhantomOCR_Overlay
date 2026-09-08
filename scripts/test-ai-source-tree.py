from __future__ import annotations

import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.grouping.ai_source_tree import build_ai_source_tree  # noqa: E402
from backend.grouping.detector_free_service import group_vertical_lens  # noqa: E402
from backend.grouping.adapter import raw_tree_fingerprint  # noqa: E402


FIXTURE = pathlib.Path("/workspace/scratch/0addf96e539c/upload/original_tree(7).json")


class AiSourceTreeTests(unittest.TestCase):
    def test_merged_parent_keeps_every_child_box_and_rotation(self):
        raw = {"paragraphs": [
            {"id": "p0", "para_index": 10, "start_raw": 3, "end_raw": 5,
             "text": "右", "bounds_px": [80, 10, 90, 70],
             "items": [{"text": "右", "bounds_px": [80, 10, 90, 70],
                        "box": {"rotation_deg": 89.5}}]},
            {"id": "p1", "para_index": 11, "start_raw": 6, "end_raw": 9,
             "text": "左", "bounds_px": [60, 12, 70, 80],
             "items": [{"text": "左", "bounds_px": [60, 12, 70, 80],
                        "box": {"rotation_deg": 90.5}}]},
        ]}
        contract = {
            "version": "tp.group-source/2", "separator": "",
            "fullParts": ["右", "左"], "translationParts": ["右", "左"],
            "members": [
                {"rawId": "p0", "rawParagraphIndex": 0,
                 "documentParagraphId": "p0", "omission": None},
                {"rawId": "p1", "rawParagraphIndex": 1,
                 "documentParagraphId": "p1", "omission": None},
            ],
        }
        grouping = {
            "status": "usable", "treeFingerprint": raw_tree_fingerprint(raw),
            "groups": [{"id": "g0", "text": "右左", "direction": "v",
                        "rotation": 90.0, "boundsPx": [60, 10, 90, 80],
                        "fontPx": 10.0, "sourceContract": contract}],
        }
        tree = build_ai_source_tree(raw, grouping)
        self.assertEqual(len(tree["paragraphs"]), 1)
        parent = tree["paragraphs"][0]
        self.assertEqual(parent["text"], "右左")
        self.assertEqual(parent["bounds_px"], [60, 10, 90, 80])
        self.assertEqual(parent["start_raw"], 3)
        self.assertEqual(parent["end_raw"], 9)
        self.assertEqual(
            [(item["bounds_px"], item["box"]["rotation_deg"])
             for item in parent["items"]],
            [([80, 10, 90, 70], 89.5), ([60, 12, 70, 80], 90.5)],
        )

    @unittest.skipUnless(FIXTURE.exists(), "uploaded Lens fixture is not available")
    def test_lens_paragraph_remains_one_parent_with_original_item_geometry(self):
        raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
        source = build_ai_source_tree(raw, group_vertical_lens(raw, 1180, 1648)["grouping_result"])
        matches = [paragraph for paragraph in source["paragraphs"] if "高校生で" in paragraph["text"]]
        self.assertEqual(len(matches), 1)
        paragraph = matches[0]
        self.assertEqual(
            paragraph["text"],
            "こうこうせい高校生で五町ほどのモノを持ってる子はなかなか中々いないよ",
        )
        self.assertEqual(
            [item["text"] for item in paragraph["items"]],
            ["こうこうせい", "高校生で", "五町ほどのモノを", "持ってる子は", "なかなか", "中々いないよ"],
        )
        raw_paragraph = raw["paragraphs"][23]
        self.assertEqual(
            [item["bounds_px"] for item in paragraph["items"]],
            [item["bounds_px"] for item in raw_paragraph["items"]],
        )
        self.assertEqual(paragraph["source"]["rawParagraphIndices"], [23])
        self.assertTrue(source["coverage"]["complete"])


if __name__ == "__main__":
    unittest.main()
