// Two AI bubbles must never be drawn through each other.
//
// The bug this guards, in two halves:
//
// 1. `expandDirectionChangeCanvas` grows a tall vertical source box into a
//    landscape one so a Thai translation can wrap in it. Its peer clamp only
//    fired for a peer whose far edge already cleared the block
//    (`px2 <= left && px2 > nextLeft`), which is false for the ordinary case
//    of a neighbour a column of whitespace away — so two neighbouring bubbles
//    both expanded into the SAME gap. It then wrote `left = nextLeft` while
//    computing `width = max(width, nextRight - nextLeft)`, so a block squeezed
//    from both sides kept its width and slid out of its own bubble.
//
// 2. When grouping DOES hand the renderer two units whose source columns
//    overlap (a region spliced across two balloons), the renderer has no
//    honest second place to draw and must say so instead of stacking two
//    translations in one spot in silence.
//
// Reported as: two Thai blocks printed on top of each other in the white space
// between two speech balloons on a vertical Japanese page.
import assert from "node:assert/strict";
import { renderOverlay } from "../src/processors/render-overlay.js";

// --- the smallest DOM this renderer needs ------------------------------------
function makeEl() {
  const el = {
    _cls: [],
    children: [],
    style: { cssText: "" },
    textContent: "",
    attrs: {},
    set className(v) { el._cls = String(v).split(/\s+/).filter(Boolean); },
    get className() { return el._cls.join(" "); },
    classList: { add: (...c) => el._cls.push(...c) },
    appendChild: (c) => { el.children.push(c); return c; },
    setAttribute: (k, v) => { el.attrs[k] = v; },
  };
  return el;
}
globalThis.document = { createElement: () => makeEl() };

const W = 1350;
const H = 1920;

/** One vertical Lens column as a LensDocument item. */
function column(text, [x1, y1, x2, y2], rotation = 90) {
  const cx = (x1 + x2) / 2;
  return {
    text,
    height: (x2 - x1) / H,        // perpendicular thickness = glyph height
    rotation,
    baseline: [[cx / W, y1 / H], [cx / W, y2 / H]],
    valid_text: true,
  };
}

function para(id, text, box) {
  return { id, sourceText: text, items: [column(text, box)] };
}

