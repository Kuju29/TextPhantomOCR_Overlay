/** .83 owner request: type to search inside the Translation model picker. Offline DOM facade. */
import assert from 'node:assert/strict';
import {createPaidModelPricing, paidModelMatches} from '../src/popup/controllers/paid-model-pricing.js';

class El {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.dataset = {}; this.attrs = {};
    this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = ''; this.focused = false; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = [...n]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
  dispatchEvent(e) { e.target ||= this; for (const f of this.handlers[e.type] || []) f(e); return true; }
  click() { this.dispatchEvent({type: 'click', preventDefault() {}}); }
  focus() { El.focused = this; }
  select() {}
  querySelector(s) { return s === 'summary' ? this.summary : null; }
}
globalThis.document = {createElement: tag => new El(tag), createTextNode: t => ({textContent: String(t)})};
globalThis.Event = class { constructor(type) { this.type = type; } };

const picker = new El('details'); picker.summary = new El('summary');
const els = {aiPaidModelPicker: picker, aiPaidModel: new El('select'), aiPaidModelName: new El('span'), aiPaidModelOptions: new El(),
  aiPaidModelSearch: new El('input'), aiPaidModelEmpty: new El('p'), aiPaidModelInput: new El(), aiPaidModelOutput: new El(),
  aiPaidModelPriceStatus: new El()};
const pricing = (i, o) => ({status: 'estimated', unit: 'TP_PER_1000_TOKENS', input_tp: String(i), output_tp: String(o)});
const models = [
  {id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', pricing: pricing(46, 92)},
  {id: 'qwen/qwen3.7-flash', name: 'Qwen: Qwen3.7 Flash', pricing: pricing(25, 108)},
  {id: 'aion-labs/aion-3.5', name: 'AionLabs: Aion 3.5', pricing: pricing(2521, 5042)},
  {id: 'openai/gpt-6-luna', name: 'OpenAI: GPT-6 Luna', pricing: pricing(80, 320)},
];
const view = createPaidModelPricing(els);
view.render(models, models[0].id, true);
const shown = () => els.aiPaidModelOptions.children.filter(b => !b.hidden).map(b => b.dataset.modelId);
const checks = [];

assert.equal(paidModelMatches(models[1], 'QWEN flash'), true);
assert.equal(paidModelMatches(models[1], 'qwen luna'), false);
assert.equal(paidModelMatches(models[3], 'gpt-6'), true);
checks.push('every typed word must appear in the model name or id, any case');

els.aiPaidModelSearch.value = 'flash';
els.aiPaidModelSearch.dispatchEvent({type: 'input'});
assert.deepEqual(shown(), ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3.7-flash']);
assert.equal(els.aiPaidModelEmpty.hidden, true);
checks.push('typing filters the list');

els.aiPaidModelSearch.value = 'nothing-like-this';
els.aiPaidModelSearch.dispatchEvent({type: 'input'});
assert.deepEqual(shown(), []); assert.equal(els.aiPaidModelEmpty.hidden, false);
checks.push('no match shows a message instead of an empty box');

let changed = 0; els.aiPaidModel.addEventListener('change', () => changed++);
picker.open = false;
els.aiPaidModelSearch.value = '';
picker.summary.dispatchEvent({type: 'keydown', key: 'q', preventDefault() {}});
assert.equal(picker.open, true); assert.equal(els.aiPaidModelSearch.value, 'q'); assert.equal(El.focused, els.aiPaidModelSearch);
assert.deepEqual(shown(), ['qwen/qwen3.7-flash']);
els.aiPaidModelSearch.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault() {}});
assert.equal(els.aiPaidModel.value, 'qwen/qwen3.7-flash'); assert.equal(changed, 1); assert.equal(picker.open, false);
checks.push('typing on the closed picker opens it and searches; Enter picks the first match');

els.aiPaidModelSearch.value = 'aion';
els.aiPaidModelSearch.dispatchEvent({type: 'input'});
view.render(models.map(m => ({...m})), 'qwen/qwen3.7-flash', true);  // a refreshed account list
assert.deepEqual(shown(), ['aion-labs/aion-3.5'], 'a refreshed list keeps the typed words');
checks.push('a refreshed model list keeps the current search');
console.log(JSON.stringify({passed: checks.length, checks}));
