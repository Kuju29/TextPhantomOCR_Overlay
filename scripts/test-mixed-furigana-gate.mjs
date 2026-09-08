import assert from "node:assert/strict";
import { filterJapaneseFuriganaTrees } from "../src/shared/lens-decode.js";

function item(text, bounds, heightRaw) {
  return { text, bounds_px: bounds, height_raw: heightRaw, box: { rotation_deg: 90 }, spans: [] };
}

function para(text, bounds, heightRaw) {
  return { text, bounds_px: bounds, items: [item(text, bounds, heightRaw)] };
}

const ruby = para("かな", [30, 0, 35, 60], 0.01);
const base = para("魔法", [10, 0, 25, 60], 0.02);
const support = para("火炎", [50, 0, 65, 60], 0.02);
const translated = { paragraphs: [para("อ่าน", [30, 0, 35, 60], 0.01), para("เวทมนตร์", [10, 0, 25, 60], 0.02), para("เปลวไฟ", [50, 0, 65, 60], 0.02)] };

// Lens mislabeled a mixed Japanese/English page as English. Kana plus two
// independent kanji paragraphs opens inference, then the existing geometry
// proof identifies only the narrow ruby run.
const mixed = { paragraphs: [ruby, base, support] };
const positive = filterJapaneseFuriganaTrees(mixed, translated, { sourceLang: "en", imgH: 1000 });
assert.equal(positive.report.paragraphsDropped, 1);
assert.deepEqual(positive.original.paragraphs.map((entry) => entry.text), ["魔法", "火炎"]);
assert.deepEqual(positive.report.rubyOwnerRaw, { 0: 1 });

// One genuine kana caption beside one kanji title is insufficient evidence to
// override non-Japanese metadata, even if their geometry happens to resemble
// ruby. The original objects and text remain untouched.
const captionPage = { paragraphs: [ruby, base, para("SALE", [50, 0, 70, 60], 0.02)] };
const captionTranslation = { paragraphs: translated.paragraphs };
const negative = filterJapaneseFuriganaTrees(captionPage, captionTranslation, { sourceLang: "en", imgH: 1000 });
assert.equal(negative.report.paragraphsDropped, 0);
assert.equal(negative.report.itemsDropped, 0);
assert.equal(negative.original, captionPage);
assert.equal(negative.translated, captionTranslation);

// Explicit Japanese metadata preserves the established single-base behavior.
const explicit = filterJapaneseFuriganaTrees(captionPage, captionTranslation, { sourceLang: "ja", imgH: 1000 });
assert.equal(explicit.report.paragraphsDropped, 1);

console.log("Mixed-page furigana gate passed: mislabeled ruby positive, genuine kana caption negative, explicit-ja compatibility.");
