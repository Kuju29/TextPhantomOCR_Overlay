#!/usr/bin/env python3
"""Capture the popup screenshots used by the visual user guide (src/guide).

Re-run after any popup change:

    python3 scripts/guide/capture-guide.py            # writes src/guide/img/*.webp + guide-data.js
    python3 scripts/guide/capture-guide.py --debug    # also writes full-page PNGs to --debug-dir
    python3 scripts/guide/capture-guide.py --only buy_packages,buy_payment,buy_done
                                                      # re-capture some states, keep the other shots

The popup is loaded from a local static server with a stubbed ``chrome.*``
API. External requests are blocked; the configured API URL answers only
``/health`` so the status dot shows "online". Each state is then staged in the
DOM (values, visibility) exactly like the controllers would render it, and the
relevant region is cropped. Callout positions are measured from element
bounding boxes and saved as percentages, so the guide draws numbered circles
itself and the images contain no explanatory text.

Requirements: Playwright for Python with Chromium, Pillow with WebP.
"""
from __future__ import annotations

import argparse
import functools
import io
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
GUIDE = SRC / "guide"
IMG_DIR = GUIDE / "img"
DATA_FILE = GUIDE / "guide-data.js"
SCALE = 1.5
POPUP_WIDTH = 344
API = "https://api.example.test"
VERSION = json.loads((ROOT / "platform" / "base.json").read_text("utf8"))["version"]
DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

# --------------------------------------------------------------------------
# chrome.* stub (runs before any popup script).
# --------------------------------------------------------------------------
CHROME_STUB = r"""
(() => {
  const seed = window.__TP_SEED || {};
  const areas = {local: {...(seed.local || {})}, session: {...(seed.session || {})}, sync: {}};
  const listeners = new Set();
  const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const pick = (name, keys) => {
    const data = areas[name];
    if (keys == null) return clone(data);
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) { for (const k of keys) if (k in data) out[k] = clone(data[k]); return out; }
    for (const [k, d] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : d;
    return out;
  };
  const later = (cb, value) => { if (typeof cb === 'function') setTimeout(() => cb(value), 0); return Promise.resolve(value); };
  const area = (name) => ({
    get(keys, cb) { if (typeof keys === 'function') { cb = keys; keys = null; } return later(cb, pick(name, keys)); },
    set(items, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(items || {})) { changes[k] = {oldValue: areas[name][k], newValue: clone(v)}; areas[name][k] = clone(v); }
      setTimeout(() => { for (const l of listeners) { try { l(changes, name); } catch {} } }, 0);
      return later(cb);
    },
    remove(keys, cb) { for (const k of [].concat(keys)) delete areas[name][k]; return later(cb); },
    clear(cb) { areas[name] = {}; return later(cb); },
    getBytesInUse(_k, cb) { return later(cb, 0); },
    setAccessLevel() { return Promise.resolve(); },
  });
  const replies = seed.replies || {};
  const reply = (msg) => {
    const type = msg && msg.type;
    if (type in replies) return clone(replies[type]);
    if (type === 'TP_GET_TRANSLATION_SESSIONS') return {runs: []};
    return undefined;
  };
  const event = {addListener() {}, removeListener() {}, hasListener() { return false; }};
  const tab = {id: 7, url: 'https://manga.example.test/series/blue-sky/chapter-12', title: 'Blue Sky - Chapter 12'};
  window.chrome = {
    runtime: {
      id: 'textphantom-guide-capture', lastError: undefined,
      getURL: (p) => new URL(String(p).replace(/^\//, ''), location.origin + '/').href,
      getManifest: () => ({version: seed.version || '0.0.0', manifest_version: 3}),
      sendMessage(...args) { const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null; return later(cb, reply(args[0])); },
      onMessage: event,
      connect() { return {onMessage: event, onDisconnect: event, postMessage() {}, disconnect() {}}; },
      getPlatformInfo(cb) { return later(cb, {os: 'linux'}); },
    },
    storage: {local: area('local'), session: area('session'), sync: area('sync'),
      onChanged: {addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l), hasListener: (l) => listeners.has(l)}},
    tabs: {
      query(_q, cb) { return later(cb, [tab]); }, get(id, cb) { return later(cb, {...tab, id}); },
      create(p, cb) { return later(cb, {id: 8, ...p}); }, sendMessage() { return Promise.resolve(); },
    },
    permissions: {request(_p, cb) { return later(cb, true); }, contains(_p, cb) { return later(cb, true); }},
    extension: {},
  };
})();
"""

