#!/usr/bin/env python3
"""Focused contract checks for detector-independent paragraph helpers."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.render.paragraphs import (  # noqa: E402
    bubble_key,
    group_is_ruby_only,
    paragraph_rotation,
    paragraph_text,
)


def main() -> int:
    assert paragraph_text({"text": " exact "}) == " exact "
    assert paragraph_text({"items": [{"text": "縦"}, {"text": "書き"}]}) == "縦書き"
    assert bubble_key({"bubble_bounds_px": [1.04, "2.06", 3, 4]}) == (1.0, 2.1, 3.0, 4.0)
    assert bubble_key({"bubble_bounds_px": [1, "bad", 3, 4]}) is None
    assert paragraph_rotation({"items": []}) == 0.0

    ruby = {
        "para_index": 1,
        "text": "かれ",
        "bounds_px": [30, 10, 35, 30],
        "items": [{"text": "かれ", "box": {"height": 0.05}}],
    }
    base = {
        "para_index": 2,
        "text": "彼",
        "bounds_px": [20, 8, 29, 34],
        "items": [{"text": "彼", "box": {"height": 0.12}}],
    }
    tree = {"paragraphs": [ruby, base]}
    assert group_is_ruby_only({"text": "かれ", "para_indices": [1]}, tree, 100)
    assert not group_is_ruby_only({"text": "彼", "para_indices": [2]}, tree, 100)
    print("render paragraph helper checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