/** Build a document whose groups are already resolved, then render the AI layer. */
function render(specs) {
  const paragraphs = [];
  const groups = [];
  for (const spec of specs) {
    const ids = [];
    spec.columns.forEach((box, index) => {
      const id = `${spec.id}${index}`;
      ids.push(id);
      paragraphs.push(para(id, spec.source || "…", box));
    });
    groups.push({ id: spec.id, paragraphIds: ids, direction: "v", text: spec.source || "…" });
    const leader = paragraphs.find((p) => p.id === ids[0]);
    leader.aiText = spec.ai;
    if (ids.length > 1) {
      leader.aiGroupParagraphIds = ids.slice();
      for (const id of ids.slice(1)) paragraphs.find((p) => p.id === id).aiCoveredBy = ids[0];
    }
  }
  const doc = {
    image: { width: W, height: H },
    languages: { source: "ja", target: "th" },
    paragraphs,
    groups,
    uncoveredParagraphIds: [],
  };
  const { root, report } = renderOverlay(doc, { source: "ai" });
  assert.equal(report.error, undefined, `renderer refused the document: ${report.error}`);

  const boxes = [];
  (function walk(el) {
    if (el._cls?.includes("tp-line")) {
      const style = Object.fromEntries(
        el.style.cssText.split(";").filter(Boolean).map((kv) => {
          const i = kv.indexOf(":");
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const pct = (k) => parseFloat(style[k]);
      const left = (pct("left") / 100) * W;
      const top = (pct("top") / 100) * H;
      boxes.push({
        text: el.textContent,
        left,
        top,
        right: left + (pct("width") / 100) * W,
        bottom: top + (pct("height") / 100) * H,
      });
    }
    for (const child of el.children || []) walk(child);
  })(root);
  return { boxes, report };
}

const overlapArea = (a, b) => (
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
);

// --- 1. two balloons offset diagonally, grouped correctly --------------------
// Each translation belongs inside its own balloon, and nowhere near the other.
{
  const balloonA = [[1155, 870, 1200, 1050], [1080, 870, 1125, 1070], [995, 870, 1040, 985]];
  const balloonB = [[1080, 1105, 1125, 1330], [1000, 1105, 1045, 1320], [915, 1105, 960, 1220]];
  const { boxes, report } = render([
    { id: "A", columns: balloonA, source: "勇者は強くなりすぎると暴走する", ai: "ผู้กล้าที่แข็งแกร่งเกินไปจะอาละวาด" },
    { id: "B", columns: balloonB, source: "女王の言った意見は我も同じだ", ai: "ข้าเองก็มีความเห็นเช่นนั้น ราชินีกล่าวไว้" },
  ]);
  assert.equal(boxes.length, 2, "one block per bubble");
  assert.equal(report.aiBlocksOverlapping, 0, "correctly grouped bubbles must not collide");
  for (const box of boxes) assert.equal(overlapArea(box, box === boxes[0] ? boxes[1] : boxes[0]), 0);

  const inside = (box, columns) => {
    const y1 = Math.min(...columns.map((c) => c[1]));
    const y2 = Math.max(...columns.map((c) => c[3]));
    return box.top >= y1 - 1 && box.bottom <= y2 + 1;
  };
  assert.ok(inside(boxes[0], balloonA), "balloon A's translation must stay inside balloon A");
  assert.ok(inside(boxes[1], balloonB), "balloon B's translation must stay inside balloon B");
}

// --- 2. two single-column bubbles side by side -------------------------------
// Both are tall and narrow, so both want the direction-change expansion, and
// there is one gap between them to expand into. Each may take half of it.
{
  // 70px of whitespace between them. Each wants ~142px of width, so the two
  // wishes do not both fit and the gap has to be shared.
  const leftInk = [1040, 800, 1085, 1100];
  const rightInk = [1155, 800, 1200, 1100];
  const { boxes, report } = render([
    { id: "L", columns: [leftInk], source: "しずかに", ai: "เงียบ ๆ หน่อยสิ" },
    { id: "R", columns: [rightInk], source: "まってくれ", ai: "รอเดี๋ยวก่อนสิ" },
  ]);
  assert.equal(boxes.length, 2);
  assert.equal(
    overlapArea(boxes[0], boxes[1]), 0,
    `two neighbouring bubbles both expanded into the same gap: ` +
    `${JSON.stringify(boxes.map((b) => [Math.round(b.left), Math.round(b.right)]))}`,
  );
  assert.equal(report.aiBlocksOverlapping, 0);
  // Neither canvas may cross onto the other's ink, and neither may shrink off
  // its own — the expansion is a convenience, the source extent is the truth.
  for (const [box, ink, other] of [[boxes[0], leftInk, rightInk], [boxes[1], rightInk, leftInk]]) {
    assert.ok(box.left <= ink[0] + 1 && box.right >= ink[2] - 1,
      "a canvas must still contain the ink it was built from");
    assert.ok(box.right <= other[0] || box.left >= other[2],
      "a canvas must not extend over its neighbour's ink");
  }
}

// --- 3. grouping spliced a region: say so, do not draw it in silence ---------
// Two units whose SOURCE columns interleave. The renderer cannot place them
// apart, so it must name the collision in the report.
{
  // These are the exact sets the old 1-D splitter produced for the reported
  // page: 勇者は強くなりすぎると / 女王の言った意見は我も / 暴走する同じだ.
  const { boxes, report } = render([
    {
      id: "X",
      columns: [[1155, 870, 1200, 1050], [1080, 870, 1125, 1070]],
      source: "勇者は強くなりすぎると",
      ai: "ผู้กล้าที่แข็งแกร่งเกินไป",
    },
    {
      id: "Y",
      columns: [[1080, 1105, 1125, 1330], [1000, 1105, 1045, 1320]],
      source: "女王の言った意見は我も",
      ai: "ความเห็นที่ราชินีกล่าวไว้",
    },
    {
      // one column from each balloon — the splice itself
      id: "Z",
      columns: [[995, 870, 1040, 985], [915, 1105, 960, 1220]],
      source: "暴走する同じだ",
      ai: "อาละวาดเหมือนกัน",
    },
  ]);
  assert.equal(boxes.length, 3);
  assert.ok(
    report.aiBlocksOverlapping >= 1,
    "a spliced region draws two translations in one place; the report must say so",
  );
  assert.ok(
    report.aiBlocksOverlappingIds.includes("Y0|Z0"),
    `the colliding pair must be named, got ${JSON.stringify(report.aiBlocksOverlappingIds)}`,
  );
}

console.log(
  "AI block layout test passed: neighbours split the gap between them, a canvas "
  + "never leaves its own ink, and an unavoidable collision is named.",
);
