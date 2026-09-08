"""Regression guard for the tree font-fitting call contract.

This script is intentionally runnable from any working directory.  It checks
every Python call site, then executes the real helper on a representative tree
so a stale five-argument call cannot re-enter the image pipeline unnoticed.
"""

from __future__ import annotations

import ast
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
API_ROOT = ROOT / "api"
BACKEND = API_ROOT / "backend"
sys.path.insert(0, str(API_ROOT))

from backend.render.components.typography import fit_tree_font_sizes  # noqa: E402


bad_calls: list[str] = []
for path in BACKEND.rglob("*.py"):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "fit_tree_font_sizes":
            continue
        if len(node.args) != 3 or node.keywords:
            bad_calls.append(f"{path.relative_to(ROOT)}:{node.lineno}")

assert not bad_calls, (
    "fit_tree_font_sizes accepts exactly (tree, img_w, img_h); "
    f"stale call sites: {bad_calls}"
)

sample_tree = {
    "paragraphs": [
        {
            "para_index": 7,
            "items": [
                {
                    "text": "ทดสอบ",
                    "box": {"width_pct": 20.0, "height_pct": 10.0},
                }
            ],
        }
    ]
}
sizes = fit_tree_font_sizes(sample_tree, 600, 900)
assert sizes == {7: sample_tree["paragraphs"][0]["para_font_size_px"]}
assert sample_tree["paragraphs"][0]["items"][0]["font_size_px"] >= 9

print("Typography call contract passed: all call sites use (tree, img_w, img_h).")