# --------------------------------------------------------------------------
# In-page helpers: staging and measuring.
# --------------------------------------------------------------------------
PAGE_HELPERS = r"""
window.__guide = {
  q(sel) { const el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel); return el; },
  show(sel, on = true) { for (const el of document.querySelectorAll(sel)) { el.style.display = on ? '' : 'none'; if (on) el.hidden = false; } },
  hide(sel) { for (const el of document.querySelectorAll(sel)) { el.style.display = 'none'; } },
  text(sel, value) { this.q(sel).textContent = value; },
  options(sel, rows, value) {
    const el = this.q(sel);
    el.replaceChildren(...rows.map(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label; return o; }));
    el.value = value; el.disabled = false;
  },
  tab(name) { window.__tpActivateTab?.(name); },
  clearMessages() { for (const el of document.querySelectorAll('.tp-field-msg')) el.remove(); },
  // Rectangle of a region spanning from the top of `from` to the bottom of `to`
  // (full popup width), in CSS pixels relative to the document.
  region(from, to, pad = 8) {
    const a = this.q(from).getBoundingClientRect(), b = this.q(to || from).getBoundingClientRect();
    const top = Math.max(0, Math.min(a.top, b.top) - pad + scrollY);
    const bottom = Math.max(a.bottom, b.bottom) + pad + scrollY;
    return {x: 0, y: top, width: document.documentElement.clientWidth, height: bottom - top};
  },
  measure(clip, items) {
    return items.map((item) => {
      const el = this.q(item.sel);
      const target = item.box ? (el.closest(item.box) || el) : el;
      const r = target.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('invisible ' + item.sel);
      const left = r.left - clip.x, top = r.top + scrollY - clip.y;
      const anchor = item.anchor || 'left';
      let x = anchor === 'right' ? left + r.width + 15 : anchor === 'top' || anchor === 'bottom' ? left + r.width / 2 : left - 11;
      let y = anchor === 'top' ? top - 6 : anchor === 'bottom' ? top + r.height + 6 : top + Math.min(r.height, 34) / 2;
      const pct = (v, total) => Math.round(Math.min(97, Math.max(3, v / total * 100)) * 10) / 10;
      const raw = (v, total) => Math.round(v / total * 1000) / 10;
      return {key: item.key, sel: item.sel, scope: item.scope || 'popup',
        x: pct(x, clip.width), y: pct(y, clip.height),
        box: {x: raw(left, clip.width), y: raw(top, clip.height), w: raw(r.width, clip.width), h: raw(r.height, clip.height)}};
    });
  },
};
"""

BASE_LOCAL = {
    "customApiUrl": API,
    "mode": "lens_text",
    "lang": "th",
    "sources": "translated",
    "translateAllButtonEnabled": True,
    "imgButtonsEnabled": True,
    "downloadImagesEnabled": False,
    "relayoutTranslated": True,
    "fontScale": 1,
    "engineMode": "extension",
}

