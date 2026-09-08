import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderOverlay } from "../src/processors/render/renderer.js";

function element(tag) {
  const node = {
    tag, children: [], attrs: {}, _classes: [], textContent: "", style: { cssText: "" },
    set className(value) { node._classes = String(value).split(/\s+/).filter(Boolean); },
    get className() { return node._classes.join(" "); },
    classList: { add: (...values) => node._classes.push(...values) },
    appendChild(child) { node.children.push(child); return child; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
  };
  return node;
}

const ownerDocument = { createElement: (tag) => element(tag) };
const fixture = JSON.parse(await readFile(new URL("./fixtures/renderer-golden.json", import.meta.url), "utf8"));

function lines(root) {
  const output = [];
  function visit(node) {
    if (node._classes?.includes("tp-line")) output.push({
      paragraph: node.attrs["data-tp-para"] || "", classes: node.className,
      style: node.style.cssText, text: node.textContent,
    });
    for (const child of node.children || []) visit(child);
  }
  visit(root);
  return output;
}

function render(source, options = {}) {
  const { root, report } = renderOverlay(structuredClone(fixture), { source, ownerDocument, ...options });
  assert.equal(report.error, undefined);
  return { lines: lines(root), report };
}

const actual = {
  original: render("original"),
  translated: render("translated", { relayoutTranslated: false }),
  translatedGrouped: render("translated", { relayoutTranslated: true }),
  ai: render("ai"),
};
const expected = JSON.parse(await readFile(new URL("./fixtures/renderer-golden.expected.json", import.meta.url), "utf8"));
assert.deepEqual(actual, expected);

assert.equal(actual.translatedGrouped.report.groupsDrawn, 1);
assert.equal(actual.ai.report.groupsDrawn, 1);
assert.equal(actual.ai.report.coveredByGroup, 1);
assert.equal(actual.ai.lines.filter((line) => line.paragraph === "vertical-right").length, 1);
assert.equal(actual.ai.lines.filter((line) => line.paragraph === "vertical-left").length, 0);

const hostile = actual.ai.lines.find((line) => line.paragraph === "horizontal");
assert.equal(hostile.text, "ข้อความ AI <script>alert(1)</script>");
assert.equal(Object.hasOwn(hostile, "innerHTML"), false);

const secondImage = structuredClone(fixture);
secondImage.paragraphs = [structuredClone(fixture.paragraphs[0])];
secondImage.groups = [];
secondImage.paragraphs[0].id = "second-image";
secondImage.paragraphs[0].sourceText = "SECOND";
secondImage.paragraphs[0].items[0].text = "SECOND";
secondImage.paragraphs[0].aiText = "ภาพที่สอง";
const second = renderOverlay(secondImage, { source: "ai", ownerDocument });
const secondLines = lines(second.root);
assert.deepEqual(secondLines.map((line) => line.paragraph), ["second-image"]);
assert.ok(secondLines.every((line) => !line.text.includes("ข้อความ AI")));

console.log("Renderer golden passed: Original/Translated/AI, horizontal/vertical/Lens groups, ownership and text escaping.");
