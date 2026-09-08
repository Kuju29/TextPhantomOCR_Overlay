// Pure, source-aware diagnostics used by the bounded repair planner.
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
  const sourceById = new Map(
    (sourceUnits || []).map((item) => [
      String(item?.id || ""),
      String(item?.text || ""),
    ]),
  );
  const count = (text, regex) => (String(text || "").match(regex) || []).length;
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
        targetScript: target === "th" ? "thai" : "hangul",
        detectedScripts: {},
        targetChars: 0,
        foreignChars: 0,
        decision: "accept",
        reason: "preserved_identifier",
      });
      continue;
    }
    const wanted =
      target === "th"
        ? count(text, /\p{Script=Thai}/gu)
        : count(text, /\p{Script=Hangul}/gu);
    const foreignScripts =
      target === "th"
        ? [
            ["han", /\p{Script=Han}/gu],
            ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
            ["hangul", /\p{Script=Hangul}/gu],
            ["lao", /\p{Script=Lao}/gu],
          ]
        : [
            ["han", /\p{Script=Han}/gu],
            ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
            ["thai", /\p{Script=Thai}/gu],
            ["lao", /\p{Script=Lao}/gu],
          ];
    const scriptCounts = foreignScripts.map(([name, regex]) => ({
      name,
      output: count(text, regex),
      source: count(source, regex),
    }));
    const hardForeign = scriptCounts.reduce(
      (sum, script) => sum + script.output,
      0,
    );
    const letters = count(text, /\p{L}/gu);
    const otherLetters = Math.max(0, letters - wanted);
    const latinChars = count(text, /\p{Script=Latin}/gu);
    // A short English word can otherwise hide inside an apparently Thai
    // sentence (for example "ถifฉัน..."). This is only a privacy-safe warning:
    // geometry and script shape cannot prove whether a lowercase run is an
    // error or a proper name, so it must never remove or rewrite a translation.
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
        if (
          protectedLatinSpans.some(
            ([left, right]) => start >= left && end <= right,
          )
        )
          return false;
        if (run !== run.toLocaleLowerCase("en-US")) return false;
        return /\p{Script=Thai}/u.test(trimmed.slice(0, start).at(-1) || "") &&
          /\p{Script=Thai}/u.test(trimmed[end] || "");
      });
    const inventedCount = scriptCounts
      .filter((script) => script.source === 0)
      .reduce((sum, script) => sum + script.output, 0);
    const laoCount =
      scriptCounts.find((script) => script.name === "lao")?.output || 0;
    const boundedLaoConfusable =
      laoCount === hardForeign && laoCount <= 2 && wanted >= 3;
    const standaloneSourceGlyph =
      [...trimmed].length === 1 && source.includes(trimmed);
    const boundedSourceGlyph =
      hardForeign === 1 &&
      inventedCount === 0 &&
      (wanted >= 3 || standaloneSourceGlyph);
    const boundedForeignFragment = boundedLaoConfusable || boundedSourceGlyph;
    const foreignLeak =
      hardForeign > 0 &&
      !boundedForeignFragment &&
      (wanted === 0 || inventedCount > 0 || hardForeign >= 2);
    const singleHyphenProse =
      trimmed === sourceTrimmed && /^[A-Z]{3,}-\d+$/u.test(trimmed);
    const untranslatedLong =
      letters >= 8 && wanted === 0 && otherLetters / letters >= 0.75;
    const rejected = foreignLeak || singleHyphenProse || untranslatedLong;
    const reason = foreignLeak
      ? "foreign_script_leak"
      : unexpectedEmbeddedLatin && !rejected
        ? "unexpected_embedded_latin_word"
        : singleHyphenProse
          ? "untranslated_identifier_like_prose"
          : untranslatedLong
            ? "untranslated_long_prose"
            : boundedForeignFragment
              ? standaloneSourceGlyph
                ? "proper_name_or_sfx_exemption"
                : "small_foreign_fragment_exemption"
              : wanted > 0
                ? "target_script_present"
                : "insufficient_evidence";
    const detectedScripts = Object.fromEntries([
      [target === "th" ? "thai" : "hangul", wanted],
      ...scriptCounts
        .filter((script) => script.output > 0)
        .map((script) => [script.name, script.output]),
      ...(latinChars > 0 ? [["latin", latinChars]] : []),
      ...(otherLetters > hardForeign + latinChars
        ? [["otherLetters", otherLetters - hardForeign - latinChars]]
        : []),
    ]);
    diagnostics.push({
      id: String(item?.id || ""),
      targetScript: target === "th" ? "thai" : "hangul",
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
    const counts = { thai: 0, lao: 0, jp: 0, cjk: 0, hangul: 0, latin: 0 };
    for (const ch of String(item?.text || "")) {
      if (/\p{Script=Thai}/u.test(ch)) counts.thai++;
      else if (/\p{Script=Lao}/u.test(ch)) counts.lao++;
      else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch))
        counts.jp++;
      else if (/\p{Script=Han}/u.test(ch)) counts.cjk++;
      else if (/\p{Script=Hangul}/u.test(ch)) counts.hangul++;
      else if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
    }
    return { id: String(item?.id || ""), ...counts };
  });
}
