/**
 * 10496: option explanations that appear when the user hovers an option's
 * NAME (or focuses it with the keyboard, or taps it on a touch screen),
 * instead of hint lines under every option.
 *
 * Markup (static explanation):
 *
 *   <label class="label-row"><span class="tp-tip" data-tip-src="x-tip">Name</span><input …></label>
 *   <span id="x-tip" class="tp-tip-src" hidden>Explanation.</span>
 *
 *   An optional `<span class="tp-tip-reason">…</span>` inside the source is
 *   shown as a highlighted second line (why the option is unavailable).
 *   `data-tip-control="id"` names the control when it is not inside the same
 *   <label> (or the label's `for`).
 *
 * The explanation is real DOM text in a hidden element: shared/ui-language.js
 * translates it like any other popup copy (its scan includes hidden nodes),
 * and both the name and its control point at it with aria-describedby.
 * The single floating #tp-tip element only shows a copy of the (translated)
 * source and is excluded from translation (translate="no").
 *
 * Dynamic explanations: setTip(nameOrSource, text | [text…], {reason, unavailable})
 * writes each part with setUiText (the same path as other controller copy, so
 * it is translated too) and dims the option row while it is unavailable.
 */
import { setUiText } from './ui-template.js';

export const TIP_ID = 'tp-tip';
export const TIP_DELAY_MS = 250;
const NAME = '[data-tip-src]';
const MARGIN = 6;
const MAX_WIDTH = 280;
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const hasDom = (node) => typeof node?.replaceChildren === 'function' && typeof node?.ownerDocument?.createElement === 'function';

function sourceOf(target, doc = target?.ownerDocument) {
  if (!target) return null;
  if (target.classList?.contains?.('tp-tip-src')) return target;
  const id = target.dataset?.tipSrc;
  if (id) return doc?.getElementById?.(id) || null;
  return target; // a plain element used as the source (tests, non-DOM callers)
}

function nameFor(source, doc = source?.ownerDocument) {
  if (!source?.id || typeof doc?.querySelector !== 'function') return null;
  try { return doc.querySelector(`[data-tip-src="${source.id}"]`); } catch { return null; }
}

/** The row an unavailable option dims (the label row, or the whole field). */
function rowFor(name) {
  return name?.closest?.('[data-tip-row]') || name?.closest?.('.label-row') || name?.closest?.('.field') || null;
}

/**
 * Sets the explanation of an option. `target` is the name element
 * (`[data-tip-src]`) or its hidden source element. `text` is one string or a
 * list of strings (each shown on its own line); `reason` is the highlighted
 * line for an unavailable option. Unchanged calls do not touch the DOM, so a
 * translated explanation is not reset by a controller re-render.
 */
export function setTip(target, text, { reason = '', unavailable } = {}) {
  const source = sourceOf(target);
  if (!source) return;
  const parts = (Array.isArray(text) ? text : [text]).map((part) => String(part ?? '')).filter((part) => normalize(part));
  const why = String(reason ?? '');
  const dim = unavailable ?? Boolean(normalize(why));
  const name = target !== source && target?.dataset?.tipSrc ? target : nameFor(source);
  rowFor(name)?.classList?.toggle?.('is-unavailable', dim);
  if (!hasDom(source)) {
    source.textContent = [...parts, why].filter((part) => normalize(part)).join(' ');
    source.tipReason = why;
    return;
  }
  const signature = JSON.stringify([parts, why]);
  if (source.dataset && source.dataset.tipSignature === signature) return;
  const doc = source.ownerDocument, nodes = [];
  for (const part of parts) {
    if (nodes.length) nodes.push(doc.createTextNode(' '));
    const node = doc.createElement('span');
    node.className = 'tp-tip-part';
    setUiText(node, part);
    nodes.push(node);
  }
  if (normalize(why)) {
    if (nodes.length) nodes.push(doc.createTextNode(' '));
    const node = doc.createElement('span');
    node.className = 'tp-tip-reason';
    setUiText(node, why);
    nodes.push(node);
  }
  source.replaceChildren(...nodes);
  if (source.dataset) source.dataset.tipSignature = signature;
}

/** Adds one id to a space-separated ARIA reference attribute. */
function addReference(element, attribute, id) {
  if (!element?.setAttribute || !id) return;
  const ids = String(element.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) element.setAttribute(attribute, [...ids, id].join(' '));
}

const nativeFocusable = (el) => /^(?:BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el?.tagName || '');

function controlFor(name, doc) {
  const explicit = name.dataset?.tipControl;
  if (explicit) return doc.getElementById(explicit);
  if (nativeFocusable(name)) return name;
  const label = name.closest?.('label');
  if (!label) return null;
  if (label.control) return label.control;
  const forId = label.getAttribute?.('for');
  if (forId) return doc.getElementById(forId);
  return label.querySelector?.('input,select,textarea') || null;
}

const state = new WeakMap();

