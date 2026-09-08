import assert from "node:assert/strict";
import {
  decodeLegacyTranslations,
  decodeTranslations,
} from "../src/shared/ai/direct-local/decode.js";

const units = [{ id: "a" }, { id: "b" }];
const wireUnits = [{ id: "P0" }, { id: "P1" }];
const options = { compactMarkers: true, wireUnits };

const valid = decodeTranslations("<<TP_P1:สอง>>\n<<TP_P0:หนึ่ง>>", units, options);
assert.deepEqual(valid.translations, [
  { id: "a", text: "หนึ่ง" },
  { id: "b", text: "สอง" },
]);
const spaced = decodeTranslations(
  "<<TP_P0:  leading and trailing   >>\n<<TP_P1:multiple   internal spaces>>",
  units,
  options,
);
assert.equal(spaced.translations[0].text, "  leading and trailing   ");
assert.equal(spaced.translations[1].text, "multiple   internal spaces");
assert.equal(spaced.acceptedLosslessly, true);
assert.equal(spaced.contentModified, false);

const whitespaceOnly = decodeTranslations("<<TP_P0:   >>\n<<TP_P1:value>>", units, options);
assert.equal(whitespaceOnly.translations[0].text, "   ", "whitespace-only value remains observable");
assert.deepEqual(whitespaceOnly.missing, ["a"], "whitespace-only value is explicitly classified empty");

for (const raw of [
  '{"translations":[{"id":"P0","text":"หนึ่ง"}],"memo":""}',
  "<<TP_P0>>\nหนึ่ง\n<<TP_END>>",
  "<<TP_P0>>\nหนึ่ง\n<<TP_DONE>>",
  "หนึ่ง",
]) {
  const absent = decodeTranslations(raw, [{ id: "a" }], { compactMarkers: true, wireUnits: [{ id: "P0" }] });
  assert.deepEqual(absent.missing, ["a"]);
}

const prose = decodeTranslations(
  "commentary\n<<TP_P0:หนึ่ง>>\ntrailing", [{ id: "a" }], {
    compactMarkers: true, wireUnits: [{ id: "P0" }],
  },
);
assert.equal(prose.translations[0].text, "หนึ่ง");
assert.equal(prose.diagnostics.ignoredProse, true);
assert.doesNotMatch(JSON.stringify(prose.diagnostics), /หนึ่ง|commentary|trailing/);

const duplicate = decodeTranslations("<<TP_P0:a>>\n<<TP_P0:b>>\n<<TP_P1:c>>", units, options);
assert.deepEqual(duplicate.missing, ["a"]);
assert.deepEqual(duplicate.diagnostics.duplicateIds, ["P0"]);
const unknown = decodeTranslations("<<TP_P0:a>>\n<<TP_P9:ignored>>\n<<TP_P1:b>>", units, options);
assert.deepEqual(unknown.translations.map((item) => item.text), ["a", "b"]);
assert.deepEqual(unknown.diagnostics.ignoredUnknownIds, ["P9"]);

const missing = decodeTranslations("<<TP_P0:a>>", units, options);
assert.deepEqual(missing.translations, [{ id: "a", text: "a" }, { id: "b", text: "" }]);
assert.deepEqual(missing.missing, ["b"]);
assert.equal(missing.diagnostics.validatorSubtype, "repairable_ids");
const empty = decodeTranslations("<<TP_P0:>>\n<<TP_P1:b>>", units, options);
assert.deepEqual(empty.missing, ["a"]);
assert.equal(empty.diagnostics.validatorSubtype, "repairable_ids");

const literalClose = decodeTranslations(
  "นอกกรอบ <<TP_P1:สอง >> ยังอยู่>><<TP_P0:หนึ่ง>> ท้าย", units, options,
);
assert.deepEqual(literalClose.translations.map((item) => item.text), ["หนึ่ง", "สอง "]);

