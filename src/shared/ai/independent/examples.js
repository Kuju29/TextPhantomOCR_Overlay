// Independent-only prompt evidence. Conversation owns a separate, immutable
// first-turn anchor and must never read this policy or its history.
import {STYLE_EXAMPLES} from '../../../generated/localization-content.js';
import {normalizeLanguageCode} from '../../../generated/language-code-aliases.js';
export const INDEPENDENT_EXAMPLE_LIMIT = 20;
export const INDEPENDENT_REQUEST_EXAMPLE_LIMIT = 4;
export const INDEPENDENT_REQUEST_EXAMPLE_CHARS = 600;

export function humanExampleCount(selection) {
  const count = selection?.humanExampleCount;
  return Number.isSafeInteger(count) && count >= 1
    ? Math.min(count,INDEPENDENT_EXAMPLE_LIMIT,STYLE_EXAMPLES.length)
    : Math.min(INDEPENDENT_REQUEST_EXAMPLE_LIMIT,STYLE_EXAMPLES.length);
}

// Display acceptance and teaching eligibility are different. A mostly-Thai
// line with an English title may remain readable, but must not teach the next
// request to keep source-language prose. This is deliberately conservative and
// only filters examples; it never changes or rejects the displayed translation.
export function suitableIndependentExample(text, targetLang = "") {
  const letters = Array.from(String(text || "")).filter(char => /\p{L}/u.test(char));
  const code = normalizeLanguageCode(targetLang).split('-')[0];
  const script = {th:/\p{Script=Thai}/u,ja:/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u,
    ko:/[\p{Script=Hangul}\p{Script=Han}]/u,zh:/\p{Script=Han}/u}[code];
  return !script || (letters.length > 0 && letters.every(char => script.test(char)));
}

export function boundedIndependentPairs(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set(), selected = [];
  let chars = 0;
  for (const row of rows.slice().reverse()) {
    const src = String(row?.src || '').trim(), tgt = String(row?.tgt || '').trim();
    if (!src || !tgt || src === tgt || src.length > 160 || tgt.length > 240 ||
        /[\r\n\u2028\u2029]/u.test(src + tgt) || seen.has(src)) continue;
    if (chars + src.length + tgt.length > 3000) continue;
    seen.add(src);
    selected.push({src,tgt});
    chars += src.length + tgt.length;
    if (selected.length >= INDEPENDENT_EXAMPLE_LIMIT) break;
  }
  return selected.reverse();
}

function sourceFeatures(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const letters = Array.from(words.join(''));
  const features = new Set(words.filter(word => Array.from(word).length >= 2));
  for (let index = 0; index + 1 < letters.length; index++)
    features.add(letters[index] + letters[index + 1]);
  return features;
}

/** A bounded, deterministic local retrieval; no model call or history replay. */
export function selectIndependentStoryExamples(selection, currentSource, limit = INDEPENDENT_REQUEST_EXAMPLE_LIMIT) {
  if (selection?.source !== 'story') return selection;
  const pool = boundedIndependentPairs(selection.pairs);
  if (!pool.length) throw new Error('independent_story_examples_empty');
  const target = sourceFeatures(currentSource);
  const ranked = pool.map((pair,index) => {
    const features = sourceFeatures(pair.src);
    let overlap = 0;
    for (const feature of features) if (target.has(feature)) overlap++;
    return {pair,index,overlap};
  }).sort((a,b) => b.overlap - a.overlap || b.index - a.index);
  const chosen = [];
  const targetLang = String(selection.targetLang || 'en');
  const count = Number.isSafeInteger(limit) && limit >= 1
    ? Math.min(limit,INDEPENDENT_REQUEST_EXAMPLE_LIMIT) : INDEPENDENT_REQUEST_EXAMPLE_LIMIT;
  for (const candidate of ranked) {
    if (chosen.length >= count) break;
    const proposed = [...chosen,candidate].sort((a,b) => a.index - b.index);
    const formatted = formatIndependentStoryExamples({source:'story',pairs:proposed.map(row=>row.pair)},targetLang);
    if (Array.from(formatted).length <= INDEPENDENT_REQUEST_EXAMPLE_CHARS)
      chosen.splice(0,chosen.length,...proposed);
  }
  if (!chosen.length) throw new Error('independent_story_examples_budget_insufficient');
  return {...selection,pairs:chosen.map(row=>row.pair)};
}

export function formatIndependentStoryExamples(selection, targetLang = '') {
  if (selection?.source !== 'story') return '';
  const pairs = boundedIndependentPairs(selection.pairs);
  if (!pairs.length) throw new Error('independent_story_examples_empty');
  const locale = normalizeLanguageCode(targetLang).split('-')[0];
  const labels = locale === 'th' ? {
    heading:'ตัวอย่างคำแปลที่ตรวจผ่านแล้วจากเรื่องนี้ (ใช้ดูสไตล์เท่านั้น ให้แปล ID ของข้อความต้นฉบับในคำขอนี้):',
    source:'ต้นฉบับ',translation:'คำแปล',
  } : locale === 'ja' ? {
    heading:'この作品で検証済みの訳例（文体の参考のみ。今回の原文IDを翻訳すること）：',
    source:'原文',translation:'訳文',
  } : {heading:'PREVIOUSLY ACCEPTED TRANSLATIONS FROM THIS STORY (style reference only; translate the current SOURCE IDs):',
    source:'SOURCE',translation:'TRANSLATION'};
  return [labels.heading,...pairs.map((pair,index) =>
    `${index + 1}. ${labels.source}: ${pair.src}\n   ${labels.translation}: ${pair.tgt}`)].join('\n');
}

export function independentExampleEvidence(selection, includedText = '') {
  if (!selection) return null;
  const source = selection.source === 'story' ? 'story'
    : selection.source === 'human' ? 'human' : 'none';
  return {mode:'independent',source,availableStoryPairs:Number(selection.acceptedPairs || 0),
    includedPairs:source === 'story' ? boundedIndependentPairs(selection.pairs).length
      : source === 'human' && includedText ? humanExampleCount(selection) : 0,
    exampleChars:Array.from(String(includedText || '')).length,
    scopeStatus:String(selection.scopeStatus || 'unscoped'),
    storageStatus:String(selection.storageStatus || 'unscoped'),
    evidenceStage:'prompt_composed_before_dispatch'};
}