/** Installs the hover/focus/tap behaviour once per document and wires every name. */
export function initHoverTips({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  if (!doc || typeof doc.addEventListener !== 'function') return null;
  if (state.has(doc)) { state.get(doc).wire(); return state.get(doc); }
  let tip = doc.getElementById?.(TIP_ID);
  if (!tip && typeof doc.createElement === 'function' && doc.body?.append) {
    tip = doc.createElement('div');
    tip.id = TIP_ID;
    doc.body.append(tip);
  }
  if (!tip) return null;
  tip.setAttribute?.('role', 'tooltip');
  // A copy of already-translated copy: the interface translator skips it.
  tip.setAttribute?.('translate', 'no');
  tip.hidden = true;
  const controls = new Map();
  let current = null, shownBy = '', anchorEl = null, timer = 0, keyboard = false;
  const later = win?.setTimeout?.bind(win) || globalThis.setTimeout, cancel = win?.clearTimeout?.bind(win) || globalThis.clearTimeout;

  function wire(root = doc) {
    const names = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll(NAME)] : [];
    for (const name of names) {
      if (name.dataset.tipWired === '1') continue;
      name.dataset.tipWired = '1';
      name.classList?.add?.('tp-tip');
      if (!nativeFocusable(name) && !name.hasAttribute?.('tabindex')) name.tabIndex = 0;
      const id = name.dataset.tipSrc;
      addReference(name, 'aria-describedby', id);
      const control = controlFor(name, doc);
      if (control && control !== name) { addReference(control, 'aria-describedby', id); controls.set(control, name); }
    }
  }
  const nameFrom = (node) => {
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const name = el?.closest?.(NAME) || null;
    if (name && name.dataset.tipWired !== '1') wire(name.parentElement || doc);
    return name;
  };
  const visibleText = (name) => normalize(sourceOf(name, doc)?.textContent);

  function place(anchor) {
    const view = doc.documentElement;
    const width = Math.min(view?.clientWidth || win?.innerWidth || 0, win?.innerWidth || Infinity);
    const height = win?.innerHeight || view?.clientHeight || 0;
    const box = (anchor.closest?.('.app') || doc.body).getBoundingClientRect();
    const minLeft = Math.max(MARGIN, box.left + MARGIN);
    const maxRight = Math.min(width - MARGIN, box.right - MARGIN);
    tip.style.maxWidth = Math.max(120, Math.min(MAX_WIDTH, maxRight - minLeft)) + 'px';
    tip.style.left = '0px'; tip.style.top = '0px';
    // Under the name; when a control was focused, under the row of both.
    const n = (current || anchor).getBoundingClientRect(), c = anchor.getBoundingClientRect();
    const r = { left: n.left, top: Math.min(n.top, c.top), bottom: Math.max(n.bottom, c.bottom) };
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(minLeft, Math.min(r.left, maxRight - w));
    let top = r.bottom + MARGIN;
    if (top + h > height - MARGIN && r.top - h - MARGIN >= MARGIN) top = r.top - h - MARGIN;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(Math.max(MARGIN, top)) + 'px';
  }
  function render() {
    const source = sourceOf(current, doc);
    const copy = [...(source?.childNodes || [])].map((node) => node.cloneNode(true));
    for (const node of copy) {
      if (node.nodeType !== 1) continue;
      node.removeAttribute('id');
      for (const inner of node.querySelectorAll('[id]')) inner.removeAttribute('id');
    }
    tip.replaceChildren(...copy);
    tip.hidden = false;
    place(anchorEl || current);
  }
  function show(name, by, anchor = name) {
    cancel(timer);
    if (!name || !visibleText(name)) { hide(); return; }
    if (current && current !== name) current.removeAttribute?.('data-tip-open');
    current = name; shownBy = by; anchorEl = anchor;
    name.setAttribute?.('data-tip-open', '');
    render();
    tip.classList.remove('show');
    void tip.offsetWidth;
    tip.classList.add('show');
  }
  function hide() {
    cancel(timer);
    current?.removeAttribute?.('data-tip-open');
    current = null; shownBy = ''; anchorEl = null;
    tip.classList.remove('show');
    tip.hidden = true;
  }
  const onPointerDown = (event) => { keyboard = false; if (!nameFrom(event.target) && event.target !== tip) hide(); };
  const onKeyDown = (event) => {
    const key = String(event.key || '');
    if (key === 'Escape') { if (current) hide(); return; }
    if (key === 'Tab') keyboard = true;
    // Typing into a field closes an explanation that would cover it.
    else if (current && shownBy === 'focus' && anchorEl !== current && key.length === 1) hide();
  };
  const onOver = (event) => {
    const name = nameFrom(event.target);
    if (!name || name === current) return;
    cancel(timer);
    timer = later(() => show(name, 'hover'), TIP_DELAY_MS);
  };
  const onOut = (event) => {
    const name = nameFrom(event.target);
    if (!name || name.contains(event.relatedTarget)) return;
    cancel(timer);
    if (name === current && shownBy !== 'focus') hide();
  };
  const onFocusIn = (event) => {
    const target = event.target;
    const name = target?.matches?.(NAME) ? target : controls.get(target);
    if (!name) { if (current) hide(); return; }
    // Only keyboard focus opens it; a mouse/touch press is handled by
    // hover and click, and a controller moving focus shows nothing.
    if (!keyboard) return;
    show(name, 'focus', target === name ? name : target);
  };
  const onFocusOut = (event) => {
    if (current && shownBy === 'focus' && (event.target === current || event.target === anchorEl)) hide();
  };
  const onClick = (event) => {
    const name = nameFrom(event.target);
    if (!name || nativeFocusable(name)) return;
    // A name inside a <label> must not toggle the label's checkbox/select.
    event.preventDefault();
    if (current === name && !tip.hidden && shownBy !== 'hover') hide();
    else show(name, 'click');
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('mouseover', onOver);
  doc.addEventListener('mouseout', onOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('click', onClick);
  // Scrolling closes it; keyboard focus that scrolled the popup keeps it in place.
  doc.addEventListener('scroll', () => { if (!current) return; if (shownBy === 'focus') place(anchorEl || current); else hide(); }, true);
  win?.addEventListener?.('resize', hide);
  win?.addEventListener?.('blur', hide);
  // A finished interface translation updates an explanation that is open.
  doc.addEventListener('tp-ui-language-ready', () => { if (current) render(); });
  wire();
  const api = { element: tip, wire, show: (name, anchor) => show(name, 'api', anchor || name), hide,
    get current() { return current; } };
  state.set(doc, api);
  return api;
}
