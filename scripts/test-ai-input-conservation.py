from __future__ import annotations

import copy
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = ROOT / "api"
if str(API) not in sys.path:
    sys.path.insert(0, str(API))

from backend.jobs.stages.ai_conservation import (  # noqa: E402
    AiInputConservationError,
    require_ai_input_conservation,
)
from backend.grouping.detector_free_service import group_vertical_lens  # noqa: E402


def para(index: int, text: str) -> dict:
    return {"para_index": index, "text": text, "items": []}


class AiInputConservationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.paragraphs = [para(0, "右"), para(1, "列"), para(2, "単独"), para(3, "")]
        self.tree = {"paragraphs": self.paragraphs}
        self.group = {
            "bubble_index": 0,
            "para_indices": [0, 1],
            "text": "右列",
            "ruby_items_dropped": 0,
            "ruby_paragraphs_dropped": 0,
            "source_contract": {
                "version": "tp.group-source/2",
                "separator": "",
                "fullParts": ["右", "列"],
                "translationParts": ["右", "列"],
                "members": [
                    {"rawId": "r0", "rawParagraphIndex": 0, "documentParagraphId": "p0", "sourceText": "右", "translationText": "右", "omission": None, "rubyItemsDropped": 0},
                    {"rawId": "r1", "rawParagraphIndex": 1, "documentParagraphId": "p1", "sourceText": "列", "translationText": "列", "omission": None, "rubyItemsDropped": 0},
                ],
            },
        }

    def test_group_and_singleton_are_conserved(self) -> None:
        report = require_ai_input_conservation(
            self.tree,
            [self.group],
            [[0, 1], [2]],
            [self.group["text"], "単独"],
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["eligibleParagraphCount"], 3)
        self.assertEqual(report["excludedBlankParagraphCount"], 1)
        self.assertEqual(len(report["partitionHash"]), 64)

    def test_corrupted_group_text_is_rejected(self) -> None:
        group = copy.deepcopy(self.group)
        group["text"] = "右"
        with self.assertRaisesRegex(AiInputConservationError, "translation_text_mismatch"):
            require_ai_input_conservation(
                self.tree, [group], [[0, 1], [2]], [group["text"], "単独"]
            )

    def test_v1_source_contract_is_rejected(self) -> None:
        group = copy.deepcopy(self.group)
        group["source_contract"]["version"] = "tp.group-source/1"
        with self.assertRaisesRegex(AiInputConservationError, "missing_source_contract"):
            require_ai_input_conservation(
                self.tree, [group], [[0, 1], [2]], [group["text"], "単独"]
            )

    def test_real_detector_free_service_output_is_accepted(self) -> None:
        def live_para(pid: str, index: int, x: int, text: str) -> dict:
            bounds = [x, 20, x + 16, 120]
            return {
                "id": pid, "para_index": index, "text": text,
                "bounds_px": bounds,
                "items": [{"text": text, "bounds_px": bounds,
                           "box": {"rotation_deg": 90}}],
            }
        tree = {"paragraphs": [
            live_para("r", 0, 100, "右"),
            live_para("l", 1, 76, "左"),
        ]}
        service = group_vertical_lens(tree, 200, 200)
        groups = service["bubble_groups"]
        report = require_ai_input_conservation(
            tree,
            groups,
            [list(group["para_indices"]) for group in groups],
            [str(group["text"]) for group in groups],
        )
        self.assertTrue(report["ok"])
        self.assertEqual(groups[0]["source_contract"]["version"], "tp.group-source/2")

    def test_missing_and_duplicate_membership_are_rejected(self) -> None:
        with self.assertRaisesRegex(AiInputConservationError, "missing_paragraphs"):
            require_ai_input_conservation(self.tree, [self.group], [[0, 1]], [self.group["text"]])
        with self.assertRaisesRegex(AiInputConservationError, "duplicate_paragraphs"):
            require_ai_input_conservation(
                self.tree,
                [self.group],
                [[0, 1], [1], [2]],
                [self.group["text"], "列", "単独"],
            )

    def test_translatable_content_cannot_collapse_to_punctuation(self) -> None:
        group = copy.deepcopy(self.group)
        group["ruby_items_dropped"] = 2
        group["source_contract"]["members"][0]["translationText"] = "…"
        group["source_contract"]["members"][0]["rubyItemsDropped"] = 1
        group["source_contract"]["members"][1]["translationText"] = "…"
        group["source_contract"]["members"][1]["rubyItemsDropped"] = 1
        group["source_contract"]["translationParts"] = ["…", "…"]
        group["text"] = "……"
        tree = copy.deepcopy(self.tree)
        tree["paragraphs"][0]["text"] = "…"
        tree["paragraphs"][1]["text"] = "…"
        with self.assertRaisesRegex(AiInputConservationError, "letters_collapsed"):
            require_ai_input_conservation(
                tree, [group], [[0, 1], [2]], [group["text"], "単独"]
            )

    def test_real_whole_ruby_paragraph_removal_has_explicit_provenance(self) -> None:
        def vertical(pid: str, index: int, text: str, bounds: list[int]) -> dict:
            return {
                "id": pid,
                "para_index": index,
                "text": text,
                "bounds_px": bounds,
                "items": [{
                    "text": text,
                    "bounds_px": bounds,
                    "box": {"rotation_deg": 90},
                }],
            }

        base = vertical("base", 0, "漢字", [100, 20, 118, 120])
        reading = vertical("ruby", 1, "かんじ", [91, 20, 98, 120])
        peer = vertical("peer", 2, "本文", [70, 20, 88, 120])
        tree = {"paragraphs": [base, reading, peer]}
        service = group_vertical_lens(tree, 200, 200)
        groups = service["bubble_groups"]
        group = next(
            value for value in groups
            if any(member["rawId"] == "ruby"
                   for member in value["source_contract"]["members"])
        )
        self.assertEqual(group["ruby_paragraphs_dropped"], 1)
        self.assertEqual(group["ruby_items_dropped"], 0)
        member = next(value for value in group["source_contract"]["members"]
                      if value["rawId"] == "ruby")
        self.assertEqual(member["sourceText"], "かんじ")
        self.assertEqual(member["translationText"], "")
        self.assertEqual(member["omission"], "whole_ruby")
        self.assertIsNone(member["documentParagraphId"])
        report = require_ai_input_conservation(
            tree,
            groups,
            [list(value["para_indices"]) for value in groups],
            [str(value["text"]) for value in groups],
        )
        self.assertTrue(report["ok"])


if __name__ == "__main__":
    unittest.main()
