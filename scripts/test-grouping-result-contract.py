from __future__ import annotations

import copy
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = ROOT / "api"
if str(API) not in sys.path:
    sys.path.insert(0, str(API))

from backend.grouping import (  # noqa: E402
    GROUPING_CORE_SCHEMA,
    GROUPING_RESULT_SCHEMA,
    GroupingResultError,
    adapt_grouping_result,
    raw_tree_fingerprint,
)


class GroupingResultContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = {"paragraphs": [
            {"id": "r0", "text": "漢字", "items": [{"text": "漢字"}]},
            {"id": "r1", "text": "かんじ", "items": [{"text": "かんじ"}]},
            {"id": "r2", "text": "右かな", "items": [
                {"text": "右"}, {"text": "みぎ"}, {"text": "かな"},
            ]},
            {"id": "r3", "text": "単独", "items": [{"text": "単独"}]},
            {"id": "r4", "text": "", "items": []},
        ]}
        self.core = {
            "schema": GROUPING_CORE_SCHEMA,
            "status": "usable",
            "treeFingerprint": raw_tree_fingerprint(self.tree),
            "unresolvedIds": [],
            "groups": [
                {"id": "g-right", "memberIds": ["r0", "r1", "r2"], "separator": "", "memberPolicies": {
                    "r0": {"mode": "full"},
                    "r1": {"mode": "whole_ruby"},
                    "r2": {"mode": "item_subset", "retainedItemIndices": [0, 2], "separator": ""},
                }, "direction": "v", "bounds": [1, 2, 3, 4]},
                {"id": "g-single", "memberIds": ["r3"], "separator": "", "memberPolicies": {
                    "r3": {"mode": "full"},
                }},
            ],
        }
        self.mapping = [0, None, 1, 2, None]

    def test_member_addressed_result_preserves_order_and_content(self) -> None:
        result = adapt_grouping_result(self.core, self.tree, self.mapping)
        self.assertEqual(result["schema"], GROUPING_RESULT_SCHEMA)
        self.assertEqual([group["id"] for group in result["groups"]], ["g-right", "g-single"])
        first = result["groups"][0]
        self.assertEqual(first["paragraphIds"], ["p0", "p1"])
        self.assertEqual(first["text"], "漢字右かな")
        self.assertEqual(first["sourceContract"]["members"][1]["omission"], "whole_ruby")
        self.assertEqual(first["rubyParagraphsDropped"], 1)
        self.assertEqual(first["rubyItemsDropped"], 1)
        self.assertEqual(result["coverage"], {
            "eligible": 4, "assigned": 3, "excludedRuby": 1, "unresolved": 0,
        })

    def assert_code(self, code: str, core=None, tree=None, mapping=None) -> None:
        with self.assertRaises(GroupingResultError) as caught:
            adapt_grouping_result(
                core if core is not None else self.core,
                tree if tree is not None else self.tree,
                mapping if mapping is not None else self.mapping,
            )
        self.assertEqual(caught.exception.code, code)

    def test_fingerprint_mismatch_fails_closed(self) -> None:
        tree = copy.deepcopy(self.tree)
        tree["paragraphs"][0]["text"] = "改変"
        self.assert_code("tree_fingerprint_mismatch", tree=tree)

    def test_unresolved_fails_closed(self) -> None:
        core = copy.deepcopy(self.core)
        core["status"] = "unresolved"
        core["unresolvedIds"] = ["r3"]
        self.assert_code("grouping_unresolved", core=core)

    def test_missing_duplicate_and_bad_mapping_fail_closed(self) -> None:
        missing = copy.deepcopy(self.core)
        missing["groups"][1]["memberIds"] = []
        missing["groups"][1]["memberPolicies"] = {}
        self.assert_code("group_has_no_document_members", core=missing)

        duplicate = copy.deepcopy(self.core)
        duplicate["groups"][1]["memberIds"] = ["r0", "r3"]
        duplicate["groups"][1]["memberPolicies"]["r0"] = {"mode": "full"}
        self.assert_code("core_member_duplicate", core=duplicate)

        mapping = list(self.mapping)
        mapping[3] = 1
        self.assert_code("document_mapping_duplicate", mapping=mapping)

        duplicate_group = copy.deepcopy(self.core)
        duplicate_group["groups"][1]["id"] = "g-right"
        self.assert_code("core_group_id_duplicate", core=duplicate_group)

    def test_item_subset_is_exact_and_cannot_claim_no_removal(self) -> None:
        core = copy.deepcopy(self.core)
        core["groups"][0]["memberPolicies"]["r2"]["retainedItemIndices"] = [0, 1, 2]
        self.assert_code("item_subset_removed_nothing", core=core)

    def test_tree_fingerprint_rejects_non_json_values(self) -> None:
        with self.assertRaises(GroupingResultError) as caught:
            raw_tree_fingerprint({"paragraphs": [], "bad": {1, 2}})
        self.assertEqual(caught.exception.code, "raw_tree_not_canonical_json")

    def test_integral_float_representation_is_canonical(self) -> None:
        left = {"nested": [{"x": 1.0, "y": -0.0}, [2.5, 3.0]]}
        right = {"nested": [{"x": 1, "y": 0}, [2.5, 3]]}
        self.assertEqual(raw_tree_fingerprint(left), raw_tree_fingerprint(right))

    def test_nonfinite_number_is_rejected_at_any_depth(self) -> None:
        with self.assertRaises(GroupingResultError) as caught:
            raw_tree_fingerprint({"paragraphs": [{"bounds": [0, float("nan")]}]})
        self.assertEqual(caught.exception.code, "raw_tree_not_canonical_json")


if __name__ == "__main__":
    unittest.main()
