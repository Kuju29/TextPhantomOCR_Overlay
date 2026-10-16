/** Public UI templates; runtime values stay in protected DOM nodes. */
export const UI_TEMPLATES = new Set([
  'Admin offline for about {days} day',
  'Admin offline for about {days} days',
  'Admin offline for about {hours} hour',
  'Admin offline for about {hours} hours',
  'Admin offline for about {days} day {hours} hour',
  'Admin offline for about {days} day {hours} hours',
  'Admin offline for about {days} days {hours} hour',
  'Admin offline for about {days} days {hours} hours',
  'Admin offline for about {minutes} minute',
  'Admin offline for about {minutes} minutes',
  'Admin offline for about {days} day {minutes} minute',
  'Admin offline for about {days} day {minutes} minutes',
  'Admin offline for about {days} days {minutes} minute',
  'Admin offline for about {days} days {minutes} minutes',
  'Admin offline for about {hours} hour {minutes} minute',
  'Admin offline for about {hours} hour {minutes} minutes',
  'Admin offline for about {hours} hours {minutes} minute',
  'Admin offline for about {hours} hours {minutes} minutes',
  'Admin offline for about {days} day {hours} hour {minutes} minute',
  'Admin offline for about {days} day {hours} hour {minutes} minutes',
  'Admin offline for about {days} day {hours} hours {minutes} minute',
  'Admin offline for about {days} day {hours} hours {minutes} minutes',
  'Admin offline for about {days} days {hours} hour {minutes} minute',
  'Admin offline for about {days} days {hours} hour {minutes} minutes',
  'Admin offline for about {days} days {hours} hours {minutes} minute',
  'Admin offline for about {days} days {hours} hours {minutes} minutes',

  'Valid for {months} months after credits are issued.',
  'Request within {hours} hours of payment. Only unused purchased credits from that payment are refunded at the original price. Bonus and trial credits are excluded. If AI requests are pending, the final refund is calculated after their actual usage is settled.',
  'The unused credits are worth less than the {amount} refund minimum.',
  '{credits} TP added to your account.',
  '{credits} TP added.',
  'Processing: {credits} TP temporarily locked; unused credits return after this request.',
  'Reserved: {credits} TP',
  'Selected package · {package}',
  '{first}–{last} of {total}',
  'Translation models · {count}',
  'Default for {model}: {tokens} tokens (Control Center model ceiling).',
  'Default for {model}: {tokens} tokens (application default).',
  'Default for {model}: {tokens} tokens (context loaded in your Local app).',
  'Above the default of {tokens} tokens. If a reply no longer fits, translation can fail.',
  'Default for {model}: automatic size, about 3–5 images per request.',
  // 10496: inline warning while signed in to a website-tab Login (ChatGPT / Claude).
  'Keep the {site} tab open while translating; closing it stops the translation.',
  'Web chats publish no limit. Above {tokens} tokens a reply can be cut off and translation can fail.',
  'Credit lots · {count}',
  'Confirmed payments · {count}',
  'Expires {date}',
  'Support: {contact}',
  'Support code: {code}',
  'Support code: {code} · Reference: {reference}',
  '{credits} TP of unused reservations expired and were not returned to the available balance.',
  // Status copy with runtime values (model, count, folder, error).
  "No memory for this series yet ({series})",
  "✕ Not saved: {error}",
  "⚠ Could not verify the key with {provider}",
  "✓ {count} compatible model",
  "✓ {count} compatible models",
  "Request received; email delivery not confirmed. Support reference: {reference}",
  "Request received. Delivery is not confirmed yet. No code? Share this reference with support: {reference}",
  "Could not save {language}: {error}",
  "Saved model metadata for {model}, checked on {date}. Availability is rechecked when translation starts.",
  "Saved model metadata for {model}, checked on an earlier session. Availability is rechecked when translation starts.",
  "Saved model metadata from {date}. Refreshing installed models automatically…",
  "{model} was last listed on {date}; the runtime is checked again before translation.",
  "{model} was last listed on an earlier session; the runtime is checked again before translation.",
  "⚠ Could not refresh installed models. Keeping {model} selected but translation stays paused until availability is confirmed.",
  "Connected · {count} model(s) listed · Checking metadata…",
  "✓ {model} is loaded and its metadata was checked. You can start translation.",
  "✓ {model} is listed and its metadata was checked. You can start translation.",
  "✕ LM Studio has not confirmed the selected Thinking mode for {model}. Choose Lowest available or a verified mode.",
  "✓ {model} is downloaded; LM Studio will load it on the first real translation with a bounded context request.",
  "✓ Model selected · {model} · will load on first translation",
  "✓ Model selected · {model} · {count} model(s) listed",
  "⚠ Connected to {server}, but the selected model metadata is not ready",
  "Checking {model} metadata…",
  "⏳ Checking {model} with this Local AI runtime…",
  "✓ {model} is downloaded and will load on the first translation.",
  "✓ {model} is loaded and its metadata is verified.",
  "✕ {model} does not support the selected Thinking mode. Choose Lowest available or a verified mode.",
  "✕ {model} does not support the selected Thinking mode. Choose Lowest available.",
  "No images directly in that folder. {count} image(s) are in its subfolders, which this picker does not add.",
  "Nothing was added: none of the {count} selected file(s) are images.",
  "Opening {count} image(s)…",
  "Could not open the folder picker: {error}. In Brave, enable brave://flags/#file-system-access-api and relaunch the browser.",
  "No image files were found directly in “{folder}”. {count} subfolder(s) were not opened.",
  "No image files were found directly in “{folder}”.",
  "Opening {count} image(s) from “{folder}”…",
  "Resend in {seconds}s",
  "✕ {provider} is not implemented by this API build",
  "✓ Live {provider} model list loaded",
  "✕ {provider} rejected this API key",
  "✕ {provider} denied account/model access",
  "{count} character",
  "{count} characters",
  "{count} term",
  "{count} terms",
  "{count} excerpt",
  "{count} excerpts",
  "{count} image page",
  "{count} image pages",
  "✕ This is a {keyprovider} key but the provider is set to {provider} — paste a {expected} key, or switch the provider back.",
  "✕ {provider} does not use an sk- key — this looks like an OpenAI-style key.",
  "⚠ Language \"{language}\" is not in the supported list",
  "⚠ Source \"{source}\" is not in the list",
  "Version {version} is available. Please update TextPhantom.",
  "{model}: no verified rate; enter input and output for future requests.",
  "Individual requests ({count} records)",
  "Saved model metadata from an earlier session. Refreshing installed models automatically…",
  "That is not an image ({type}). This page takes image files only.",
  "That is not an image. This page takes image files only.",
  "Fetching {url}…",
  "That link needs a login (HTTP {status}). Save the image and drop it in instead.",
  "Could not fetch that link: HTTP {status}.",
  "That link is not an image ({type}); nothing was loaded.",
  "That link is not an image; nothing was loaded.",
  "That image is {size} MB — too large to translate here.",
  "Could not redraw the saved run ({error}). Press Re-translate to run it again.",
  "Translating with {mode} · {source} → {language}…",
  "Translating with {mode} → {language}…",
  "Shown from this page's saved runs — no new request · {count} paragraph(s).",
  "Shown from this page's saved runs — no new request.",
  "Finished with nothing to draw — {note}. The raw panel below shows what Lens returned.",
  "Finished with nothing to draw — {note}. Turn on raw data to see what Lens returned.",
  "Finished with nothing to draw. The raw panel below shows what Lens returned.",
  "Finished with nothing to draw. Turn on raw data to see what Lens returned.",
  "Translated · {count} paragraph(s). Click any line to select its whole bubble.",
  "Translated. Click any line to select its whole bubble.",
  "Not translated: the job ended without an overlay",
  "“{folder}” is a folder. This page translates one image at a time — open the Local viewer for a whole folder.",
]);
const tokens = (text) => [...text.matchAll(/\{([a-z]+)\}/g)].map((match) => match[1]);
export function validTemplateTranslation(source, translated) {
  const expected = tokens(source).sort();
  return (
    typeof translated === 'string' &&
    translated.trim() &&
    !/[{}]/.test(translated.replace(/\{[a-z]+\}/g, '')) &&
    JSON.stringify(tokens(translated).sort()) === JSON.stringify(expected)
  );
}
export function applyUiTemplate(node, translated) {
  const source = node.dataset.tpUiTemplate;
  if (!UI_TEMPLATES.has(source) || !validTemplateTranslation(source, translated))
    throw new Error('Invalid UI template');
  const values = new Map(
    [...node.querySelectorAll('[data-tp-ui-value]')].map((value) => [
      value.dataset.tpUiValue,
      value,
    ]),
  );
  const parts = translated.split(/(\{[a-z]+\})/g);
  if (tokens(source).some((key) => !values.has(key))) throw new Error('Missing UI value');
  const fragment = node.ownerDocument.createDocumentFragment();
  for (const part of parts) {
    if (/^\{[a-z]+\}$/.test(part)) fragment.append(values.get(part.slice(1, -1)));
    else fragment.append(node.ownerDocument.createTextNode(part));
  }
  node.replaceChildren(fragment);
  node.dataset.tpUiRendered = translated;
}
// English rendering of a registered template (non-DOM fallback, caches, tests).
export function fillUiTemplate(source, values = {}) {
  if (!UI_TEMPLATES.has(source)) throw new Error('Unknown UI template');
  return source.replace(/\{([a-z]+)\}/g, (_, key) => String(values[key] ?? '—'));
}
// Writes a registered template into an element. Runtime values stay in
// protected nodes; only the authored phrase is eligible for UI translation.
export function setUiTemplate(element, source, values = {}) {
  if (!element) return;
  if (typeof element.replaceChildren === 'function' && typeof document !== 'undefined' &&
      typeof element.ownerDocument?.createDocumentFragment === 'function') {
    element.replaceChildren(uiTemplate(source, values));
    return;
  }
  element.textContent = fillUiTemplate(source, values);
}
// Registered template that produced a finished English string, with its
// values. The most specific template (most literal text) wins, so a variant
// such as "… on an earlier session …" is preferred over "… on {date} …".
let templatePatterns = null;
export function matchUiTemplate(text) {
  templatePatterns ??= [...UI_TEMPLATES].filter((source) => /\{[a-z]+\}/.test(source)).map((source) => {
    const names = tokens(source);
    const pattern = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[a-z]+\\\}/g, '([\\s\\S]+?)');
    return { source, names: [...source.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]), regex: new RegExp('^' + pattern + '$'),
      weight: source.replace(/\{[a-z]+\}/g, '').length, count: names.length };
  // Short generic templates ("{count} term", "Expires {date}") are only used explicitly.
  }).filter((pattern) => pattern.weight >= 12).sort((a, b) => b.weight - a.weight || a.count - b.count);
  const value = String(text ?? '');
  for (const pattern of templatePatterns) {
    const match = pattern.regex.exec(value);
    if (match) return { template: pattern.source, values: Object.fromEntries(pattern.names.map((name, i) => [name, match[i + 1]])) };
  }
  return null;
}
// Writes status copy whose authored phrases are joined to runtime details
// (codes, trace ids, URLs, backend ids). A finished string that matches a
// registered template is rendered as that template; otherwise each " · " /
// " • " separated part is its own text node (or template) so the authored
// phrase can be translated while the details stay as written. The rendered
// text is identical to the input string.
const UI_TEXT_PARTS = / · | • |(?<=[.…]) (?=(?:API|Trace|Stage|Provider HTTP|Session HTTP): )/;
// parts: strings (each its own text node) or {template, values}.
export function setUiParts(element, ...parts) {
  if (!element) return;
  const doc = element.ownerDocument, values = parts.filter((part) => part && typeof part === 'object' || String(part ?? ''));
  const text = (part) => typeof part === 'object' ? fillUiTemplate(part.template, part.values) : String(part);
  if (values.length < 2 && typeof values[0] !== 'object' || typeof element.replaceChildren !== 'function' ||
      typeof doc?.createTextNode !== 'function' ||
      values.some((part) => typeof part === 'object') && (typeof document === 'undefined' || typeof doc.createDocumentFragment !== 'function')) {
    element.textContent = values.map(text).join('');
    return;
  }
  element.replaceChildren(...values.map((part) => typeof part === 'object' ? uiTemplate(part.template, part.values) : doc.createTextNode(part)));
}
export function setUiText(element, value) {
  const whole = String(value ?? '');
  const matched = matchUiTemplate(whole);
  if (matched) { setUiParts(element, matched); return; }
  const parts = [];
  let rest = whole, match;
  while ((match = UI_TEXT_PARTS.exec(rest))) {
    parts.push(rest.slice(0, match.index), match[0]);
    rest = rest.slice(match.index + match[0].length);
  }
  parts.push(rest);
  // A separated part may itself be a templated phrase (for example "✓ {count} compatible models").
  setUiParts(element, ...(parts.length > 1 ? parts.map((part) => matchUiTemplate(part) || part) : parts));
}
export function uiTemplate(source, values) {
  if (!UI_TEMPLATES.has(source)) throw new Error('Unknown UI template');
  const node = document.createElement('span');
  node.dataset.tpUiTemplate = source;
  for (const key of tokens(source)) {
    const value = document.createElement('span');
    value.dataset.tpUiValue = key;
    value.setAttribute('translate', 'no');
    value.textContent = String(values[key] ?? '—');
    node.append(value);
  }
  applyUiTemplate(node, source);
  return node;
}
