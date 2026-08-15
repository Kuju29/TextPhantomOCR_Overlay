# Renders one synthetic page through the API renderer and prints every
# font-size it emitted, so the extension renderer can be compared to it.
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "api"))
from backend.render.tp_html import render_tree_overlay  # noqa: E402

W, H = 1200, 1800


def item(x1, y1, x2, y2, height_norm, text):
    """Same construction as backend/lens/tree.py: baseline + height."""
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    length = abs(x2 - x1)
    height_px = height_norm * H
    return {
        "text": text,
        "valid_text": True,
        "height_raw": height_norm,
        "baseline_p1": {"x": x1 / W, "y": y1 / H},
        "baseline_p2": {"x": x2 / W, "y": y2 / H},
        "box": {
            "left": (cx - length / 2.0) / W,
            "top": (cy - height_px / 2.0) / H,
            "width": length / W,
            "height": height_px / H,
            "rotation_deg": 0.0,
            "rotation_deg_css": 0.0,
            "center": {"x": cx / W, "y": cy / H},
        },
        "spans": [],
    }


# One horizontal bubble, two lines - the ordinary manhwa case.
PARA = {
    "text": "สวัสดีครับ ทุกคน",
    "items": [
        item(300, 400, 700, 400, 34 / H, "สวัสดีครับ"),
        item(300, 448, 660, 448, 34 / H, "ทุกคน"),
    ],
}
TREE = {"side": "translated", "paragraphs": [PARA], "text": "สวัสดีครับ ทุกคน"}

html = render_tree_overlay(TREE, W, H)
sizes = [float(m) for m in re.findall(r"font-size:calc\(var\(--tp-font-scale,1\) \* ([\d.]+)px\)", html)]
print(json.dumps({"sizes": sizes, "lines": html.count('class="tp-line')}, ensure_ascii=False))
