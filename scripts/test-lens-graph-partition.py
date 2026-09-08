"""Adversarial contract tests for the detector-independent Lens partitioner.

Expected labels are synthetic by construction; screenshots are not ground truth.
The suite intentionally fails when a public safety invariant is absent.
"""
from __future__ import annotations

import random
import json
import copy
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.render.lens_graph_partition import partition_vertical_lens
from backend.render.lens_graph_partition.model import BoundaryEvidence, VerticalNode
from backend.render.lens_graph_partition.solver import solve
from backend.render.lens_graph_partition.validate import validate


def paragraph(pid: str, index: int, x: float, y: float = 20,
              width: float = 16, height: float = 100,
              text: str = "本文") -> dict:
    bounds = [x, y, x + width, y + height]
    return {"id": pid, "para_index": index, "text": text,
            "bounds_px": bounds,
            "items": [{"text": text, "bounds_px": bounds,
                       "box": {"rotation_deg": 90,
                               "height": height / 400}}]}


def tree(*paragraphs: dict) -> dict:
    return {"paragraphs": list(paragraphs)}


def flatten(groups) -> list[str]:
    return [pid for group in groups for pid in group]


def full_accounting(result) -> list[str]:
    """Every OCR id must be grouped, attached ruby, or explicitly excluded."""
    return [*flatten(result.groups),
            *(attachment.ruby_id for attachment in result.ruby),
            *(pid for pid, _reason in result.excluded)]


def total_accounting(result) -> list[str]:
    return [*full_accounting(result), *result.unresolved_ids]


