// .84 visual user guide (src/guide): the guide must stay self-contained, its
// screenshots must exist, and every numbered callout must still point at a
// real popup control. When the popup changes, this test fails loudly; re-run
// `python3 scripts/guide/capture-guide.py` and update guide.html.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userMessageForCode } from "../src/shared/error-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const guideDir = "src/guide";
let checks = 0;
const test = (name, fn) => { fn(); checks += 1; console.log(`PASS ${name}`); };

const html = read(`${guideDir}/guide.html`);
const css = read(`${guideDir}/guide.css`);
const js = read(`${guideDir}/guide.js`);
const dataSource = read(`${guideDir}/guide-data.js`);
const popup = read("src/popup/popup.html");
const decode = (value) => value.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const data = (() => {
  const prefix = "window.TP_GUIDE_DATA = ";
  const start = dataSource.indexOf(prefix);
  assert.ok(start >= 0, "guide-data.js must assign window.TP_GUIDE_DATA");
  return JSON.parse(dataSource.slice(start + prefix.length).trim().replace(/;$/, ""));
})();
const shots = data.shots || {};

test("guide page exists and references only packaged local assets", () => {
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    if (ref.startsWith("#")) continue;
    assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `remote or absolute reference in guide.html: ${ref}`);
    assert.ok(existsSync(path.join(root, guideDir, ref)), `guide.html references a missing file: ${ref}`);
  }
  for (const script of ["guide-data.js", "guide.js"])
    assert.match(html, new RegExp(`<script src="${script.replace(".", "\\.")}"></script>`));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "MV3 CSP forbids inline scripts");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "MV3 CSP forbids inline event handlers");
  assert.doesNotMatch(css, /@import|url\(\s*["']?(?:https?:)?\/\//i, "guide.css must not load remote fonts or images");
  assert.doesNotMatch(js, /https?:\/\/|fetch\s*\(|import\s*\(/, "guide.js must not load remote code or data");
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /"Noto Sans Thai"/);
});

test("every screenshot exists, is local and the total stays small", () => {
  const ids = Object.keys(shots);
  assert.ok(ids.length >= 10, "expected the generated screenshot set");
  let total = 0;
  for (const [id, shot] of Object.entries(shots)) {
    assert.match(shot.img, /^img\/[a-z0-9-]+\.(?:webp|png)$/, `${id}: image path`);
    const file = path.join(root, guideDir, shot.img);
    assert.ok(existsSync(file), `${id}: missing ${shot.img}`);
    total += statSync(file).size;
    assert.ok(typeof shot.alt === "string" && shot.alt.trim(), `${id}: alt text is required`);
    assert.ok(shot.width > 0 && shot.height > 0, `${id}: image size`);
  }
  assert.ok(total < 2.5 * 1024 * 1024, `guide images are ${total} bytes (limit 2.5 MB)`);
});

test("figures and numbered explanation lists match the generated callouts", () => {
  const figures = [...html.matchAll(/<figure class="shot" data-shot="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...figures].sort(), Object.keys(shots).sort(), "every screenshot is shown exactly once");
  for (const id of figures) {
    const list = html.match(new RegExp(`<ol class="callout-list" data-shot="${id}">([\\s\\S]*?)</ol>\\s*</div>`));
    assert.ok(list, `${id}: explanation list missing`);
    const keys = [...list[1].matchAll(/<li data-key="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys, shots[id].callouts.map((c) => c.key), `${id}: list order must match callout numbers`);
    for (const c of shots[id].callouts) {
      for (const value of [c.x, c.y, c.box.x, c.box.y, c.box.w, c.box.h])
        assert.ok(Number.isFinite(value), `${id}/${c.key}: numeric geometry`);
      assert.ok(c.x >= 0 && c.x <= 100 && c.y >= 0 && c.y <= 100, `${id}/${c.key}: callout inside image`);
    }
  }
});

// Popup-owned classes created at runtime by popup scripts are valid selector parts.
const popupScripts = ["src/popup/controllers/paid-model-pricing.js"].map(read).join("\n");
test("every popup callout still maps to an element in popup.html", () => {
  let count = 0;
  for (const [id, shot] of Object.entries(shots)) {
    for (const c of shot.callouts) {
      if (c.scope !== "popup") continue;
      count += 1;
      const ids = [...c.sel.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
      const classes = [...c.sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      const attrs = [...c.sel.matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]);
      assert.ok(ids.length + classes.length + attrs.length > 0, `${id}/${c.key}: selector ${c.sel}`);
      for (const name of ids)
        assert.match(popup, new RegExp(`\\bid="${name}"`), `${id}/${c.key}: #${name} no longer exists in popup.html`);
      for (const name of classes)
        assert.ok(new RegExp(`class="[^"]*\\b${name}\\b`).test(popup) || popupScripts.includes(`"${name}"`),
          `${id}/${c.key}: .${name} no longer exists in the popup`);
      for (const name of attrs)
        assert.match(popup, new RegExp(`\\s${name}[\\s=>]`), `${id}/${c.key}: [${name}] no longer exists in popup.html`);
    }
  }
  assert.ok(count >= 50, `expected the popup callouts, found ${count}`);
});

// The in-popup account view ("Buy credits") is drawn by the shared customer
// portal renderer; each class/attribute in its selectors must still be emitted there.
const ACCOUNT_VIEW = "shared/customer-portal/view.js";
test("account-view callouts still map to the customer portal renderer", () => {
  const source = read(`src/${ACCOUNT_VIEW}`);
  let count = 0;
  for (const [id, shot] of Object.entries(shots)) {
    for (const c of shot.callouts) {
      if (c.scope !== ACCOUNT_VIEW) continue;
      count += 1;
      const names = [...c.sel.matchAll(/[.#]([\w-]+)/g), ...c.sel.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
      assert.ok(names.length > 0, `${id}/${c.key}: selector ${c.sel}`);
      for (const name of names)
        assert.ok(source.includes(name), `${id}/${c.key}: ${name} is no longer rendered by ${ACCOUNT_VIEW}`);
    }
  }
  assert.ok(count >= 15, `expected the Buy credits callouts, found ${count}`);
});

test("on-page callouts still map to the content script that renders them", () => {
  for (const [id, shot] of Object.entries(shots)) {
    for (const c of shot.callouts) {
      if (c.scope === "popup" || c.scope === ACCOUNT_VIEW) continue;
      assert.match(c.scope, /^content\/[\w/-]+\.js$/, `${id}/${c.key}: scope`);
      const source = read(`src/${c.scope}`);
      const token = c.sel.replace(/^[#.]/, "");
      assert.ok(source.includes(token), `${id}/${c.key}: ${c.sel} is no longer rendered by ${c.scope}`);
    }
  }
});

test("the Buy credits section is linked, illustrated and quotes real labels", () => {
  const toc = html.match(/<nav class="toc"[\s\S]*?<\/nav>/)?.[0] || "";
  const tocLinks = [...toc.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tocLinks.includes("buy"), "table of contents links #buy");
  assert.equal(tocLinks.indexOf("buy"), tocLinks.indexOf("paid") + 1, "#buy follows Paid in the contents");
  const section = html.match(/<section id="buy"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, "section#buy exists");
  assert.ok(html.indexOf('<section id="paid"') < html.indexOf('<section id="buy"') &&
    html.indexOf('<section id="buy"') < html.indexOf('<section id="login"'), "#buy sits between Paid and Login");
  assert.match(html, /data-key="buy"><b>“Buy credits”<\/b>[^<]*<a href="#buy">/, "Paid callout links to #buy");
  const figures = [...section.matchAll(/<figure class="shot" data-shot="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(figures, ["buy-packages", "buy-payment", "buy-done"]);
  for (const id of figures) {
    assert.ok(existsSync(path.join(root, guideDir, shots[id].img)), `${id}: image`);
    assert.ok(shots[id].callouts.every((c) => c.scope === ACCOUNT_VIEW), `${id}: account-view callouts`);
  }
  // Sections are numbered 1..n in order and every "หัวข้อ N" link points at section N.
  const numbers = [...html.matchAll(/<section id="([\w-]+)"[^>]*>\s*<h2[^>]*><span class="sec-no">(\d+)<\/span>/g)];
  numbers.forEach(([, , n], i) => assert.equal(Number(n), i + 1, "section numbers are consecutive"));
  const byId = new Map(numbers.map(([, id, n]) => [id, n]));
  for (const [, id, n] of html.matchAll(/<a href="#([\w-]+)">หัวข้อ (\d+)<\/a>/g))
    assert.equal(byId.get(id), n, `link to #${id} says หัวข้อ ${n}`);
  // Every quoted English label is text the extension renders (templates allowed).
  const sources = ["src/shared/customer-portal/view.js", "src/shared/customer-portal/checkout.js", "src/paid/refunds.js", "src/popup/popup.html"].map(read).join("\n");
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const templates = [...sources.matchAll(/'([^'\n]*\{[a-z]+\}[^'\n]*)'/g)]
    .map((m) => new RegExp("^" + escape(m[1]).replace(/\\\{[a-z]+\\\}/g, ".+") + "$"));
  // Shown by Control Center's Stripe return page (api/backend/paid/payments/stripe_routes.py).
  const centerPages = new Set(["Checking your payment", "Payment page closed"]);
  const quoted = [...section.matchAll(/“([^”]*[A-Za-z][^”]*)”/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")));
  assert.ok(quoted.length >= 30, `expected the quoted labels, found ${quoted.length}`);
  for (const label of quoted) {
    if (centerPages.has(label)) continue;
    const pattern = label.replace(/…/g, "");
    const found = sources.includes(pattern) || sources.includes(label) ||
      templates.some((t) => t.test(label.replace(/…/g, "x")));
    assert.ok(found, `“${label}” is not a label the extension renders`);
  }
});

test("quoted error messages are the exact Thai text users see", () => {
  const quoted = [...html.matchAll(/<q data-error="([A-Z0-9_]+)">([\s\S]*?)<\/q>/g)];
  assert.ok(quoted.length >= 12);
  for (const [, code, text] of quoted) {
    assert.equal(decode(text), userMessageForCode(code), `${code}: guide text differs from error-contract.js`);
    assert.match(html, new RegExp(`<code>${code}</code>`), `${code}: code label`);
  }
});

test("the popup has a help button that opens guide/guide.html in a new tab", () => {
  assert.match(popup, /<button type="button" id="open-guide"[^>]*aria-label="[^"]+"/);
  assert.match(popup, /id="open-guide"[^>]*title="[^"]+"/);
  assert.match(read("src/popup/dom.js"), /openGuide:\s*document\.getElementById\("open-guide"\)/);
  const events = read("src/popup/controllers/popup-event-controller.js");
  assert.match(events, /els\.openGuide\?\.addEventListener\("click"[\s\S]{0,160}createTab\(\{ url: chrome\.runtime\.getURL\("guide\/guide\.html"\) \}\)/);
  assert.match(read("src/popup/popup.css"), /\.guide-btn:focus-visible/);
});

test("the guide ships in every build as an extension page, not a web resource", () => {
  assert.match(read("scripts/build.mjs"), /await cp\(sourceRoot, targetRoot, \{ recursive: true \}\)/,
    "build copies all of src/ (including src/guide) into each target");
  for (const name of ["base", "chromium", "firefox", "thunderbird"]) {
    const manifest = JSON.parse(read(`platform/${name}.json`));
    for (const rule of manifest.web_accessible_resources || [])
      for (const resource of rule.resources || [])
        assert.doesNotMatch(resource, /^guide\//, "guide is opened by tabs.create and must not be web-accessible");
  }
  assert.ok(existsSync(path.join(root, "scripts/guide/capture-guide.py")), "screenshot capture script");
});

console.log(`User guide contracts passed: ${checks} checks.`);
