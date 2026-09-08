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
await import('../src/content/payload.js?scan-filter-test=44');
const { imageSkipReason } = window.__TP;
assert.equal(typeof imageSkipReason, 'function');
function img({ cssW, cssH, natW, natH, src='https://cdn.test/page.jpg', cls='' }) {
  return {
    isConnected: true, currentSrc: src, src, id: '', className: cls, complete: true,
    width: cssW, height: cssH, clientWidth: cssW, clientHeight: cssH,
    naturalWidth: natW, naturalHeight: natH,
    getBoundingClientRect(){ return { width: cssW, height: cssH }; },
    getAttribute(name){ return name === 'class' ? cls : null; },
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
console.log('4 image-scan filter regressions passed');