class PublicPartitionCases(unittest.TestCase):
    def test_singleton_dialogue(self):
        result = partition_vertical_lens(tree(paragraph("p0", 0, 100)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("p0",),))
        self.assertEqual(full_accounting(result), ["p0"])

    def test_two_aligned_columns_merge(self):
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 100), paragraph("left", 1, 76)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("right", "left"),))

    def test_two_far_columns_split_without_needing_a_third_sample(self):
        # A one-edge candidate has no population for a z score. Absolute
        # glyph-normalized distance must remain observable.
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 180), paragraph("left", 1, 20)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("right",), ("left",)))

    def test_two_columns_with_huge_head_offset_and_tiny_overlap_do_not_merge(self):
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 100, 20, 16, 100),
            paragraph("left", 1, 76, 115, 16, 100)))
        self.assertFalse(any(set(group) == {"right", "left"}
                             for group in result.groups))
        self.assertTrue(
            result.status == "unresolved"
            or result.groups == (("right",), ("left",))
        )

    def test_two_columns_with_natural_small_stagger_merge(self):
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 100, 20, 16, 100),
            paragraph("left", 1, 76, 30, 16, 100)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("right", "left"),))

    def test_vertically_stacked_lens_fragments_merge_without_panel_rule(self):
        # Real debug-extension-6 shape: Lens split one narrow vertical region
        # into two envelopes with the same x band and a sub-glyph Y gap.
        upper = paragraph("p13", 13, 159, 486, 81, 129)
        lower = paragraph("p14", 14, 151, 633, 93, 150)
        image = np.full((900, 400), 255, dtype=np.uint8)
        image[486:783, 140:150] = 80
        image[486:783, 245:255] = 80
        expected = None
        for source in ((upper, lower), (lower, upper)):
            result = partition_vertical_lens(tree(*source), image=image)
            self.assertEqual(result.status, "resolved")
            self.assertEqual(result.groups, (("p13", "p14"),))
            self.assertIn("vertical_continuation",
                          result.trace.boundaries[0].reasons)
            self.assertCountEqual(full_accounting(result), ["p13", "p14"])
            if expected is None:
                expected = result.groups
            else:
                self.assertEqual(result.groups, expected)

    def test_horizontal_panel_rule_vetoes_vertical_continuation(self):
        upper = paragraph("upper", 0, 100, 20, 40, 100)
        lower = paragraph("lower", 1, 102, 138, 40, 100)
        image = np.full((280, 240), 255, dtype=np.uint8)
        image[127:130, 102:140] = 0
        result = partition_vertical_lens(tree(upper, lower), image=image)
        self.assertEqual(result.status, "resolved")
        self.assertCountEqual(result.groups, (("upper",), ("lower",)))
        self.assertCountEqual(full_accounting(result), ["upper", "lower"])

    def test_white_gutter_is_not_positive_container_evidence(self):
        upper = paragraph("upper", 0, 100, 20, 40, 80)
        lower = paragraph("lower", 1, 100, 108, 40, 80)
        blank = np.full((240, 240), 255, dtype=np.uint8)
        result = partition_vertical_lens(tree(upper, lower), image=blank)
        self.assertEqual(result.status, "resolved")
        self.assertCountEqual(result.groups, (("upper",), ("lower",)))

    def test_large_font_ratio_does_not_merge_blindly(self):
        result = partition_vertical_lens(tree(
            paragraph("normal", 0, 100, 20, 12, 100, "本文"),
            paragraph("large", 1, 50, 20, 36, 100, "重要")))
        self.assertFalse(any(set(group) == {"normal", "large"}
                             for group in result.groups))
        self.assertTrue(
            result.status == "unresolved"
            or result.groups == (("normal",), ("large",))
        )

    def test_two_node_boundary_cases_are_scale_translation_invariant(self):
        cases = [
            (paragraph("r", 0, 100, 20, 16, 100),
             paragraph("l", 1, 76, 115, 16, 100)),
            (paragraph("r", 0, 100, 20, 16, 100),
             paragraph("l", 1, 76, 30, 16, 100)),
            (paragraph("r", 0, 100, 20, 12, 100),
             paragraph("l", 1, 50, 20, 36, 100)),
        ]
        for case_index, source_pair in enumerate(cases):
            baseline = partition_vertical_lens(tree(*source_pair))
            for scale, dx, dy in ((.5, 7, 11), (2, 90, 120)):
                transformed = []
                for source in source_pair:
                    value = {**source, "items": [{**source["items"][0]}]}
                    b = source["bounds_px"]
                    bounds = [b[0] * scale + dx, b[1] * scale + dy,
                              b[2] * scale + dx, b[3] * scale + dy]
                    value["bounds_px"] = bounds
                    value["items"][0]["bounds_px"] = bounds
                    transformed.append(value)
                actual = partition_vertical_lens(tree(*transformed))
                with self.subTest(case=case_index, scale=scale):
                    self.assertEqual(actual.status, baseline.status)
                    self.assertEqual(actual.groups, baseline.groups)
                    self.assertCountEqual(actual.unresolved_ids,
                                          baseline.unresolved_ids)

    def test_three_plus_columns_find_one_large_boundary(self):
        result = partition_vertical_lens(tree(
            paragraph("a", 0, 180), paragraph("b", 1, 156),
            paragraph("c", 2, 60), paragraph("d", 3, 36)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("a", "b"), ("c", "d")))

    def test_touching_columns_without_a_line_are_not_false_split(self):
        image = np.full((180, 160), 255, dtype=np.uint8)
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 90, 30, 16, 110),
            paragraph("left", 1, 70, 30, 16, 110)), image=image)
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("right", "left"),))
        self.assertLess(result.trace.boundaries[0].line_strength, 0.78)

    def test_persistent_separator_is_a_hard_cut(self):
        image = np.full((180, 160), 255, dtype=np.uint8)
        image[30:140, 87:89] = 0
        result = partition_vertical_lens(tree(
            paragraph("right", 0, 90, 30, 16, 110),
            paragraph("left", 1, 70, 30, 16, 110)), image=image)
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("right",), ("left",)))
        self.assertEqual(result.trace.boundaries[0].hard, "separate")

    def test_open_text_box_with_unequal_run_lengths_stays_one_unit(self):
        result = partition_vertical_lens(tree(
            paragraph("r", 0, 120, 20, 17, 150),
            paragraph("m", 1, 96, 26, 16, 80),
            paragraph("l", 2, 72, 18, 17, 120)))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("r", "m", "l"),))

    def test_ruby_is_attached_and_sfx_is_explicitly_excluded(self):
        result = partition_vertical_lens(tree(
            paragraph("base", 0, 100, width=18, text="漢字"),
            paragraph("ruby", 1, 91, width=7, text="かんじ"),
            paragraph("peer", 2, 70, width=18, text="本文"),
            paragraph("sfx", 3, 20, width=40, text="ドン")))
        self.assertEqual({a.ruby_id: a.base_id for a in result.ruby},
                         {"ruby": "base"})
        self.assertIn(("sfx", "sfx"), result.excluded)
        self.assertCountEqual(full_accounting(result),
                              ["base", "ruby", "peer", "sfx"])

    def test_scale_translation_and_small_jitter_do_not_change_partition(self):
        base = [paragraph("a", 0, 130, 20),
                paragraph("b", 1, 106, 23),
                paragraph("c", 2, 82, 18)]
        expected = partition_vertical_lens(tree(*base))
        self.assertEqual(expected.status, "resolved")
        for scale, dx, dy in ((.5, 9, 7), (1, 80, 120), (2, 3, 5)):
            transformed = []
            for p in base:
                q = {**p, "items": [{**p["items"][0]}]}
                b = p["bounds_px"]
                bounds = [b[0] * scale + dx, b[1] * scale + dy,
                          b[2] * scale + dx, b[3] * scale + dy]
                q["bounds_px"] = bounds
                q["items"][0]["bounds_px"] = bounds
                transformed.append(q)
            actual = partition_vertical_lens(tree(*transformed))
            self.assertEqual(actual.status, expected.status)
            self.assertEqual(actual.groups, expected.groups)

    def test_input_order_does_not_change_rtl_reading_order(self):
        paras = [paragraph("r", 8, 120), paragraph("m", 3, 96),
                 paragraph("l", 11, 72)]
        for order in (paras, list(reversed(paras)),
                      [paras[1], paras[2], paras[0]]):
            result = partition_vertical_lens(tree(*order))
            self.assertEqual(result.groups, (("r", "m", "l"),))

    def test_missing_geometry_is_unresolved_not_silently_dropped(self):
        broken = paragraph("missing", 0, 100)
        broken.pop("bounds_px")
        broken["items"] = [{"text": "本文", "box": {"rotation_deg": 90}}]
        result = partition_vertical_lens(tree(broken))
        self.assertEqual(result.status, "unresolved")
        self.assertIn("missing", result.unresolved_ids)

    def test_missing_paragraph_envelope_recovers_from_item_union(self):
        recoverable = paragraph("recoverable", 0, 100)
        recoverable.pop("bounds_px")
        recoverable["items"] = [
            {"text": "本", "bounds_px": [100, 20, 116, 65],
             "box": {"rotation_deg": 90}},
            {"text": "文", "bounds_px": [100, 65, 116, 120],
             "box": {"rotation_deg": 90}},
        ]
        result = partition_vertical_lens(tree(recoverable))
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("recoverable",),))
        self.assertFalse(result.unresolved_ids)

    def test_low_margin_conservatively_cuts_without_losing_text(self):
        result = partition_vertical_lens(tree(
            paragraph("r", 0, 100), paragraph("l", 1, 76)),
            min_margin=100)
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.groups, (("r",), ("l",)))
        self.assertFalse(result.unresolved_ids)

    def test_independent_containers_never_cross_group(self):
        # Container identity is explicit synthetic input evidence.  Interleaved
        # x coordinates make accidental whole-page grouping easy to detect.
        a = paragraph("a-right", 0, 120)
        b = paragraph("a-left", 1, 92)
        c = paragraph("b-right", 2, 116)
        d = paragraph("b-left", 3, 88)
        for item in (a, b):
            item["container_id"] = "bubble-a"
        for item in (c, d):
            item["container_id"] = "bubble-b"
        result = partition_vertical_lens(tree(a, b, c, d))
        self.assertEqual(result.status, "resolved")
        self.assertCountEqual(result.groups,
                              (("a-right", "a-left"),
                               ("b-right", "b-left")))

    def test_overlapping_boxes_are_conserved_without_fatal_ambiguity(self):
        # There is no physical corridor between overlapping rectangles.  A
        # corridor score must not invent same-container evidence.
        result = partition_vertical_lens(tree(
            paragraph("outer", 0, 80, 20, 40, 120),
            paragraph("overlap", 1, 70, 30, 35, 80)))
        self.assertEqual(result.status, "resolved")
        self.assertCountEqual(flatten(result.groups), ["outer", "overlap"])
        self.assertFalse(result.unresolved_ids)

    def test_overlap_does_not_drop_or_contaminate_adjacent_safe_node(self):
        # A/B overlap is unresolved. C is an ordinary neighbour outside that
        # overlap and must remain explicitly grouped rather than disappearing
        # because one candidate contained a local ambiguity.
        result = partition_vertical_lens(tree(
            paragraph("a", 0, 110, 20, 32, 100),
            paragraph("b", 1, 96, 25, 30, 90),
            paragraph("c", 2, 66, 20, 16, 100)))
        self.assertEqual(result.status, "resolved")
        self.assertFalse(result.unresolved_ids)
        self.assertCountEqual(total_accounting(result), ["a", "b", "c"])
        self.assertEqual(len(total_accounting(result)),
                         len(set(total_accounting(result))))

    def test_transitive_overlap_bridge_does_not_contaminate_safe_prefix(self):
        # A~B is a normal adjacent pair while B overlaps C. The B/C ambiguity
        # must not erase or merge the already safe A/B component.
        result = partition_vertical_lens(tree(
            paragraph("a", 0, 120, 20, 16, 100),
            paragraph("b", 1, 96, 20, 16, 100),
            paragraph("c", 2, 90, 24, 16, 90)))
        self.assertEqual(result.status, "resolved")
        self.assertFalse(result.unresolved_ids)
        self.assertCountEqual(total_accounting(result), ["a", "b", "c"])

    def test_ruby_equally_plausible_for_two_bases_is_not_attached_to_first(self):
        result = partition_vertical_lens(tree(
            paragraph("base-r", 0, 112, width=18, text="漢字"),
            paragraph("ruby", 1, 99, width=7, text="かんじ"),
            paragraph("base-l", 2, 76, width=18, text="漢字")))
        self.assertEqual(result.status, "resolved")
        self.assertFalse(result.ruby)
        self.assertTrue(any("ruby" in group for group in result.groups))
        self.assertFalse(result.unresolved_ids)
        self.assertCountEqual(total_accounting(result),
                              ["base-r", "ruby", "base-l"])

    def test_ordinary_kana_between_two_kanji_columns_remains_translatable(self):
        result = partition_vertical_lens(tree(
            paragraph("base-r", 0, 112, width=18, text="漢字"),
            paragraph("speech", 1, 99, width=7, text="そうです"),
            paragraph("base-l", 2, 76, width=18, text="本文")))
        self.assertEqual(result.status, "resolved")
        self.assertFalse(result.ruby)
        self.assertIn("speech", flatten(result.groups))
        self.assertCountEqual(full_accounting(result),
                              ["base-r", "speech", "base-l"])

    def test_multi_envelope_bridge_is_order_invariant_and_not_fatal(self):
        # The last RTL node overlaps both previously established Y envelopes.
        # It has no unique merge owner, so it is retained as a local singleton.
        values = [
            paragraph("upper", 9, 130, 0, 16, 45),
            paragraph("lower", 3, 100, 60, 16, 45),
            paragraph("bridge", 7, 70, 25, 16, 60),
        ]
        expected = None
        for order in (values, list(reversed(values)),
                      [values[1], values[2], values[0]]):
            result = partition_vertical_lens(tree(*order))
            self.assertEqual(result.status, "resolved")
            self.assertFalse(result.unresolved_ids)
            self.assertCountEqual(flatten(result.groups),
                                  ["upper", "lower", "bridge"])
            if expected is None:
                expected = result.groups
            else:
                self.assertEqual(result.groups, expected)

    def test_punctuation_is_named_passthrough_not_silently_lost(self):
        result = partition_vertical_lens(tree(
            paragraph("speech", 0, 100, text="本文"),
            paragraph("ellipsis", 1, 76, text="…………")))
        self.assertIn(("ellipsis", "punctuation"), result.excluded)
        self.assertCountEqual(total_accounting(result),
                              ["speech", "ellipsis"])

    def test_large_short_dialogue_is_not_sfx_without_independent_evidence(self):
        result = partition_vertical_lens(tree(
            paragraph("context-r", 0, 130, width=16, text="本文です"),
            paragraph("context-l", 1, 106, width=16, text="続きます"),
            paragraph("shout", 2, 60, width=40, text="待って")))
        self.assertNotIn(("shout", "sfx"), result.excluded)
        self.assertIn("shout", total_accounting(result))
        self.assertTrue(any("shout" in group for group in result.groups)
                        or "shout" in result.unresolved_ids)

    def test_missing_pixel_source_is_traced_as_unknown_not_zero_evidence(self):
        pair = tree(paragraph("r", 0, 100), paragraph("l", 1, 76))
        for image in (None, object()):
            with self.subTest(image=type(image).__name__):
                result = partition_vertical_lens(pair, image=image)
                boundary = result.trace.boundaries[0]
                self.assertFalse(boundary.pixel_known)

    def test_uniform_black_fill_is_not_a_panel_separator(self):
        pair = tree(
            paragraph("r", 0, 90, 30, 16, 110),
            paragraph("l", 1, 70, 30, 16, 110))
        dark_fill = np.zeros((180, 160), dtype=np.uint8)
        result = partition_vertical_lens(pair, image=dark_fill)
        boundary = result.trace.boundaries[0]
        self.assertTrue(boundary.pixel_known)
        self.assertNotEqual(boundary.hard, "separate")
        self.assertNotIn("persistent_line", boundary.reasons)

    def test_dark_panel_line_and_uniform_black_fill_are_distinguished(self):
        pair = tree(
            paragraph("r", 0, 90, 30, 16, 110),
            paragraph("l", 1, 70, 30, 16, 110))
        divider = np.full((180, 160), 255, dtype=np.uint8)
        divider[30:140, 87:89] = 0
        line_result = partition_vertical_lens(pair, image=divider)
        fill_result = partition_vertical_lens(
            pair, image=np.zeros((180, 160), dtype=np.uint8))
        self.assertEqual(line_result.trace.boundaries[0].hard, "separate")
        self.assertNotEqual(fill_result.trace.boundaries[0].hard, "separate")

    def test_public_result_accounts_for_every_nonblank_input_id(self):
        base = paragraph("base", 0, 120, width=18, text="漢字")
        ruby = paragraph("ruby", 1, 108, width=7, text="かんじ")
        punctuation = paragraph("pause", 2, 80, text="……")
        missing = paragraph("missing", 3, 50, text="本文")
        missing.pop("bounds_px")
        source = tree(base, ruby, punctuation, missing)
        result = partition_vertical_lens(source)
        expected = [p["id"] for p in source["paragraphs"]
                    if str(p.get("text") or "").strip()]
        self.assertCountEqual(total_accounting(result), expected)
        self.assertEqual(len(total_accounting(result)),
                         len(set(total_accounting(result))))


