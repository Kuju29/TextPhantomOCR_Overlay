import { UI_TEMPLATES, validTemplateTranslation } from './ui-template.js';
export const UI_CACHE_KEY = 'uiTranslationCacheV2';
export const UI_CACHE_VERSION = 2;
// One terminology policy for every target language; no translated dictionaries.
export const UI_KEEP_TERMS = Object.freeze([
  'TextPhantom', 'Google Lens', 'Lens', 'Google Gemini', 'Stripe', 'Resend', 'OpenAI', 'OpenRouter', 'Anthropic',
  'Groq', 'DeepSeek', 'Together', 'HuggingFace', 'Hugging Face', 'Featherless',
  'Ollama', 'LM Studio', 'Jan', 'KoboldCpp', 'Prompt Studio', 'Local Viewer',
  'Conversation', 'Independent', 'Manual', 'Paid', 'Local', 'Cloud', 'Trial',
  'API', 'AI', 'OCR', 'CPU', 'GPU', 'RAM', 'QR', 'TP', 'USD', 'THB', 'LIVE', 'TEST',
]);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termPattern = new RegExp('\\b(?:' + [...UI_KEEP_TERMS].sort((a, b) => b.length - a.length).map(escape).join('|') + ')\\b', 'g');
const valuePattern = new RegExp(termPattern.source + '|\\{[a-z]+\\}|\\d+(?:[.,:/-]\\d+)*(?:%)?', 'g');
const values = (text) => [...text.matchAll(valuePattern)].map((match) => match[0]).sort();
export function validUiTranslation(source, translated) {
  return typeof translated === 'string' && translated.trim().length > 0 &&
    translated.length <= 16000 && !/ZXQ[A-Z]+QXZ/.test(translated) &&
    JSON.stringify(values(source)) === JSON.stringify(values(translated)) &&
    (!UI_TEMPLATES.has(source) || validTemplateTranslation(source, translated));
}
export function protectUiText(text) {
  const replacements = [];
  const source = text.replace(valuePattern, (value) => {
    // Letters only, so numeric markers cannot themselves be translated as amounts.
    const index = replacements.length;
    let n = index, letters = '';
    do { letters = String.fromCharCode(65 + n % 26) + letters; n = Math.floor(n / 26) - 1; } while (n >= 0);
    const marker = 'ZXQ' + letters + 'QXZ';
    replacements.push([marker, value]);
    return marker;
  });
  return { source, restore(translated) {
    let result = translated;
    for (const [marker, value] of replacements) {
      if (result.split(marker).length !== 2) throw new Error('UI translation unavailable');
      result = result.replace(marker, value);
    }
    if (!validUiTranslation(text, result)) throw new Error('UI translation unavailable');
    return result;
  } };
}
export function boundedUiCache(entries) {
  // Languages retain their own authored-copy cache. Visiting another page or
  // language must not evict unchanged labels in the selected language.
  const result = [], languages = new Map(), encoder = new TextEncoder();
  for (const [key, value] of [...entries].reverse()) {
    const selected=key.split('\0')[0], size=encoder.encode(key).length+encoder.encode(value).length;
    if(!languages.has(selected)&&languages.size>=20)continue;
    const partition=languages.get(selected)||{count:0,size:0};
    if(partition.count>=1500||partition.size+size>200000)continue;
    result.push([key,value]);languages.set(selected,{count:partition.count+1,size:partition.size+size});
  }
  return result.reverse();
}
