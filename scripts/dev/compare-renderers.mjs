// DEV TOOL - not part of `npm run build`, and it needs two things this project
// does NOT depend on: playwright (for a real Chromium) and a static server for
// src/. It renders one synthetic page through the REAL extension renderer and
// prints the font sizes, so they can be compared with the API renderer's
// (scripts/dev/compare-renderers.py, which prints the same table).
//
//   python3 -m http.server 8899 --directory src &
//   node scripts/dev/compare-renderers.mjs translated own-items
//   python3 scripts/dev/compare-renderers.py
//
// Variants: own-items | no-own-items | one-long-item
import pw from "playwright";
import { readFile } from "node:fs/promises";

const W = 1200, H = 1800;
const item = (x1, y1, x2, y2, heightPx, text) => ({
  id: `${x1}-${y1}`,
  baseline: [[x1 / W, y1 / H], [x2 / W, y2 / H]],
  height: heightPx / H,
  rotation: 0,
  text,
});

// Same bubble, same two lines, same box maths as the Python script.
const doc = {
  schema: "tp.lens-document/1",
  image: { width: W, height: H },
  languages: { source: "ja", target: "th" },
  paragraphs: [{
    id: "p0",
    sourceText: "こんにちは みんな",
    lensText: "สวัสดีครับ ทุกคน",
    items: [item(300, 400, 700, 400, 34, "こんにちは"), item(300, 448, 660, 448, 34, "みんな")],
    lensItems: [item(300, 400, 700, 400, 34, "สวัสดีครับ"), item(300, 448, 660, 448, 34, "ทุกคน")],
    textLight: false,
  }],
};

const source = process.argv[2] || "translated";
const variant = process.argv[3] || "own-items";
if (variant === "no-own-items") delete doc.paragraphs[0].lensItems;
if (variant === "one-long-item") {
  doc.paragraphs[0].items = [item(300, 400, 700, 400, 34, "こんにちは みんな")];
  doc.paragraphs[0].lensItems = [item(300, 400, 700, 400, 34, "สวัสดีครับ ทุกคน")];
}
const rendererSrc = await readFile(new URL("../../src/processors/render-overlay.js", import.meta.url), "utf8");
const metricsSrc = await readFile(new URL("../../src/processors/text-metrics.js", import.meta.url), "utf8");
const documentSrc = await readFile(new URL("../../src/shared/lens-document.js", import.meta.url), "utf8");

const browser = await pw.chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8899/");

const result = await page.evaluate(async ([doc, source]) => {
  const mod = await import("http://127.0.0.1:8899/processors/render-overlay.js");
  const { root, report } = mod.renderOverlay(doc, { source });
  const sizes = [];
  for (const node of root.querySelectorAll(".tp-line")) {
    const match = /font-size:\s*calc\(var\(--tp-font-scale,\s*1\)\s*\*\s*([\d.]+)px\)/.exec(
      node.getAttribute("style") || "",
    );
    if (match) sizes.push(Number(match[1]));
  }
  return { sizes, report, html: root.innerHTML.slice(0, 400) };
}, [doc, source]);

console.log(JSON.stringify(result, null, 1));
await browser.close();