const malformedIsland = decodeTranslations(
  "<<TP_P0:หนึ่ง>><<TP_P1 broken>><<TP_P2:สาม>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(malformedIsland.translations, [
  { id: "a", text: "หนึ่ง" }, { id: "b", text: "broken" }, { id: "c", text: "สาม" },
]);
assert.deepEqual(malformedIsland.missing, []);
const newlineSeparator = decodeTranslations(
  "<<TP_P0\nline>>",
  [{ id: "a" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }] },
);
assert.deepEqual(newlineSeparator.translations, [{ id: "a", text: "line" }]);
const balancedNested = decodeTranslations(
  "<<TP_P2:สาม<<TP_P1 broken>>>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(balancedNested.translations.map((item) => item.text), ["", "broken", "สาม"]);
assert.deepEqual(balancedNested.missing, ["a"]);
const nestedSuffix = decodeTranslations(
  "<<TP_P0:before<<TP_P1:child>>after>>",
  [{ id: "a" }, { id: "b" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }] },
);
assert.deepEqual(nestedSuffix.translations.map((item) => item.text), ["beforeafter", "child"]);
const peerBridge = decodeTranslations(
  "<<TP_P1:broken1<<>>TP_P2 broken2>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(peerBridge.translations.map((item) => item.text), ["", "broken1", "broken2"]);
assert.deepEqual(peerBridge.missing, ["a"]);
const unfinishedPeerBridge = decodeTranslations(
  "<<TP_P0:one<<>>TP_P1 two",
  [{ id: "a" }, { id: "b" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }] },
);
assert.deepEqual(unfinishedPeerBridge.translations.map((item) => item.text), ["", ""]);
assert.deepEqual(unfinishedPeerBridge.missing, ["a", "b"]);
const ordinaryEmptyAngles = decodeTranslations(
  "<<TP_P0:value<<>>not-a-peer>>",
  [{ id: "a" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }] },
);
assert.deepEqual(ordinaryEmptyAngles.translations, [{ id: "a", text: "" }]);
assert.deepEqual(ordinaryEmptyAngles.missing, ["a"]);
const invalidIslandToken = decodeTranslations(
  "<<TP_P0:one>><<TP_P1:broken1<<broken>>TP_P2 broken2>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(invalidIslandToken.translations.map((item) => item.text), ["one", "", ""]);
assert.deepEqual(invalidIslandToken.missing, ["b", "c"]);
const unbalancedNested = decodeTranslations(
  "<<TP_P0:หนึ่ง>><<TP_P2:สาม<<TP_P1 broken>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(unbalancedNested.translations.map((item) => item.text), ["หนึ่ง", "", ""]);
assert.deepEqual(unbalancedNested.missing, ["b", "c"]);
const unclosedAndUnknown = decodeTranslations(
  "<<TP_P0:หนึ่ง>><<TP_P1:ขาดปิด<<TP_P9 broken>><<TP_P2:สาม>>",
  [{ id: "a" }, { id: "b" }, { id: "c" }],
  { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
);
assert.deepEqual(unclosedAndUnknown.translations.map((item) => item.text), ["หนึ่ง", "", ""]);
assert.deepEqual(unclosedAndUnknown.missing, ["b", "c"]);
for (const malformed of ["<<TP_P1abc>>", "<<TP_P1_x>>", "<<TP_P broken>>"]) {
  const isolated = decodeTranslations(
    `<<TP_P0:หนึ่ง>>${malformed}<<TP_P2:สาม>>`,
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    { compactMarkers: true, wireUnits: [{ id: "P0" }, { id: "P1" }, { id: "P2" }] },
  );
  assert.deepEqual(isolated.translations.map((item) => item.text), ["หนึ่ง", "", "สาม"]);
  assert.deepEqual(isolated.missing, ["b"]);
}

const legacy = decodeLegacyTranslations("<<TP_P0>>\nหนึ่ง\n<<TP_END>>", [{ id: "a" }], {
  compactMarkers: true,
  wireUnits: [{ id: "P0" }],
});
assert.equal(legacy.translations[0].text, "หนึ่ง");

console.log("strict AI output contract tests passed");
