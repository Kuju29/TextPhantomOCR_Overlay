// Pure, source-aware diagnostics used by the bounded repair planner.
const SCRIPT_TESTS = Object.freeze([
  ["thai", /\p{Script=Thai}/u],
  ["lao", /\p{Script=Lao}/u],
  ["han", /\p{Script=Han}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["bengali", /\p{Script=Bengali}/u],
  ["gurmukhi", /\p{Script=Gurmukhi}/u],
  ["gujarati", /\p{Script=Gujarati}/u],
  ["oriya", /\p{Script=Oriya}/u],
  ["tamil", /\p{Script=Tamil}/u],
  ["telugu", /\p{Script=Telugu}/u],
  ["kannada", /\p{Script=Kannada}/u],
  ["malayalam", /\p{Script=Malayalam}/u],
  ["sinhala", /\p{Script=Sinhala}/u],
  ["khmer", /\p{Script=Khmer}/u],
  ["myanmar", /\p{Script=Myanmar}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["georgian", /\p{Script=Georgian}/u],
  ["ethiopic", /\p{Script=Ethiopic}/u],
  ["syriac", /\p{Script=Syriac}/u],
  ["thaana", /\p{Script=Thaana}/u],
  ["tibetan", /\p{Script=Tibetan}/u],
  ["mongolian", /\p{Script=Mongolian}/u],
]);
const EAST_ASIAN_STRICT = new Set(["lao", "han", "kana", "hangul", "thai"]);
const SOURCE_PRESERVABLE_ALPHABETIC = new Set([
  "cyrillic", "greek", "arabic", "hebrew", "devanagari", "bengali",
  "gurmukhi", "gujarati", "oriya", "tamil", "telugu", "kannada",
  "malayalam", "sinhala", "khmer", "myanmar", "armenian", "georgian",
  "ethiopic", "syriac", "thaana", "tibetan", "mongolian",
]);
const SUMMARY_PRIMARY_SCRIPTS = new Set([
  "thai", "lao", "kana", "han", "hangul", "latin", "cyrillic",
  "greek", "arabic", "devanagari", "bengali", "gurmukhi", "gujarati",
  "oriya", "tamil", "telugu", "kannada", "malayalam", "sinhala",
]);
const normalizeComparable = value => String(value || "").normalize("NFKC");
function scriptOf(char) {
  if (!/\p{L}/u.test(char)) return "";
  for (const [name, regex] of SCRIPT_TESTS) if (regex.test(char)) return name;
  return "other";
}
function scriptSummary(text) {
  const counts = {};
  for (const char of String(text || "")) {
    const name = scriptOf(char);
    if (name) counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}
function scriptRuns(text, wantedScript) {
  const runs = [];
  let current = null;
  for (const char of String(text || "")) {
    const name = scriptOf(char);
    if (!name || name === wantedScript || name === "latin") {
      current = null;
      continue;
    }
    if (current?.script === name) current.text += char;
    else {
      current = { script: name, text: char };
      runs.push(current);
    }
  }
  return runs;
}
function sourceContainsRun(source, run) {
  const value = normalizeComparable(run);
  return Boolean(value) && normalizeComparable(source).includes(value);
}

export function diagnoseTargetScripts(
  translations,
  targetLang,
  sourceUnits = [],
) {
  const rawTarget = String(targetLang || "")
    .trim()
    .toLowerCase();
  const target = /^(?:th|tha)(?:[-_]|$)|\bthai\b|ภาษาไทย/u.test(rawTarget)
    ? "th"
    : /^(?:ko|kor)(?:[-_]|$)|\bkorean\b|한국어/u.test(rawTarget)
      ? "ko"
      : rawTarget.split(/[-_]/)[0];
  if (!new Set(["th", "ko"]).has(target)) return [];
  const targetScript = target === "th" ? "thai" : "hangul";
  const sourceById = new Map(
    (sourceUnits || []).map((item) => [
      String(item?.id || ""),
      String(item?.text || ""),
    ]),
  );
  const diagnostics = [];
  for (const item of translations || []) {
    const text = String(item?.text || "");
    const source = sourceById.get(String(item?.id || "")) || "";
    const trimmed = text.trim();
    const sourceTrimmed = source.trim();
    const preservedIdentifier =
      trimmed === sourceTrimmed &&
      trimmed.length > 0 &&
      /^[\x20-\x7e]+$/u.test(trimmed) &&
      (/^@[a-z0-9_][a-z0-9_.-]{0,63}$/iu.test(trimmed) ||
        /^\+{2,}\s*[A-Z0-9_.-]{2,40}\s+(?:TRANSLATIONS?|SCANLATIONS?)$/u.test(trimmed) ||
        /^(?:https?:\/\/|www\.)\S+$/iu.test(trimmed) ||
        /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu.test(
          trimmed,
        ) ||
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2}|com|net|org|edu|gov|mil|int|info|biz|name|mobi|app|dev|xyz|online|site|store|tech|cloud|space)(?::\d+)?(?:\/\S*)?$/iu.test(
          trimmed,
        ) ||
        /^(?:[a-z]:[\\/]|\\\\|\/)(?:[^\\/\s]+[\\/])*[^\\/\s]*$/iu.test(
          trimmed,
        ) ||
        /^(?:\.{1,2}[\\/])?(?:[^\\/\s]+[\\/])+[^\\/\s]+\.[a-z0-9]{1,10}$/iu.test(
          trimmed,
        ) ||
        /^(?=[a-z0-9_.-]*\d)(?=(?:[^_.-]*[_.-]){2})[a-z0-9]+(?:[_.-][a-z0-9]+)+$/iu.test(
          trimmed,
        ) ||
        /^(?=[a-z0-9_.:-]*\d)[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.:-]*$/iu.test(
          trimmed,
        ) ||
        /^(?:v?\d+)(?:\.\d+)+(?:[-_][a-z0-9]+)?$/iu.test(trimmed));
    if (preservedIdentifier) {
      diagnostics.push({
        id: String(item?.id || ""),
        targetScript,
        detectedScripts: {},
        targetChars: 0,
        foreignChars: 0,
        decision: "accept",
        reason: "preserved_identifier",
      });
      continue;
    }

    const counts = scriptSummary(text);
    const wanted = counts[targetScript] || 0;
    const latinChars = counts.latin || 0;
    const letters = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const otherLetters = Math.max(0, letters - wanted);
    const hardCounts = Object.fromEntries(
      Object.entries(counts).filter(([name, value]) =>
        value > 0 && name !== targetScript && name !== "latin"),
    );
    const hardForeign = Object.values(hardCounts).reduce((sum, value) => sum + value, 0);
    const runs = scriptRuns(text, targetScript);
    const attributedRuns = runs.map((run) => ({
      ...run,
      chars: Array.from(run.text).length,
      inSource: sourceContainsRun(source, run.text),
    }));
    const inventedCount = attributedRuns
      .filter((run) => !run.inSource)
      .reduce((sum, run) => sum + run.chars, 0);
    const strictForeign = attributedRuns
      .filter((run) => EAST_ASIAN_STRICT.has(run.script))
      .reduce((sum, run) => sum + run.chars, 0);
    const preservableRuns = attributedRuns.filter((run) =>
      SOURCE_PRESERVABLE_ALPHABETIC.has(run.script));
    const allPreservableRunsAttributed =
      preservableRuns.length > 0 &&
      preservableRuns.length === attributedRuns.length &&
      preservableRuns.every((run) => run.inSource && run.chars <= 24);

    // A short English word can otherwise hide inside an apparently Thai
    // sentence (for example "ถifฉัน..."). This remains a warning only: Latin
    // is commonly the source script and may legitimately survive as a name,
    // acronym, title, URL or technical token.
    const protectedLatinSpans = [
      ...trimmed.matchAll(
        /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:v?\d+(?:\.\d+)+|[A-Za-z0-9]+(?:[-_.:/][A-Za-z0-9]+){2,})\b/giu,
      ),
    ].map((match) => [match.index, match.index + match[0].length]);
    const unexpectedEmbeddedLatin = [
      ...trimmed.matchAll(/\p{Script=Latin}{2,}/gu),
    ].some((match) => {
      const run = match[0];
      const start = match.index;
      const end = start + run.length;
      if (protectedLatinSpans.some(([left, right]) => start >= left && end <= right))
        return false;
      if (run !== run.toLocaleLowerCase("en-US")) return false;
      return /\p{Script=Thai}/u.test(trimmed.slice(0, start).at(-1) || "") &&
        /\p{Script=Thai}/u.test(trimmed[end] || "");
    });

    const laoCount = hardCounts.lao || 0;
    const boundedLaoConfusable =
      target === "th" && laoCount === hardForeign && laoCount <= 2 && wanted >= 3;
    const standaloneSourceGlyph =
      Array.from(trimmed).length === 1 && normalizeComparable(source).includes(normalizeComparable(trimmed));
    const boundedSourceGlyph =
      hardForeign === 1 && inventedCount === 0 && (wanted >= 3 || standaloneSourceGlyph);
    // Source-native alphabetic names/terms may remain inside an otherwise valid
    // target sentence. They must be exact source substrings, bounded, and never
    // replace the whole translation. CJK/Kana/Hangul/Lao retain the stricter
    // one-glyph rule so an untranslated manga sentence cannot pass as a name.
    const boundedSourceAlphabetic =
      strictForeign === 0 && inventedCount === 0 && allPreservableRunsAttributed &&
      wanted >= 3 && hardForeign <= Math.max(8, Math.min(24, wanted));
    const boundedForeignFragment =
      boundedLaoConfusable || boundedSourceGlyph || boundedSourceAlphabetic;
    const foreignLeak =
      hardForeign > 0 &&
      !boundedForeignFragment &&
      (wanted === 0 || inventedCount > 0 || hardForeign >= 2);
    const singleHyphenProse =
      trimmed === sourceTrimmed && /^[A-Z]{3,}-\d+$/u.test(trimmed);
    const untranslatedLong =
      letters >= 8 && wanted === 0 && otherLetters / letters >= 0.75;
    const rejected = foreignLeak || singleHyphenProse || untranslatedLong;
    const inventedThirdScript = inventedCount > 0 && attributedRuns.some((run) => !run.inSource && !EAST_ASIAN_STRICT.has(run.script));
    const reason = foreignLeak
      ? inventedThirdScript ? "invented_third_script" : "foreign_script_leak"
      : unexpectedEmbeddedLatin && !rejected
        ? "unexpected_embedded_latin_word"
        : singleHyphenProse
          ? "untranslated_identifier_like_prose"
          : untranslatedLong
            ? "untranslated_long_prose"
            : boundedSourceAlphabetic
              ? "source_preserved_foreign_name"
              : boundedForeignFragment
                ? standaloneSourceGlyph
                  ? "proper_name_or_sfx_exemption"
                  : "small_foreign_fragment_exemption"
                : wanted > 0
                  ? "target_script_present"
                  : "insufficient_evidence";
    const detectedScripts = Object.fromEntries([
      [targetScript, wanted],
      ...Object.entries(hardCounts),
      ...(latinChars > 0 ? [["latin", latinChars]] : []),
    ]);
    diagnostics.push({
      id: String(item?.id || ""),
      targetScript,
      detectedScripts,
      targetChars: wanted,
      foreignChars: hardForeign + latinChars,
      decision: rejected ? "reject" : "accept",
      reason,
    });
  }
  return diagnostics.filter((row) => row.id);
}

