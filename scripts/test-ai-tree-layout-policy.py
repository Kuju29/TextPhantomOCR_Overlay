from __future__ import annotations

import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.render.ai_tree.builder import build_ai_tree
from backend.render.ai_tree.orientation import should_preserve_vertical_run


W, H = 1000, 1400


def item(text, bounds, rotation):
    x1, y1, x2, y2 = bounds
    return {
        "text": text,
        "bounds_px": list(bounds),
        "box": {
            "left": x1 / W, "top": y1 / H,
            "width": (x2 - x1) / W, "height": (y2 - y1) / H,
            "rotation_deg": rotation,
        },
    }


def group(text, items, direction, font=32):
    return {
        "text": text, "items": items, "direction": direction,
        "font_size_px": font, "para_indices": [0],
    }


class FakeThaiParser:
    def parse(self, text):
        # Natural Thai units; importantly, never arbitrary OCR-sized slices.
        if text == "คิดถึงมากเลย":
            return ["คิด", "ถึง", "มาก", "เลย"]
        if text == "ข้อความภาษาไทยที่ยาวและควรแบ่งบรรทัดตามคำเพื่อให้อ่านง่ายภายในกรอบเดิม":
            return ["ข้อความ", "ภาษาไทย", "ที่ยาว", "และ", "ควร", "แบ่งบรรทัด", "ตามคำ",
                    "เพื่อ", "ให้", "อ่านง่าย", "ภายใน", "กรอบเดิม"]
        return [text]


class AiTreeLayoutPolicyTests(unittest.TestCase):
    def build(self, groups, translations):
        with patch("backend.render.ai_tree.builder.budoux_parser", return_value=FakeThaiParser()):
            return build_ai_tree(groups, translations, {}, "th", W, H)

    def test_horizontal_ocr_fragments_are_reflowed_on_thai_boundaries(self):
        source = group("原文", [
            item("原", (100, 100, 180, 130), 0),
            item("文", (100, 132, 180, 162), 0),
            item("続", (100, 164, 180, 194), 0),
        ], "h")
        para = self.build([source], ["คิดถึงมากเลย"])["paragraphs"][0]
        lines = [it["text"] for it in para["items"] if it["text"]]
        self.assertEqual("".join(lines), "คิดถึงมากเลย")
        self.assertFalse({"คิ", "ถึงมา", "กเลย"} & set(lines))
        self.assertTrue(all(line in {"คิด", "ถึง", "มาก", "เลย", "คิดถึง", "ถึงมาก", "มากเลย"}
                            for line in lines))
        self.assertTrue(all(it["box"]["rotation_deg"] == 0 for it in para["items"]))

    def test_long_horizontal_thai_reflows_without_leaving_source_canvas(self):
        source = group("A long source sentence", [
            item("A long source sentence", (100, 100, 500, 150), 0),
        ], "h", font=34)
        para = self.build([source], [
            "ข้อความภาษาไทยที่ยาวและควรแบ่งบรรทัดตามคำเพื่อให้อ่านง่ายภายในกรอบเดิม"
        ])["paragraphs"][0]
        self.assertGreater(len(para["items"]), 1)
        self.assertEqual("".join(it["text"] for it in para["items"]),
                         "ข้อความภาษาไทยที่ยาวและควรแบ่งบรรทัดตามคำเพื่อให้อ่านง่ายภายในกรอบเดิม")
        x1, y1, x2, y2 = para["bounds_px"]
        for row in para["items"]:
            rx1, ry1, rx2, ry2 = row["bounds_px"]
            self.assertGreaterEqual(rx1, x1 - 1e-6)
            self.assertGreaterEqual(ry1, y1 - 1e-6)
            self.assertLessEqual(rx2, x2 + 1e-6)
            self.assertLessEqual(ry2, y2 + 1e-6)

    def test_long_single_vertical_sidebar_keeps_direction_and_geometry(self):
        text = "雪白女子柄井高校一年言いたいことは大声で言いなさい"
        src_item = item(text, (920, 80, 950, 620), 90)
        source = group(text, [src_item], "v")
        self.assertTrue(should_preserve_vertical_run(source, W, H))
        para = self.build([source], ["นักเรียนชั้นปีหนึ่งควรพูดสิ่งที่อยากพูดให้ชัดเจน"])["paragraphs"][0]
        self.assertEqual(para["direction"], "v")
        self.assertFalse(para["rotated"])
        self.assertTrue(para["preserved_vertical_run"])
        for actual, expected in zip(para["items"][0]["bounds_px"], [920.0, 80.0, 950.0, 620.0]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(para["items"][0]["box"]["rotation_deg"], 90.0)

    def test_short_vertical_singleton_may_become_horizontal(self):
        short = group("待って", [item("待って", (700, 200, 730, 330), 90)], "v")
        peer = group("右左", [
            item("右", (600, 200, 630, 330), 90),
            item("左", (565, 200, 595, 330), 90),
        ], "v")
        para = self.build([short, peer], ["รอก่อน", "ขวาซ้าย"])["paragraphs"][0]
        self.assertEqual(para["direction"], "h")
        self.assertTrue(para["rotated"])
        self.assertFalse(para["preserved_vertical_run"])
        self.assertTrue(all(it["box"]["rotation_deg"] == 0 for it in para["items"]))

    def test_single_free_angle_label_preserves_angle(self):
        source = group("ドン", [item("ドン", (300, 400, 390, 450), 27)], "h")
        para = self.build([source], ["ตึง"])["paragraphs"][0]
        self.assertFalse(para["rotated"])
        self.assertTrue(para["is_decorative_label"])
        self.assertAlmostEqual(para["canvas_rotation_deg"], 27.0)
        self.assertAlmostEqual(para["items"][0]["box"]["rotation_deg"], 27.0)

    def test_vertical_conversion_reserves_font_margin(self):
        source = group("右左", [
            item("右", (600, 200, 640, 400), 90),
            item("左", (555, 200, 595, 400), 90),
        ], "v", font=40)
        para = self.build([source], ["คิดถึงมากเลย"])["paragraphs"][0]
        self.assertTrue(para["rotated"])
        self.assertEqual(para["direction"], "h")
        # Source glyphs are 40px; conversion applies the 12% safety margin.
        self.assertLessEqual(para["para_font_size_px"], 35)
        x1, y1, x2, y2 = para["bounds_px"]
        for row in para["items"]:
            rx1, ry1, rx2, ry2 = row["bounds_px"]
            self.assertGreaterEqual(rx1, x1 - 1e-6)
            self.assertGreaterEqual(ry1, y1 - 1e-6)
            self.assertLessEqual(rx2, x2 + 1e-6)
            self.assertLessEqual(ry2, y2 + 1e-6)


if __name__ == "__main__":
    unittest.main()
