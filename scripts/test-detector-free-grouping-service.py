from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.grouping.detector_free_service import (  # noqa: E402
    DetectorFreeGroupingError, group_vertical_lens, project_grouping_result,
)


def para(pid, index, x, text="本文", width=16, rotation=90, **extra):
    bounds = [x, 20, x + width, 120]
    value = {"id": pid, "para_index": index, "text": text,
             "bounds_px": bounds,
             "items": [{"text": text, "bounds_px": bounds,
                        "box": {"rotation_deg": rotation}}]}
    value.update(extra)
    return value


class DetectorFreeServiceTests(unittest.TestCase):
    def test_emits_existing_outer_shape_and_member_provenance(self):
        source = {"paragraphs": [para("r", 4, 100), para("l", 7, 76)]}
        result = group_vertical_lens(source, 200, 200)
        group = result["bubble_groups"][0]
        self.assertEqual(group["paragraph_ids"], ["p0", "p1"])
        self.assertEqual(group["para_indices"], [4, 7])
        self.assertEqual(result["grouping_result"]["schema"], "tp.grouping-result/2")
        self.assertEqual(group["source_contract"]["version"], "tp.group-source/2")
        self.assertEqual([m["rawId"] for m in group["source_contract"]["members"]],
                         ["r", "l"])
        self.assertEqual(group["text"], "本文本文")
        self.assertEqual(result["debug"]["status"], "resolved")

    def test_explicit_item_ruby_drop_is_exact_and_auditable(self):
        p = para("p", 0, 100, "漢かん")
        p["items"] = [
            {"text": "漢", "bounds_px": [100, 20, 116, 70],
             "box": {"rotation_deg": 90}},
            {"text": "かん", "bounds_px": [90, 20, 96, 70],
             "box": {"rotation_deg": 90}, "is_ruby": True},
        ]
        group = group_vertical_lens({"paragraphs": [p]}, 200, 200)["bubble_groups"][0]
        self.assertEqual(group["text"], "漢")
        self.assertEqual(group["text_full"], "漢かん")
        self.assertEqual(group["ruby_items_dropped"], 1)
        self.assertEqual(group["source_contract"]["members"][0]
                         ["rubyItemsDropped"], 1)

    def test_unresolved_fails_closed_with_trace(self):
        broken = para("missing", 0, 100)
        broken.pop("bounds_px")
        broken["items"] = [{"text": "本文", "box": {"rotation_deg": 90}}]
        with self.assertRaises(DetectorFreeGroupingError) as caught:
            group_vertical_lens({"paragraphs": [broken]}, 200, 200)
        self.assertEqual(caught.exception.code, "vertical_grouping_unresolved")
        self.assertIn("missing", caught.exception.details["unresolvedIds"])
        self.assertIn("trace", caught.exception.details)

    def test_item_geometry_recovers_missing_paragraph_envelope(self):
        recoverable = para("recoverable", 0, 100)
        recoverable.pop("bounds_px")
        result = group_vertical_lens(
            {"paragraphs": [recoverable]}, 200, 200)
        self.assertEqual(result["debug"]["status"], "resolved")
        self.assertEqual(
            result["grouping_result"]["groups"][0]["paragraphIds"], ["p0"])

    def test_identity_and_filtered_mapping_share_raw_partition(self):
        source = {"paragraphs": [para("r", 4, 100), para("l", 7, 76)]}
        identity = group_vertical_lens(source, 200, 200)
        filtered = group_vertical_lens(
            source, 200, 200, raw_to_document={"r": 8, "l": 3})
        a, b = identity["grouping_result"], filtered["grouping_result"]
        self.assertEqual(a["rawPartitionHash"], b["rawPartitionHash"])
        self.assertEqual(a["treeFingerprint"], b["treeFingerprint"])
        self.assertEqual(a["groups"][0]["sourceContract"]["fullParts"],
                         b["groups"][0]["sourceContract"]["fullParts"])
        self.assertEqual(a["groups"][0]["text"], b["groups"][0]["text"])
        self.assertEqual(a["groups"][0]["paragraphIds"], ["p0", "p1"])
        self.assertEqual(b["groups"][0]["paragraphIds"], ["p8", "p3"])

    def test_whole_ruby_uses_null_mapping_and_exact_source(self):
        base = para("base", 0, 100, "漢字", width=18)
        ruby = para("ruby", 1, 91, "かんじ", width=7)
        peer = para("peer", 2, 70, "本文", width=18)
        result = group_vertical_lens(
            {"paragraphs": [base, ruby, peer]}, 200, 200)
        group = result["grouping_result"]["groups"][0]
        member = next(m for m in group["sourceContract"]["members"]
                      if m["rawId"] == "ruby")
        self.assertIsNone(member["documentParagraphId"])
        self.assertEqual(member["sourceText"], "かんじ")
        self.assertEqual(member["omission"], "whole_ruby")

    def test_extension_mapping_retains_graph_ruby_false_positive(self):
        base = para("base", 0, 100, "漢字", width=12)
        ruby = para("p5", 1, 91, "かんじ", width=7)
        peer = para("peer", 2, 74, "本文", width=12)
        expected = None
        for paragraphs in ([base, ruby, peer], [peer, ruby, base]):
            result = group_vertical_lens(
                {"paragraphs": paragraphs}, 200, 200,
                raw_to_document={"base": 0, "p5": 1, "peer": 2},
            )
            grouping = result["grouping_result"]
            raw_groups = [[member["rawId"] for member in
                           group["sourceContract"]["members"]]
                          for group in grouping["groups"]]
            containing = next(group for group in raw_groups if "p5" in group)
            self.assertGreater(len(containing), 1)
            members = [member for group in grouping["groups"]
                       for member in group["sourceContract"]["members"]]
            retained = next(member for member in members
                            if member["rawId"] == "p5")
            self.assertIsNone(retained["omission"])
            self.assertEqual(retained["documentParagraphId"], "p1")
            self.assertEqual(grouping["coverage"], {
                "eligible": 3, "assigned": 3, "excludedRuby": 0,
                "unresolved": 0,
            })
            self.assertEqual(result["debug"]["rubyMappingDisagreements"], ["p5"])
            if expected is None:
                expected = sorted(raw_groups)
            else:
                self.assertEqual(sorted(raw_groups), expected)

    def test_horizontal_only_is_singleton_with_actual_rotation(self):
        source = {"paragraphs": [
            para("a", 0, 20, "one", width=150, rotation=3),
            para("b", 1, 44, "two", width=150, rotation=-2)]}
        result = group_vertical_lens(source, 200, 200)
        groups = result["grouping_result"]["groups"]
        self.assertEqual([g["sourceContract"]["members"][0]["rawId"]
                          for g in groups], ["a", "b"])
        self.assertTrue(all(g["direction"] == "h" for g in groups))
        self.assertEqual([g["rotation"] for g in groups], [3.0, -2.0])

    def test_mixed_page_conserves_raw_order_without_cross_axis_merge(self):
        source = {"paragraphs": [
            para("v-right", 0, 100),
            para("h", 1, 30, "caption", width=150, rotation=0),
            para("v-left", 2, 76)]}
        result = group_vertical_lens(source, 200, 200)
        groups = result["grouping_result"]["groups"]
        raw_groups = [[m["rawId"] for m in g["sourceContract"]["members"]]
                      for g in groups]
        self.assertEqual(raw_groups, [["v-right", "v-left"], ["h"]])
        self.assertCountEqual([raw for group in raw_groups for raw in group],
                              ["v-right", "h", "v-left"])
        self.assertEqual([g["direction"] for g in groups], ["v", "h"])

    def test_tall_lens_envelope_overrides_near_zero_glyph_baseline(self):
        source = {"paragraphs": [
            para("right", 0, 100, rotation=0.01),
            para("left", 1, 76, rotation=-0.04),
        ]}
        result = group_vertical_lens(source, 200, 200)
        self.assertEqual(result["debug"]["orientation"], {
            "vertical": 2, "horizontal": 0, "unknown": 0,
        })
        self.assertEqual([
            member["rawId"]
            for member in result["grouping_result"]["groups"][0]
            ["sourceContract"]["members"]
        ], ["right", "left"])

    def test_projection_uses_paragraph_identity_not_translated_reflow_geometry(self):
        source = {"paragraphs": [para("r", 0, 100), para("l", 1, 76)]}
        grouped = group_vertical_lens(source, 200, 200)["grouping_result"]
        target = {"paragraphs": [
            para("r", 0, 95, text="ขวา", width=30),
            para("l", 1, 60, text="ซ้าย", width=28),
        ]}
        projected = project_grouping_result(grouped, source, target)
        self.assertEqual(projected["rawPartitionHash"], grouped["rawPartitionHash"])
        self.assertEqual(projected["groups"][0]["paragraphIds"], ["p0", "p1"])


if __name__ == "__main__":
    unittest.main()