SERIES_REPLY = {"ok": True, "memory": {
    "glossary": [{"source": "a", "target": "b"}] * 6,
    "characters": [{"name": "Ren"}, {"name": "Mio"}],
    "prevContext": [], "state": "", "identityKnown": True}}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def start_server():
    handler = functools.partial(QuietHandler, directory=str(SRC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def route_requests(origin):
    def handle(route):
        url = route.request.url
        if url.startswith(origin):
            return route.continue_()
        if url.startswith(API + "/health"):
            return route.fulfill(status=200, content_type="application/json", body='{"ok":true}', headers={"Access-Control-Allow-Origin": "*"})
        if url.startswith(API):
            return route.fulfill(status=503, content_type="application/json", body='{"error":{"message":"offline capture"}}', headers={"Access-Control-Allow-Origin": "*"})
        return route.abort()
    return handle


# --------------------------------------------------------------------------
# States. Each returns a list of shots: (id, alt, region, callouts).
# --------------------------------------------------------------------------
STATES = []


def state(local=None, replies=None, tab="translate", viewport=None):
    def wrap(fn):
        STATES.append((fn.__name__, {**BASE_LOCAL, **(local or {})}, replies or {}, tab, fn, viewport))
        return fn
    return wrap


@state(local={"sources": "ai"})
def header(page):
    page.evaluate("""() => { __guide.tab('translate'); __guide.show('#tab-ai'); }""")
    return [("header", "ส่วนหัวของหน้าต่าง TextPhantom และแท็บด้านบน", (".app-head", ".tabs-row", 22), [
        {"key": "language", "sel": "[data-tp-language-host]"},
        {"key": "status", "sel": "#api-status-emoji"},
        {"key": "tab-translate", "sel": "#tab-translate", "anchor": "bottom"},
        {"key": "tab-ai", "sel": "#tab-ai", "anchor": "bottom"},
        {"key": "tab-tools", "sel": "#tab-tools", "anchor": "bottom"},
        {"key": "guide", "sel": "#open-guide", "anchor": "bottom"},
    ])]


@state()
def translate(page):
    page.evaluate("() => __guide.tab('translate')")
    return [("translate", "แท็บ Translate เมื่อเลือก Lens translation", ("#panel-translate .field", "#download-images-toggle", 10), [
        {"key": "mode", "sel": "#mode"},
        {"key": "lang", "sel": "#lang"},
        {"key": "sources", "sel": "#sources"},
        {"key": "relayout", "sel": "#relayout-translated", "box": "label"},
        {"key": "font", "sel": "#font-scale-down"},
        {"key": "translate-all", "sel": "#translate-all-button-toggle", "box": "label"},
        {"key": "img-buttons", "sel": "#img-buttons-toggle", "box": "label"},
        {"key": "download", "sel": "#download-images-toggle", "box": "label"},
    ])]


@state(local={"sources": "ai"})
def source_ai(page):
    page.evaluate("() => __guide.tab('translate')")
    return [("source-ai", "เลือก Text output เป็น AI translation แล้วแท็บ AI settings จะปรากฏ", (".tabs-row", "#sources", 8), [
        {"key": "tab-ai", "sel": "#tab-ai"},
        {"key": "sources", "sel": "#sources"},
    ])]


MANUAL_STAGE = """() => {
  __guide.tab('ai'); __guide.clearMessages();
  __guide.show('#ai-group'); __guide.show('#ai-service-wrap'); __guide.hide('#ai-paid-panel'); __guide.hide('#ai-paid-unavailable');
  document.querySelector('#ai-service').value = 'manual';
  __guide.show('#ai-usage-wrap');
  __guide.text('#ai-usage-total', '12,340');
  __guide.show('#ai-provider-wrap'); __guide.show('#ai-model-wrap'); __guide.show('#ai-thinking-wrap');
  __guide.show('#ai-prompt-wrap'); __guide.show('#ai-characters-wrap'); __guide.show('#ai-page-image-wrap');
  __guide.show('#ai-token-ceiling-wrap'); __guide.show('#ai-translation-mode-wrap');
  for (const o of document.querySelectorAll('#ai-thinking option')) o.disabled = false;
  document.querySelector('#ai-thinking').value = 'minimum'; document.querySelector('#ai-thinking').disabled = false;
  __guide.text('#ai-thinking-hint', '');
  document.querySelector('#ai-memory-mode').value = 'terms';
  document.querySelector('#ai-page-image').checked = false; document.querySelector('#ai-page-image').disabled = false;
  document.querySelector('#ai-style-examples').checked = true;
  __guide.text('#ai-characters-count', 'blue-sky - 2 characters (Ren, Mio), 6 terms, 0 excerpts');
}"""


@state(local={"sources": "ai", "aiServiceMode": "manual", "aiProvider": "gemini", "aiCloudKey": "AIzaSyExampleKeyForGuideOnly000000"},
       replies={"TP_GET_SERIES_MEMORY": SERIES_REPLY}, tab="ai")
def manual(page):
    page.evaluate(MANUAL_STAGE)
    page.evaluate("""() => {
      document.querySelector('#ai-provider').value = 'gemini';
      __guide.hide('#ai-endpoint-wrap'); __guide.show('#ai-key-wrap');
      document.querySelector('#ai-key').value = 'AIzaSyExampleKeyForGuideOnly000000';
      __guide.options('#ai-model', [['gemini-2.5-flash', 'gemini-2.5-flash']], 'gemini-2.5-flash');
      __guide.hide('#ai-local-model-hint'); __guide.hide('#ai-local-capacity-wrap');
      __guide.text('#ai-key-hint', '');
      const link = document.querySelector('#ai-key-get'); link.hidden = false; link.href = 'https://aistudio.google.com/app/apikey';
    }""")
    return [
        ("manual-top", "แท็บ AI settings แบบ Manual ใช้ API key ของตัวเอง", ("#ai-usage-wrap", "#ai-thinking-wrap", 10), [
            {"key": "usage", "sel": "#ai-usage-wrap"},
            {"key": "service", "sel": "#ai-service"},
            {"key": "provider", "sel": "#ai-provider"},
            {"key": "key", "sel": "#ai-key"},
            {"key": "get-key", "sel": "#ai-key-get", "anchor": "right"},
            {"key": "model", "sel": "#ai-model"},
            {"key": "thinking", "sel": "#ai-thinking"},
        ]),
        ("manual-bottom", "ตัวเลือกเพิ่มเติมของ AI: prompt, ความจำเรื่อง, ภาพหน้า, เพดานโทเคน", ("#ai-prompt-wrap", "#ai-translation-mode-wrap", 10), [
            {"key": "prompt", "sel": "#ai-prompt"},
            {"key": "prompt-tools", "sel": "#ai-prompt-back", "anchor": "top"},
            {"key": "memory-clear", "sel": "#ai-characters-clear", "anchor": "right"},
            {"key": "memory-mode", "sel": "#ai-memory-mode", "box": "label"},
            {"key": "examples", "sel": "#ai-style-examples", "box": "label"},
            {"key": "page-image", "sel": "#ai-page-image", "box": "label"},
            {"key": "ceiling", "sel": "#ai-token-ceiling-enabled", "box": "label"},
            {"key": "request-mode", "sel": "#ai-translation-mode"},
        ]),
    ]


@state(local={"sources": "ai", "aiServiceMode": "manual", "aiProvider": "ollama", "aiBaseUrl": "http://localhost:11434"},
       replies={"TP_GET_SERIES_MEMORY": SERIES_REPLY}, tab="ai")
def local(page):
    page.evaluate(MANUAL_STAGE)
    page.evaluate("""() => {
      document.querySelector('#ai-provider').value = 'ollama';
      __guide.show('#ai-endpoint-wrap'); __guide.hide('#ai-key-wrap'); __guide.hide('#ai-local-adapter-wrap');
      document.querySelector('#ai-base-url').value = 'http://localhost:11434';
      __guide.text('#ai-local-status', '');
      __guide.options('#ai-model', [['qwen3:8b', 'qwen3:8b']], 'qwen3:8b');
      __guide.hide('#ai-local-model-hint'); __guide.show('#ai-local-capacity-wrap');
      __guide.text('#ai-local-capacity-hint', '');
      __guide.hide('#ai-thinking-wrap');
    }""")
    return [("local", "AI แบบ Local ที่รันบนคอมพิวเตอร์ของคุณ", ("#ai-provider-wrap", "#ai-model-wrap", 10), [
        {"key": "provider", "sel": "#ai-provider"},
        {"key": "base-url", "sel": "#ai-base-url"},
        {"key": "refresh", "sel": "#ai-local-test"},
        {"key": "model", "sel": "#ai-model"},
        {"key": "capacity", "sel": "#ai-local-capacity-mode"},
    ])]


PAID_STAGE = """() => {
  __guide.tab('ai'); __guide.clearMessages();
  __guide.show('#ai-group'); __guide.show('#ai-service-wrap'); __guide.hide('#ai-paid-unavailable');
  document.querySelector('#ai-service').value = 'paid';
  __guide.show('#ai-paid-panel');
  for (const s of ['#ai-provider-wrap','#ai-key-wrap','#ai-model-wrap','#ai-endpoint-wrap','#ai-usage-wrap']) __guide.hide(s);
  __guide.text('#ai-paid-status', '');
}"""


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai")
def paid_signin(page):
    page.evaluate(PAID_STAGE)
    page.evaluate("""() => {
      __guide.show('#ai-paid-login'); __guide.hide('#ai-paid-account');
      __guide.show('#ai-paid-email-step'); __guide.hide('#ai-paid-code-step');
      __guide.text('#ai-paid-title', 'Sign in or create account');
      __guide.text('#ai-paid-subtitle', 'Continue with email. Your account is created after verification.');
      document.querySelector('#ai-paid-send').disabled = false;
      for (const s of ['#ai-thinking-wrap','#ai-prompt-wrap','#ai-characters-wrap','#ai-page-image-wrap','#ai-token-ceiling-wrap','#ai-translation-mode-wrap']) __guide.hide(s);
    }""")
    shots = [("paid-signin", "เลือก AI service เป็น Paid แล้วเข้าสู่ระบบด้วยอีเมล", ("#ai-service-wrap", "#ai-paid-panel", 10), [
        {"key": "service", "sel": "#ai-service"},
        {"key": "email", "sel": "#ai-paid-email"},
        {"key": "send", "sel": "#ai-paid-send"},
    ])]
    return shots


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai")
def paid_code(page):
    page.evaluate(PAID_STAGE)
    page.evaluate("""() => {
      __guide.show('#ai-paid-login'); __guide.hide('#ai-paid-account');
      __guide.hide('#ai-paid-email-step'); __guide.show('#ai-paid-code-step');
      __guide.text('#ai-paid-title', 'Verify your email');
      __guide.text('#ai-paid-subtitle', 'Enter the 6-digit code. First time? This creates your account.');
      __guide.text('#ai-paid-code-email', 'you@example.com');
      for (const s of ['#ai-paid-verify','#ai-paid-change-email','#ai-paid-resend']) document.querySelector(s).disabled = false;
      for (const s of ['#ai-thinking-wrap','#ai-prompt-wrap','#ai-characters-wrap','#ai-page-image-wrap','#ai-token-ceiling-wrap','#ai-translation-mode-wrap']) __guide.hide(s);
    }""")
    return [("paid-code", "ใส่รหัส 6 หลักที่ได้รับทางอีเมล", ("#ai-paid-panel", "#ai-paid-panel", 6), [
        {"key": "code", "sel": "#ai-paid-code"},
        {"key": "verify", "sel": "#ai-paid-verify"},
        {"key": "change-email", "sel": "#ai-paid-change-email", "anchor": "bottom"},
        {"key": "resend", "sel": "#ai-paid-resend", "anchor": "bottom"},
    ])]


PAID_ACCOUNT_STAGE = """(source) => {
  __guide.show('#ai-paid-account'); __guide.hide('#ai-paid-login');
  __guide.text('#ai-paid-email-label', 'you@example.com');
  __guide.text('#ai-paid-credits', '25,000 TP');
  __guide.text('#ai-paid-held', 'Reserved: 0 TP');
  __guide.text('#ai-paid-account-state', 'Signed in'); document.querySelector('#ai-paid-account-state').dataset.kind = 'success';
  __guide.show('#ai-paid-source-wrap'); document.querySelector('#ai-paid-source').value = source; document.querySelector('#ai-paid-source').disabled = false;
  __guide.show('#ai-paid-tp-model', source === 'tp'); __guide.show('#ai-login-panel', source === 'login');
  for (const s of ['#ai-thinking-wrap','#ai-prompt-wrap','#ai-characters-wrap','#ai-page-image-wrap','#ai-token-ceiling-wrap','#ai-translation-mode-wrap']) __guide.show(s);
  for (const o of document.querySelectorAll('#ai-thinking option')) o.disabled = false;
  document.querySelector('#ai-thinking').disabled = false;
}"""

PAID_MODELS = [
    ("google/gemini-2.5-flash", "Gemini 2.5 Flash", "1", "3"),
    ("google/gemini-2.5-pro", "Gemini 2.5 Pro", "5", "38"),
    ("openai/gpt-5-mini", "GPT-5 mini", "1", "8"),
    ("deepseek/deepseek-chat", "DeepSeek V3", "1", "2"),
]


def stage_paid_models(page, open_picker=False, query=""):
    page.evaluate("""([models, open, query]) => {
      const sel = document.querySelector('#ai-paid-model');
      __guide.options('#ai-paid-model', models.map(m => [m[0], m[1]]), models[0][0]);
      const list = document.querySelector('#ai-paid-model-options');
      list.replaceChildren(...models.map((m, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'paid-model-option';
        b.setAttribute('aria-pressed', String(i === 0)); b.dataset.modelName = m[1]; b.dataset.modelId = m[0];
        for (const v of [m[1], '≈ ' + m[2], '≈ ' + m[3]]) { const s = document.createElement('span'); s.setAttribute('translate','no'); s.textContent = v; b.append(s); }
        const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
        b.hidden = !words.every(w => (m[1] + ' ' + m[0]).toLowerCase().includes(w));
        return b;
      }));
      __guide.text('#ai-paid-model-name', models[0][1]);
      document.querySelector('#ai-paid-model-picker summary').setAttribute('aria-disabled', 'false');
      __guide.text('#ai-paid-model-input', '≈ ' + models[0][2] + ' TP');
      __guide.text('#ai-paid-model-output', '≈ ' + models[0][3] + ' TP');
      __guide.text('#ai-paid-model-price-status', 'Current paired route estimate · final charge from reported usage · TP per 1,000 tokens; cache and actual usage affect the final charge.');
      document.querySelector('#ai-paid-model-empty').hidden = true;
      document.querySelector('#ai-paid-model-search').value = query;
      document.querySelector('#ai-paid-model-picker').open = open;
    }""", [PAID_MODELS, open_picker, query])


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai")
def paid_account(page):
    page.evaluate(PAID_STAGE)
    page.evaluate(PAID_ACCOUNT_STAGE, "tp")
    stage_paid_models(page)
    return [("paid-account", "บัญชี Paid หลังเข้าสู่ระบบ: เครดิต โมเดล และราคา", ("#ai-paid-panel", "#ai-paid-panel", 6), [
        {"key": "credits", "sel": "#ai-paid-credits"},
        {"key": "buy", "sel": "#ai-paid-buy"},
        {"key": "details", "sel": "#ai-paid-details"},
        {"key": "source", "sel": "#ai-paid-source"},
        {"key": "model", "sel": "#ai-paid-model-picker"},
        {"key": "rates", "sel": "#ai-paid-model-input", "box": "div"},
        {"key": "pricing-help", "sel": ".paid-pricing-help summary"},
        {"key": "refresh", "sel": "#ai-paid-refresh", "anchor": "bottom"},
        {"key": "logout", "sel": "#ai-paid-logout", "anchor": "bottom"},
    ])]


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai")
def paid_picker(page):
    page.evaluate(PAID_STAGE)
    page.evaluate(PAID_ACCOUNT_STAGE, "tp")
    stage_paid_models(page, open_picker=True, query="gemini")
    return [("paid-picker", "ช่องค้นหาโมเดลใน Translation model", ("#ai-paid-tp-model", "#ai-paid-model-picker", 6), [
        {"key": "search", "sel": "#ai-paid-model-search"},
        {"key": "row", "sel": "#ai-paid-model-options .paid-model-option"},
        {"key": "columns", "sel": ".paid-model-columns", "anchor": "right"},
    ])]


# --------------------------------------------------------------------------
# Buying a credit pack. "Buy credits" opens the account view inside the popup
# (460 x 600). The real renderer (shared/customer-portal/view.js) draws it
# from synthetic account data, mounted the way paid/inline.js and
# paid-service-controller.js mount it. Package names, prices and the order
# reference are examples; the Stripe page itself is external and not captured.
# --------------------------------------------------------------------------
ACCOUNT_VIEWPORT = {"width": 460, "height": 600}
BUY_ORDER_ID = "ord_" + "0123456789abcdef" * 2
BUY_PACKAGES = [
    {"id": "pkg_guide_small", "name": "Starter", "version": 1, "price_satang": 9900, "credits": "10000", "months": 6},
    {"id": "pkg_guide_medium", "name": "Standard", "version": 1, "price_satang": 24900, "credits": "30000", "months": 12},
]


def buy_order(status):
    order = {
        "id": BUY_ORDER_ID, "package_id": "pkg_guide_medium", "package_version": 1, "package_name": "Standard",
        "amount_satang": 24900, "credits": "30000", "months": 12, "status": status, "method": "checkout",
        "mode": "live", "confirmation": "stripe_verified", "payment_provider": "Stripe",
        "recheck_allowed": True, "cancel_allowed": status == "waiting", "cancel_pending": False,
    }
    if status == "waiting":
        order["checkout_url"] = "https://checkout.stripe.com/c/pay/cs_live_guideExampleOnly"
        order["payment_state"] = "open"
    if status == "credited":
        order.update({"payment_id": "pay_guide_example", "payment_state": "succeeded", "recheck_allowed": False})
    return order


ACCOUNT_STAGE = """async ([tab, credits, order, scroll]) => {
  const { renderCustomerAccount } = await import('/shared/customer-portal/view.js');
  const now = Date.now();
  if (order) {
    order.created_at = now - 120000;
    if (order.status === 'waiting') order.checkout_expires_at = now + 23 * 3600000;
    if (order.status === 'credited') order.confirmed_at = now - 20000;
  }
  const data = {
    email: 'you@example.com',
    credits: { available: credits, held: '0', consumed: '0', purchased: '0', trial: '0', granted: '0', expired: '0', revoked: '0' },
    packages: __BUY_PACKAGES__,
    purchase: { ready: true, mode: 'stripe_checkout', automatic_payment: true },
    history: { orders: { items: order ? [order] : [], total: order ? 1 : 0, offset: 0, limit: 25 },
      payments: { items: [], total: 0, offset: 0, limit: 25 }, ledger: { items: [], total: 0 }, lots: { items: [], total: 0 },
      usage: { items: [], total: 0 }, refunds: { items: [], total: 0 } },
    models: [],
  };
  const root = renderCustomerAccount(data, { tab, compact: true, activeOrder: order || null,
    onTab() {}, onBack() {}, onRefresh() {}, onBuy() {}, onViewOrder() {}, onOrderAction() {}, onHistory() {} });
  root.dataset.theme = 'dark';
  // paid-service-controller toggleUi() while the account view is open.
  __guide.hide('#ai-paid-account'); __guide.hide('#ai-paid-login');
  for (const s of ['#ai-thinking-wrap','#ai-prompt-wrap','#ai-characters-wrap','#ai-page-image-wrap','#ai-token-ceiling-wrap','#ai-translation-mode-wrap']) __guide.hide(s);
  const mount = document.querySelector('#ai-paid-inline');
  mount.replaceChildren(root); mount.hidden = false;
  for (const node of [document.documentElement, document.body]) { node.dataset.paidSurface = 'popup'; node.classList.add('paid-account-open'); }
  document.querySelector('#ai-paid-panel').classList.add('paid-browsing');
  const content = root.querySelector('.tp-account-content');
  const top = scroll && root.querySelector(scroll);
  if (top) content.scrollTop += top.getBoundingClientRect().top - content.getBoundingClientRect().top;
}""".replace("__BUY_PACKAGES__", json.dumps(BUY_PACKAGES))

VIEW = "shared/customer-portal/view.js"


def stage_account(page, tab, credits, order=None, scroll=""):
    page.evaluate(PAID_STAGE)
    page.evaluate(PAID_ACCOUNT_STAGE, "tp")
    page.evaluate(ACCOUNT_STAGE, [tab, credits, order, scroll])
    page.wait_for_timeout(250)


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai", viewport=ACCOUNT_VIEWPORT)
def buy_packages(page):
    stage_account(page, "buy", "1200")
    return [("buy-packages", "หน้า Buy credits: เลือกแพ็กเครดิต", ("#ai-paid-panel", "#ai-paid-panel", 0), [
        {"key": "tab", "sel": ".tp-account-tabs .selected", "scope": VIEW, "anchor": "bottom"},
        {"key": "available", "sel": ".tp-account-wallet-strip", "scope": VIEW},
        {"key": "package", "sel": ".tp-account-package", "scope": VIEW},
        {"key": "select", "sel": ".tp-account-package .tp-account-button", "scope": VIEW},
        {"key": "how", "sel": ".tp-account-disclosure summary", "scope": VIEW},
        {"key": "back", "sel": ".tp-account-back", "scope": VIEW, "anchor": "bottom"},
        {"key": "reload", "sel": ".tp-account-refresh", "scope": VIEW, "anchor": "bottom"},
    ])]


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai", viewport=ACCOUNT_VIEWPORT)
def buy_payment(page):
    stage_account(page, "payment", "1200", buy_order("waiting"))
    return [("buy-payment", "หน้าชำระเงินหลังกด Select package: สรุปรายการและปุ่มเปิด Stripe", ("#ai-paid-panel", "#ai-paid-panel", 0), [
        {"key": "summary", "sel": ".tp-account-checkout-summary", "scope": VIEW, "anchor": "top"},
        {"key": "status", "sel": ".tp-account-status", "scope": VIEW, "anchor": "right"},
        {"key": "open", "sel": ".tp-account-payment a.tp-account-button", "scope": VIEW},
        {"key": "check", "sel": ".tp-account-payment-actions .tp-account-button", "scope": VIEW},
        {"key": "cancel", "sel": ".tp-account-payment-actions .quiet", "scope": VIEW, "anchor": "right"},
        {"key": "details", "sel": ".tp-account-payment .tp-account-disclosure summary", "scope": VIEW},
        {"key": "back", "sel": ".tp-account-back", "scope": VIEW, "anchor": "bottom"},
    ])]


@state(local={"sources": "ai", "aiServiceMode": "paid"}, tab="ai", viewport=ACCOUNT_VIEWPORT)
def buy_done(page):
    stage_account(page, "payment", "31200", buy_order("credited"), scroll=".tp-account-payment-state")
    return [("buy-done", "ชำระเงินสำเร็จ: Credits added และยอดเครดิตใหม่", ("#ai-paid-panel", "#ai-paid-panel", 0), [
        {"key": "status", "sel": ".tp-account-status", "scope": VIEW, "anchor": "right"},
        {"key": "success", "sel": ".tp-account-success", "scope": VIEW},
        {"key": "view-account", "sel": ".tp-account-success .tp-account-button", "scope": VIEW},
        {"key": "available", "sel": ".tp-account-payment > .tp-account-pairs dd", "scope": VIEW, "anchor": "right"},
    ])]


LOGIN_SUPPORT = ("Claude Login translates through a claude.ai tab in this browser. TextPhantom opens one in the background "
                 "when needed and closes the tabs it opened once they are idle; your own tabs stay open. You can keep browsing "
                 "other tabs. Keep the browser open and stay signed in; closing that tab during a translation stops it.")


@state(local={"sources": "ai", "aiServiceMode": "paid", "paidTranslationSource": "login", "loginProvider": "login_claude"}, tab="ai")
def login(page):
    page.evaluate(PAID_STAGE)
    page.evaluate(PAID_ACCOUNT_STAGE, "login")
    page.evaluate("""(support) => {
      __guide.options('#ai-login-provider', [['login_chatgpt','ChatGPT'],['login_claude','Claude'],['login_gemini','Gemini'],['login_deepseek','DeepSeek']], 'login_claude');
      __guide.text('#ai-login-account', 'Use your own AI account');
      __guide.show('#ai-login-support'); __guide.text('#ai-login-support', support);
      const c = document.querySelector('#ai-login-connect'); c.textContent = 'Sign in'; c.disabled = false;
      document.querySelector('#ai-login-refresh').disabled = false;
      __guide.hide('#ai-login-cancel'); __guide.hide('#ai-login-logout'); __guide.hide('#ai-login-model-wrap'); __guide.hide('#ai-login-project-wrap');
      __guide.text('#ai-login-status', 'Login opens the provider website. Your session will be sent to the selected API; translation runs through its endpoints. API: https://api.example.test');
    }""", LOGIN_SUPPORT)
    return [("login", "เลือก Translation source เป็น Login เพื่อใช้บัญชี AI ของคุณเอง", ("#ai-paid-source-wrap", "#ai-login-panel", 8), [
        {"key": "source", "sel": "#ai-paid-source"},
        {"key": "provider", "sel": "#ai-login-provider"},
        {"key": "support", "sel": "#ai-login-support"},
        {"key": "connect", "sel": "#ai-login-connect"},
        {"key": "refresh", "sel": "#ai-login-refresh", "anchor": "top"},
        {"key": "status", "sel": "#ai-login-status"},
    ])]


@state()
def tools(page):
    page.evaluate("""() => {
      __guide.tab('tools');
      __guide.show('#contact-admin');
      __guide.text('#local-picker-msg', '');
    }""")
    return [("tools", "แท็บ Tools", ("#panel-tools .section-title", "#contact-admin", 8), [
        {"key": "local-images", "sel": "#open-local-images"},
        {"key": "local-folder", "sel": "#open-local-folder", "anchor": "right"},
        {"key": "auto", "sel": "#open-auto-translate"},
        {"key": "api-url", "sel": "#api-url"},
        {"key": "reset-api", "sel": "#reset-api", "anchor": "right"},
        {"key": "engine", "sel": "#engine-mode"},
        {"key": "reset", "sel": "#reset-defaults"},
        {"key": "contact", "sel": "#contact-admin"},
    ])]


# --------------------------------------------------------------------------
# On-page demo: the real content scripts render the image button, the
# right-edge "Translate all" drawer and the status toast on a sample page.
# --------------------------------------------------------------------------
DEMO_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Sample chapter</title>
<style>body{margin:0;background:#f3f4f8;font:14px system-ui,sans-serif;color:#222}
header{padding:14px 22px;background:#fff;border-bottom:1px solid #dde}
main{display:flex;justify-content:center;padding:22px}
.page{width:360px;height:440px;border-radius:6px;box-shadow:0 2px 10px #0002;display:block}</style></head>
<body><header>Blue Sky &middot; Chapter 12</header><main>
<img class="page" id="demo-image" alt="" src="data:image/svg+xml;utf8,__SVG__"></main>
__SCRIPTS__
</body></html>"""

DEMO_SVG = """<svg xmlns='http://www.w3.org/2000/svg' width='360' height='440' viewBox='0 0 360 440'>
<rect width='360' height='440' fill='#fff'/><g fill='none' stroke='#222' stroke-width='3'>
<rect x='14' y='14' width='332' height='190'/><rect x='14' y='216' width='160' height='210'/><rect x='186' y='216' width='160' height='210'/></g>
<g fill='#fff' stroke='#222' stroke-width='2'><ellipse cx='110' cy='70' rx='70' ry='34'/><ellipse cx='262' cy='300' rx='58' ry='40'/></g>
<g fill='#c9cedb'><circle cx='250' cy='140' r='38'/><circle cx='92' cy='330' r='34'/></g></svg>"""


def capture_demo(context, origin, debug_dir):
    svg = DEMO_SVG.replace("#", "%23").replace("\n", "")
    manifest = json.loads((ROOT / "platform" / "base.json").read_text("utf8"))
    # The same content scripts, in the same order, as the shipped manifest.
    scripts = "".join(f'<script src="/{name}"></script>' for name in manifest["content_scripts"][0]["js"])
    html = DEMO_HTML.replace("__SVG__", svg).replace("__SCRIPTS__", scripts)
    page = context.new_page()
    page.set_viewport_size({"width": 760, "height": 560})
    page.route(origin + "/__demo.html", lambda route: route.fulfill(status=200, content_type="text/html", body=html))
    page.goto(origin + "/__demo.html")
    page.wait_for_timeout(800)
    page.add_script_tag(content=PAGE_HELPERS)
    page.hover("#demo-image")
    page.wait_for_timeout(300)
    page.evaluate("""() => {
      const now = Date.now();
      const item = (n, done) => ({label: 'Image ' + n, terminal: done, inserted: done,
        progress: {overall: {state: done ? 'done' : 'running', startedAt: now - 9000},
          ai: done ? {state: 'done'} : {state: 'running', startedAt: now - 7000, function: 'generating_response', conversation: true, pageCount: 4}}});
      window.__TP.updateBatchProgress({id: 'demo', sequence: 1, startedAt: now + 50, total: 12, lifecycle: 'running',
        items: [1,2,3].map(n => item(n, true)).concat([4,5,6,7].map(n => item(n, false)))});
      const host = document.querySelector('#tp-translate-all-control');
      const drawer = host?.shadowRoot?.querySelector('.drawer');
      drawer?.setAttribute('data-open', 'true');
      const action = host?.shadowRoot?.querySelector('.action'); if (action) action.tabIndex = 0;
    }""")
    page.wait_for_timeout(500)
    clip = {"x": 0, "y": 0, "width": 760, "height": 560}
    callouts = page.evaluate("""(clip) => {
      const out = [];
      const add = (key, sel, r, anchor, scope) => {
        const pct = v => Math.round(Math.min(97, Math.max(3, v)) * 10) / 10;
        const raw = v => Math.round(v * 10) / 10;
        let x = anchor === 'left' ? r.left - 4 : r.left + r.width / 2, y = anchor === 'left' ? r.top + r.height / 2 : r.top - 4;
        out.push({key, sel, scope, x: pct(x / clip.width * 100), y: pct(y / clip.height * 100),
          box: {x: raw(r.left / clip.width * 100), y: raw(r.top / clip.height * 100), w: raw(r.width / clip.width * 100), h: raw(r.height / clip.height * 100)}});
      };
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('🔍'));
      if (!btn) throw new Error('image button not rendered');
      add('image-button', '.tp-img-btn', btn.getBoundingClientRect(), 'left', 'content/image-buttons.js');
      const host = document.querySelector('#tp-translate-all-control');
      const action = host.shadowRoot.querySelector('.action');
      add('translate-all', '#tp-translate-all-control', action.getBoundingClientRect(), 'top', 'content/translate-all-button.js');
      const toast = document.querySelector('#tp-toast');
      if (!toast || getComputedStyle(toast).display === 'none') throw new Error('toast not rendered');
      add('toast', '#tp-toast', toast.getBoundingClientRect(), 'top', 'content/dom-utils.js');
      const toggle = toast.querySelector('button');
      add('toast-details', '#tp-toast', toggle.getBoundingClientRect(), 'top', 'content/dom-utils.js');
      return out;
    }""", clip)
    png = page.screenshot(clip=clip)
    if debug_dir:
        (debug_dir / "page-demo.png").write_bytes(png)
    page.close()
    return [("page-demo", "ตัวอย่างหน้าเว็บระหว่างแปล: ปุ่มบนภาพ ปุ่มแปลทั้งหน้า และกล่องสถานะมุมขวาล่าง", png, clip, callouts)]


# Where a newly added shot goes in guide-data.js when only some states are re-captured.
ANCHORS = {"buy-packages": ("paid-picker",), "buy-payment": ("buy-packages",), "buy-done": ("buy-payment",)}


def save_webp(png_bytes, name):
    image = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    out = IMG_DIR / f"{name}.webp"
    image.save(out, "WEBP", quality=86, method=6)
    return out, image.size


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--debug", action="store_true", help="write full-page PNG per state")
    parser.add_argument("--debug-dir", default=str(Path(os.environ.get("TMPDIR", "/tmp")) / "tp-guide-debug"))
    parser.add_argument("--chromium", default=os.environ.get("TP_CHROMIUM", DEFAULT_CHROMIUM))
    parser.add_argument("--only", default="", help="comma-separated state names (page_demo for the on-page demo); "
                        "other shots are kept from the existing guide-data.js")
    args = parser.parse_args()
    known = {entry[0] for entry in STATES} | {"page_demo"}
    only = {name.strip() for name in args.only.split(",") if name.strip()}
    unknown = only - known
    if unknown:
        parser.error(f"unknown state(s): {', '.join(sorted(unknown))}; known: {', '.join(sorted(known))}")
    debug_dir = Path(args.debug_dir) if args.debug else None
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)

    server = start_server()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    shots = {}
    order = []
    try:
        with sync_playwright() as pw:
            launch = {"args": ["--no-sandbox"]}
            if args.chromium and Path(args.chromium).exists():
                launch["executable_path"] = args.chromium
            browser = pw.chromium.launch(**launch)
            for name, local, replies, _tab, fn, viewport in STATES:
                if only and name not in only:
                    continue
                context = browser.new_context(viewport=viewport or {"width": POPUP_WIDTH, "height": 1800},
                                              device_scale_factor=SCALE, color_scheme="dark", locale="en-US")
                seed = {"local": local, "replies": replies, "version": VERSION}
                context.add_init_script(script=f"window.__TP_SEED = {json.dumps(seed)};\n{CHROME_STUB}")
                context.add_init_script(script="try { localStorage.clear(); } catch {}")
                context.route("**/*", route_requests(origin))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(origin + "/popup/popup.html")
                page.wait_for_timeout(1800)
                page.add_script_tag(content=PAGE_HELPERS)
                for shot_id, alt, (start, end, pad), items in fn(page):
                    page.wait_for_timeout(150)
                    clip = page.evaluate("([a, b, p]) => __guide.region(a, b, p)", [start, end, pad])
                    callouts = page.evaluate("([clip, items]) => __guide.measure(clip, items)", [clip, items])
                    png = page.screenshot(clip=clip, full_page=True)
                    path, size = save_webp(png, shot_id)
                    shots[shot_id] = {"img": f"img/{path.name}", "alt": alt, "width": size[0], "height": size[1], "callouts": callouts}
                    order.append(shot_id)
                    print(f"{shot_id}: {size[0]}x{size[1]} {path.stat().st_size // 1024} KB, {len(callouts)} callouts")
                if debug_dir:
                    page.screenshot(path=str(debug_dir / f"{name}.png"), full_page=True)
                if errors:
                    print(f"  page errors in {name}: {errors[:3]}")
                context.close()

            if not only or "page_demo" in only:
                context = browser.new_context(device_scale_factor=SCALE, color_scheme="light", locale="th-TH")
                context.add_init_script(script=f"window.__TP_SEED = {json.dumps({'local': {'imgButtonsEnabled': True, 'translateAllButtonEnabled': True}})};\n{CHROME_STUB}")
                context.route("**/*", route_requests(origin))
                for shot_id, alt, png, clip, callouts in capture_demo(context, origin, debug_dir):
                    path, size = save_webp(png, shot_id)
                    shots[shot_id] = {"img": f"img/{path.name}", "alt": alt, "width": size[0], "height": size[1], "callouts": callouts}
                    order.append(shot_id)
                    print(f"{shot_id}: {size[0]}x{size[1]} {path.stat().st_size // 1024} KB, {len(callouts)} callouts")
                context.close()
            browser.close()
    finally:
        server.shutdown()

    merged = {k: shots[k] for k in order}
    if only:
        # Keep every other shot; a re-captured shot keeps its place, a new one
        # follows the shot captured just before it in STATES order.
        source = DATA_FILE.read_text("utf8")
        previous = json.loads(source[source.index("window.TP_GUIDE_DATA = ") + 23:].strip().rstrip(";"))["shots"]
        merged = dict(previous)
        for shot_id in order:
            if shot_id in merged:
                merged[shot_id] = shots[shot_id]
                continue
            items = list(merged.items())
            anchor = next((i for i, (k, _v) in enumerate(items) if k in ANCHORS.get(shot_id, ())), None)
            if anchor is None:
                items.append((shot_id, shots[shot_id]))
            else:
                items.insert(anchor + 1, (shot_id, shots[shot_id]))
            merged = dict(items)
    data = {"generatedBy": "scripts/guide/capture-guide.py", "version": VERSION, "scale": SCALE,
            "shots": merged}
    DATA_FILE.write_text(
        "// Generated by scripts/guide/capture-guide.py. Do not edit by hand; re-run the script.\n"
        "// Callout x/y and box values are percentages of the image size.\n"
        f"window.TP_GUIDE_DATA = {json.dumps(data, ensure_ascii=False, indent=1)};\n", "utf8")
    total = sum(p.stat().st_size for p in IMG_DIR.glob("*.webp"))
    print(f"wrote {DATA_FILE.relative_to(ROOT)} and {len(order)} images ({total // 1024} KB total in img/)")


if __name__ == "__main__":
    main()
