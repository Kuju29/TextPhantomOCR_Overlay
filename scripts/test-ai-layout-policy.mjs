import assert from "node:assert/strict";
import { buildAiLineLayout } from "../src/processors/render/line-layout.js";

const W = 1000, H = 1500;
const block = (left, top, width, height, rotation = 0) => ({
  leftPct: left / W * 100, topPct: top / H * 100,
  widthPct: width / W * 100, heightPct: height / H * 100,
  rotation, text: "",
});
const sourceItem = (height, rotation = 0) => ({ height: height / H, rotation });
const layout = (entry) => buildAiLineLayout(entry, [entry], W, H, "th");

// Multi-column Japanese dialogue -> horizontal, smaller Thai inside the same canvas.
{
  const rows = layout({ text: "นี่คือข้อความภาษาไทยที่ยาวกว่าต้นฉบับและต้องลดขนาดเพื่อวางให้พอดีในกรอบ",
    sourceVertical: true, sourceRole: "dialogue", block: block(640, 180, 110, 340, 90),
    fontPx: 60, sourceItems: [sourceItem(60, 90), sourceItem(60, 90)] });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.geometry.rotation === 0));
  assert.ok(rows.every((row) => row.fontPx < 60));
}

// A long narrow singleton is a vertical sign/caption. Page orientation must
// not flatten it or split it into dialogue rows.
{
  const rows = layout({ text: "ข้อมูลผลงาน กิจกรรม และรายละเอียดอื่น ๆ",
    sourceVertical: true, sourceRole: "caption", block: block(850, 100, 35, 800, 90),
    fontPx: 35, sourceItems: [sourceItem(35, 90)] });
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].geometry.rotation - 90) <= 1);
}

// Free-angle artwork keeps its measured angle.
{
  const rows = layout({ text: "ตู้ม", sourceVertical: false, sourceRole: "sfx",
    block: block(300, 300, 300, 100, 30), fontPx: 40,
    sourceItems: [sourceItem(40, 30)] });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => Math.abs(row.geometry.rotation - 30) <= 0.1));
}

// Exact 90-degree short dialogue is allowed to horizontalize for Thai.
{
  const rows = layout({ text: "รอก่อน", sourceVertical: true, sourceRole: "dialogue",
    block: block(700, 200, 35, 100, 90), fontPx: 32,
    sourceItems: [sourceItem(32, 90)] });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => Math.abs(row.geometry.rotation) <= 0.1));
}

// Horizontal source uses target-text-driven Thai wrapping rather than one
// Lens item forcing a long sentence into a single undersized row.
{
  const rows = layout({ text: "ข้อความภาษาไทยที่ยาวและควรแบ่งบรรทัดตามคำเพื่อให้อ่านง่ายภายในกรอบเดิม",
    sourceVertical: false, sourceRole: "dialogue", block: block(100, 90, 400, 140, 0),
    fontPx: 34, sourceItems: [sourceItem(34, 0)] });
  assert.equal(rows.length, 1, "Thai should remain one compact browser-wrapped block");
  assert.ok(rows[0].fontPx < 34, "target-token wrapping must reduce an overlarge source font");
  assert.equal(rows[0].text, "ข้อความภาษาไทยที่ยาวและควรแบ่งบรรทัดตามคำเพื่อให้อ่านง่ายภายในกรอบเดิม");
}

console.log("Extension AI layout policy passed: fitting, signs, free angles and Thai wrapping.");
