import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.location = { href: 'https://example.test/chapter/1' };
globalThis.chrome = { storage: { local: { get(_keys, cb){ cb({}); } } }, runtime: { lastError: null } };
const log = { debug(){}, info(){}, warn(){}, error(){} };
window.__TP = {
  bail: false, log,
  normUrl: value => String(value || ''),
  getBestImgUrl: img => img.currentSrc || img.src || '',
  isInlineableImageUrl: () => false,
  buildPositionFromElement: () => ({}),
  generationFor: () => null,
  buildPipelineEvent: stage => ({ stage }),
  truncate: value => String(value || ''),
};
await import('../src/content/dom-utils.js?scan-filter-test');
await import('../src/content/payload.js?scan-filter-test=44');
const { imageSkipReason } = window.__TP;
assert.equal(typeof imageSkipReason, 'function');
function img({ cssW, cssH, natW, natH, src='https://cdn.test/page.jpg', cls='' }) {
  return {
    isConnected: true, currentSrc: src, src, id: '', className: cls, complete: true,
    width: cssW, height: cssH, clientWidth: cssW, clientHeight: cssH,
    naturalWidth: natW, naturalHeight: natH,
    getBoundingClientRect(){ return { width: cssW, height: cssH }; },
    dataset: {}, style: {},
    getAttribute(name){ return name === 'class' ? this.className : null; },
    matches(selector){return selector.split(',').some(part => this.className.split(/\s+/).includes(part.trim().slice(1)));},
    closest(selector){return this.matches(selector) ? this : this.parentElement?.closest?.(selector) || null;},
  };
}
// Regression from the live .43 trace: the chapter cover had a 267x400 source
// but was rendered as a tiny card. Natural pixels must not promote it.
assert.equal(imageSkipReason(img({cssW:88, cssH:132, natW:267, natH:400}), 'lens_text'), 'too_small');
// A full manga page remains eligible when rendered large.
assert.equal(imageSkipReason(img({cssW:629, cssH:900, natW:629, natH:900}), 'lens_text'), '');
// If rendered geometry is genuinely unavailable, a loaded large natural image
// can still be scanned (lazy/offscreen fallback).
assert.equal(imageSkipReason(img({cssW:0, cssH:0, natW:1129, natH:1618}), 'lens_text'), '');
// Class/URL UI filters remain stronger than dimensions.
assert.equal(imageSkipReason(img({cssW:400, cssH:400, natW:400, natH:400, cls:'thumbnail'}), 'lens_text'), 'ui_asset');

// Build the actual extension clean-image layer, then scan the resulting DOM
// twice as happens when the user changes Provider/Model and translates again.
const original = img({cssW:629, cssH:900, natW:629, natH:900});
original.dataset.tpOriginal = original.src;
globalThis.document = {
  images: [original],
  createElement(tag) {
    assert.equal(tag, 'img');
    const node = img({cssW:629, cssH:900, natW:629, natH:900, src:''});
    this.images.push(node); return node;
  },
};
const first = await window.__TP.collectImagesForScan('lens_text', 'th', 'page_scan');
assert.equal(first.items.length, 1);
await import('../src/content/overlay/background.js?scan-filter-test');
const host = {isConnected:true, firstChild:null,
  closest: selector => selector.includes('.tp-ol-root') ? host : null,
  insertBefore(node) {node.parentElement = this; this.firstChild = node;},
};
const record = {host};
const clean = window.__TP.overlayBackground.layer(record);
window.__TP.overlayBackground.update(record, original, 'blob:https://example.test/erased-result');
assert.equal(clean.className, 'tp-ol-clean-img');
assert.equal(clean.src, 'blob:https://example.test/erased-result');
const second = await window.__TP.collectImagesForScan('lens_text', 'th', 'page_scan');
assert.equal(second.items.length, 1, 'generated backgrounds must not become extra image jobs');
assert.equal(second.items[0].src, first.items[0].src);
assert.equal(imageSkipReason(clean, 'lens_text'), 'translation_output');
const child = img({cssW:629, cssH:900, natW:629, natH:900});
child.parentElement = host;
assert.equal(imageSkipReason(child, 'lens_text'), 'translation_output');
assert.equal(imageSkipReason(img({cssW:629, cssH:900, natW:629, natH:900, cls:'tp-md-image-overlay'}), 'lens_text'), 'translation_output');
for (const src of ['blob:https://example.test/publisher-page', 'data:image/png;base64,cHVibGlzaGVy']) {
  const publisher = img({cssW:629, cssH:900, natW:629, natH:900, src});
  assert.equal(imageSkipReason(publisher, 'lens_text'), '', 'publisher inline sources remain eligible');
}
assert.equal(imageSkipReason(original, 'lens_text'), '', 'remembered original remains eligible');
console.log('Image scan regressions passed: second scan excludes real generated background, preserves original and publisher inline images');