class SolverAdversaries(unittest.TestCase):
    def test_transitive_bridge_cannot_cross_hard_boundary(self):
        nodes = tuple(VerticalNode(pid, i, (100 - i * 24, 20,
                                           116 - i * 24, 120),
                                   "本文", 16, "dialogue")
                      for i, pid in enumerate(("a", "b", "c")))
        boundaries = (
            BoundaryEvidence("a", "b", 0, 0, 0, 1, 0, 1,
                             "same", 2, 0, ("constructed_same",)),
            BoundaryEvidence("b", "c", 0, 0, 0, .5, 0, .5,
                             "separate", 0, 2, ("constructed_cut",)))
        best, _runner, _best_score, _runner_score = solve(nodes, boundaries)
        self.assertEqual(best, (("a", "b"), ("c",)))
        self.assertEqual(validate(nodes, best), ())

    def test_randomized_solver_conserves_membership_and_order(self):
        rng = random.Random(958)
        for count in range(1, 33):
            nodes = tuple(VerticalNode(str(i), i,
                                       (1000 - i * 20, 10,
                                        1016 - i * 20, 110),
                                       "本文", 16, "dialogue")
                          for i in range(count))
            boundaries = tuple(
                BoundaryEvidence(str(i), str(i + 1), 0, 0, 0, .8, 0, .8,
                                 rng.choice(("same", "separate", "none")),
                                 rng.random() * 2, rng.random() * 2)
                for i in range(count - 1))
            best, _runner, _a, _b = solve(nodes, boundaries)
            self.assertEqual(validate(nodes, best), ())
            self.assertEqual(flatten(best), [str(i) for i in range(count)])


