"""Regression for the native ``lens.tree.decode_tree`` bounds representation.

Lens tree paragraphs/items carry ``bounds_px`` as four-number tuples.  The
grouping fingerprint is a serialization boundary, so that native in-memory
shape must hash exactly like the JSON array sent over the Extension route.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = ROOT / "api"
if str(API) not in sys.path:
    sys.path.insert(0, str(API))

from backend.grouping import raw_tree_fingerprint  # noqa: E402


class NativeLensTreeFingerprintTests(unittest.TestCase):
    def test_native_bounds_tuples_match_wire_arrays(self) -> None:
        native_tree = {
            "side": "original",
            "paragraphs": [{
                "para_index": 0,
                "text": "日本語",
                # decode_tree builds paragraph and item bounds this way.
                "bounds_px": (10.0, 20.0, 30.0, 80.0),
                "items": [{
                    "text": "日本語",
                    "bounds_px": (10.0, 20.0, 30.0, 80.0),
                    "box": {"height": 0.06, "rotation_deg": 90.0},
                    "spans": [{"t0_raw": 4.5771398617944214e-06}],
                }],
            }],
            "diagnostics": {"drops": {}},
        }
        wire_tree = {
            **native_tree,
            "paragraphs": [{
                **native_tree["paragraphs"][0],
                "bounds_px": [10.0, 20.0, 30.0, 80.0],
                "items": [{
                    **native_tree["paragraphs"][0]["items"][0],
                    "bounds_px": [10.0, 20.0, 30.0, 80.0],
                }],
            }],
        }

        self.assertEqual(
            raw_tree_fingerprint(native_tree),
            raw_tree_fingerprint(wire_tree),
            "native Lens tuples and their JSON wire arrays are one tree",
        )

    def test_real_lens_small_decimals_are_stable(self) -> None:
        tree = {"values": [
            4.5771398617944214e-06,
            9.733258775668219e-05,
            3.3414312383683864e-07,
        ]}
        self.assertEqual(raw_tree_fingerprint(tree), raw_tree_fingerprint(tree))

    def test_unsafe_integer_is_rejected(self) -> None:
        with self.assertRaisesRegex(Exception, "raw_tree_not_canonical_json"):
            raw_tree_fingerprint({"value": 1 << 53})


if __name__ == "__main__":
    unittest.main()