export function dominantWrongTargetIds(
  translations,
  targetLang,
  sourceUnits = [],
) {
  return diagnoseTargetScripts(translations, targetLang, sourceUnits)
    .filter((row) => row.decision === "reject")
    .map((row) => row.id);
}

export function summarizeUnitScripts(items) {
  return (items || []).map((item) => {
    const counts = scriptSummary(item?.text);
    return {
      id: String(item?.id || ""),
      thai: counts.thai || 0,
      lao: counts.lao || 0,
      jp: counts.kana || 0,
      cjk: counts.han || 0,
      hangul: counts.hangul || 0,
      latin: counts.latin || 0,
      cyrillic: counts.cyrillic || 0,
      greek: counts.greek || 0,
      arabic: counts.arabic || 0,
      indic: (counts.devanagari || 0) + (counts.bengali || 0) +
        (counts.gurmukhi || 0) + (counts.gujarati || 0) +
        (counts.oriya || 0) + (counts.tamil || 0) +
        (counts.telugu || 0) + (counts.kannada || 0) +
        (counts.malayalam || 0) + (counts.sinhala || 0),
      other: Object.entries(counts).filter(([name]) =>
        !SUMMARY_PRIMARY_SCRIPTS.has(name)).reduce((sum, [, value]) => sum + value, 0),
    };
  });
}