class RealLensReplay(unittest.TestCase):
    """Lens-only replay; detector stamps and external image files are absent."""

    @classmethod
    def setUpClass(cls):
        fixture = (Path(__file__).with_name("fixtures") /
                   "vertical-debug-api-6.json")
        cls.source = json.loads(fixture.read_text(encoding="utf-8"))

    def partition(self):
        value = copy.deepcopy(self.source)
        for para in value["paragraphs"]:
            para["id"] = f"p{int(para['para_index'])}"
        return value, partition_vertical_lens(value, image=None)

    def test_defensible_memberships_from_real_lens_geometry(self):
        _value, result = self.partition()
        groups = {frozenset(group) for group in result.groups}
        self.assertIn(frozenset(("p5", "p6", "p7")), groups)
        self.assertIn(frozenset(("p8", "p9")), groups)
        self.assertIn(frozenset(("p22", "p23", "p24")), groups)
        self.assertIn(frozenset(("p25", "p26")), groups)
        self.assertIn(frozenset(("p18",)), groups)

    def test_known_touching_boundaries_do_not_cross(self):
        _value, result = self.partition()
        self.assertFalse(any("p7" in group and "p8" in group
                             for group in result.groups))
        self.assertFalse(any("p24" in group and "p25" in group
                             for group in result.groups))

    def test_every_nonblank_real_lens_id_is_accounted_once(self):
        value, result = self.partition()
        expected = [p["id"] for p in value["paragraphs"]
                    if str(p.get("text") or "").strip()]
        actual = total_accounting(result)
        self.assertCountEqual(actual, expected)
        self.assertEqual(len(actual), len(set(actual)))

    def test_replay_is_fully_resolved_without_detector_metadata(self):
        _value, result = self.partition()
        self.assertEqual(result.status, "resolved")
        self.assertFalse(result.unresolved_ids)


if __name__ == "__main__":
    unittest.main()
