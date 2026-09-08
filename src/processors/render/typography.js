import {
  collapseThaiWordGaps,
  normalizeAiUnitText,
} from "../../shared/ai-markers.js";

export function targetTextDirection(language) {
  const primary = String(language || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .split("-", 1)[0];
  return primary === "ja" || primary === "zh" ? "v" : "h";
}

export function itemsReadVertically(items, verticalTiltDeg) {
  const textItems = (items || []).filter((item) =>
    String(item?.text || "").trim(),
  );
  if (!textItems.length) return false;
  return (
    textItems.filter(
      (item) => Math.abs(Number(item?.rotation) || 0) > verticalTiltDeg,
    ).length *
      2 >=
    textItems.length
  );
}

export function layoutTokens(text, language, vertical) {
  const value = collapseThaiWordGaps(normalizeAiUnitText(text));
  if (!value) return [];
  if (vertical) {
    return Array.from(value)
      .filter((ch) => !/\s/u.test(ch))
      .map((text) => ({ text, spaceBefore: false }));
  }
  try {
    const tokens = [];
    let pendingSpace = false;
    for (const part of new Intl.Segmenter(language || undefined, {
      granularity: "word",
    }).segment(value)) {
      const raw = String(part.segment || "");
      if (!raw) continue;
      if (/^\s+$/u.test(raw)) {
        pendingSpace = true;
        continue;
      }
      const piece = raw.trim();
      if (!piece) continue;
      if (!part.isWordLike && !pendingSpace && tokens.length)
        tokens[tokens.length - 1].text += piece;
      else tokens.push({ text: piece, spaceBefore: pendingSpace });
      pendingSpace = false;
    }
    if (tokens.length) return tokens;
  } catch {
    // Deterministic fallback for runtimes without Intl.Segmenter.
  }
  const tokens = [];
  let pendingSpace = false;
  for (const part of value.split(/(\s+)/u)) {
    if (!part) continue;
    if (/^\s+$/u.test(part)) {
      pendingSpace = true;
      continue;
    }
    for (const char of Array.from(part)) {
      tokens.push({ text: char, spaceBefore: pendingSpace });
      pendingSpace = false;
    }
  }
  return tokens;
}

export function distributeTokens(text, language, vertical, lineCount) {
  const tokens = layoutTokens(text, language, vertical);
  if (!tokens.length) return [];
  const count = Math.max(1, Math.min(Number(lineCount) || 1, tokens.length));
  const weights = tokens.map((token) =>
    Math.max(1, Array.from(token.text).length),
  );
  const lines = [];
  let cursor = 0;
  const remainingWeight = () =>
    weights.slice(cursor).reduce((sum, value) => sum + value, 0);
  for (let line = 0; line < count; line++) {
    const slotsLeft = count - line;
    const target = remainingWeight() / slotsLeft;
    const picked = [];
    let used = 0;
    while (cursor < tokens.length) {
      const tokensAfter = tokens.length - (cursor + 1);
      const mustLeave = slotsLeft - 1;
      if (picked.length && used >= target && tokensAfter >= mustLeave) break;
      picked.push(tokens[cursor]);
      used += weights[cursor];
      cursor += 1;
      if (tokens.length - cursor === mustLeave) break;
    }
    lines.push(
      picked
        .map(
          (token, index) =>
            `${index > 0 && token.spaceBefore ? " " : ""}${token.text}`,
        )
        .join(""),
    );
  }
  if (cursor < tokens.length) {
    const tail = tokens
      .slice(cursor)
      .map(
        (token, index) =>
          `${(index > 0 || lines[lines.length - 1]) && token.spaceBefore ? " " : ""}${token.text}`,
      )
      .join("");
    lines[lines.length - 1] += tail;
  }
  return lines.filter(Boolean);
}
