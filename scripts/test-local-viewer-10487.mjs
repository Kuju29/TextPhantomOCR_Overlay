// Local viewer: Select images, Select folder and Auto translate (popup > Tools).
// Pure node: real shared modules + the real popup picker controller driven
// through fake elements, a fake IndexedDB and fake directory/drop entries.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const checks = [];
const pass = (name) => { checks.push(name); };

// ---------------------------------------------------------- fake IndexedDB
const stores = new Map();
const later = (fn) => setTimeout(fn, 0);
globalThis.indexedDB = {
  open() {
    const req = {};
    later(() => {
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => { stores.set(n, new Map()); },
        transaction(name) {
          const tx = {};
          const store = stores.get(name);
          const op = (fn) => { const r = {}; later(() => { r.result = fn(); r.onsuccess?.(); later(() => tx.oncomplete?.()); }); return r; };
          tx.objectStore = () => ({
            put: (rec) => op(() => store.set(rec.id, rec)),
            get: (key) => op(() => store.get(key)),
            delete: (key) => op(() => store.delete(key)),
          });
          return tx;
        },
      };
      req.result = db;
      if (!stores.has("sessions")) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

const gallery = await import("../src/shared/local-gallery.js");
const { createLocalPickerController } = await import("../src/popup/controllers/local-picker-controller.js");

// Chromium types files by extension (case-insensitive) — "._1.jpg" is image/jpeg.
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", txt: "text/plain" };
const file = (name, rel = "") => {
  const ext = name.split(".").pop().toLowerCase();
  const f = new File([new Uint8Array([1, 2, 3])], name, { type: name.startsWith(".DS_") ? "" : MIME[ext] || "" });
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};

// ------------------------------------------------ 1. file filtering + order
{
  const picked = ["10.jpg", "2.png", "1.jpg", "3.WEBP", "4.Avif", "5.bmp", "._1.jpg", ".DS_Store", "notes.txt"].map((n) => file(n));
  const kept = gallery.filterImageFiles(picked).map((f) => f.name);
  assert.deepEqual(kept.sort(), ["1.jpg", "10.jpg", "2.png", "3.WEBP", "4.Avif", "5.bmp"].sort(),
    "Select images keeps every image type (any case) and drops hidden '._' forks, .DS_Store and non-images");
  const ordered = gallery.sortLocalPages(gallery.filterImageFiles(picked).map((f, i) => gallery.toLocalPageRecord(f, i))).map((p) => p.name);
  assert.deepEqual(ordered, ["1.jpg", "2.png", "3.WEBP", "4.Avif", "5.bmp", "10.jpg"], "natural page order");
  assert.deepEqual(gallery.sortLocalPages(["page 10.png", "page 2.png", "Page 1.png"].map((n, i) => gallery.toLocalPageRecord(file(n), i))).map((p) => p.name),
    ["Page 1.png", "page 2.png", "page 10.png"], "natural, case-insensitive order");
  assert.equal(gallery.isImageFile(file("cover.jpg")), true, "Auto translate's single-image test is unchanged");
  const folder = [file("1.jpg", "ch/1.jpg"), file("._1.jpg", "ch/._1.jpg"), file("5.jpg", "ch/sub/5.jpg")];
  assert.deepEqual(gallery.filterImageFiles(folder, { topLevelOnly: true }).map((f) => f.name), ["1.jpg"],
    "folder pick: top level only, hidden fork dropped");
  pass("Select images: types, case, hidden files, natural order");
}

// ----------------------------------- 2. File System Access folder handle
{
  const opened = [];
  const entry = (name) => ({ kind: "file", name, async getFile() { opened.push(name); return file(name); } });
  const dir = { name: "chapter", async *values() {
    for (const n of ["10.jpg", "._10.jpg", ".DS_Store", "2.png", "1.JPG", "notes.txt"]) yield entry(n);
    yield { kind: "directory", name: "nested", async *values() { throw new Error("subfolders must not be opened"); } };
  } };
  const picked = await gallery.pickImagesFromDirectory(async (opts) => { assert.equal(opts.mode, "read"); return dir; });
  assert.deepEqual(picked.files.map((f) => f.name).sort(), ["1.JPG", "10.jpg", "2.png"]);
  assert.deepEqual(opened.sort(), ["1.JPG", "10.jpg", "2.png"], "hidden and non-image entries are never opened");
  assert.equal(picked.skipped, 3);
  assert.equal(picked.subfolders, 1);
  assert.deepEqual(picked.relativePaths.sort(), ["chapter/1.JPG", "chapter/10.jpg", "chapter/2.png"]);
  const cancelled = await gallery.pickImagesFromDirectory(async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await gallery.pickImagesFromDirectory(undefined)).supported, false, "no API (Firefox/Thunderbird) is reported, not thrown");
  pass("Select folder: File System Access handle");
}

// ------------------------------------------------- 3. dropped folder entries
{
  const fe = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
  const folderEntry = { isFile: false, isDirectory: true, name: "ch", createReader() {
    let done = false;
    return { readEntries: (ok) => { ok(done ? [] : [fe("2.png"), fe("._2.png"), fe("1.jpg"), { isFile: false, isDirectory: true, name: "sub" }]); done = true; } };
  } };
  const drop = await gallery.imagesFromDroppedEntries([folderEntry, fe(".hidden.png")]);
  assert.deepEqual(gallery.pagesFromDrop(drop).map((p) => p.name), ["1.jpg", "2.png"]);
  assert.equal(drop.subfolders, 1);
  assert.equal(drop.skipped, 2);
  pass("folder drag-and-drop: hidden files skipped");
}

// ----------------------------------- 4. popup controller, per browser engine
function fakeEls() {
  const target = () => { const l = {}; return { listeners: l, addEventListener: (t, fn) => { l[t] = fn; }, click() { this.clicked = (this.clicked || 0) + 1; }, value: "x" }; };
  return { openLocalImages: target(), openLocalFolder: target(), localImagesInput: target(), localPickerMsg: { textContent: "" } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
async function popup(base, { picker, brave = false } = {}) {
  const els = fakeEls();
  const tabs = [];
  let closed = 0;
  const saved = globalThis.showDirectoryPicker;
  globalThis.showDirectoryPicker = picker;
  globalThis.window = globalThis;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: brave ? { brave: { isBrave: () => true } } : {} });
  createLocalPickerController({ els, createTab: async (t) => tabs.push(t.url), runtimeUrl: (p) => `${base}${p}`,
    closeWindow: () => { closed++; }, randomId: () => "sid-1" }).bind();
  return { els, tabs, closed: () => closed, restore() { globalThis.showDirectoryPicker = saved; if (nav) Object.defineProperty(globalThis, "navigator", nav); } };
}
{
  // Chromium: pickers run inside the popup.
  const p = await popup("chrome-extension://abc/");
  p.els.openLocalImages.listeners.click();
  assert.equal(p.els.localImagesInput.clicked, 1, "Chromium popup opens its own file dialog");
  p.els.localImagesInput.files = [file("10.jpg"), file("2.png"), file("._2.png"), file("a.txt")];
  p.els.localImagesInput.listeners.change();
  await flush(); await flush();
  assert.deepEqual(p.tabs, ["chrome-extension://abc/viewer/viewer.html?sid=sid-1"]);
  assert.equal(p.closed(), 1);
  const session = stores.get("sessions").get("sid-1");
  assert.deepEqual(session.pages.map((pg) => pg.name), ["2.png", "10.jpg"], "saved session holds only real pages, in order");
  assert.equal(session.title, "images");
  p.restore();
  pass("Chromium popup Select images");
}
{
  // Firefox/Thunderbird: the popup would be hidden by the dialog, so both
  // buttons hand over to the Local viewer tab instead of opening a dialog.
  const p = await popup("moz-extension://abc/");
  p.els.openLocalImages.listeners.click();
  p.els.openLocalFolder.listeners.click();
  await flush();
  assert.equal(p.els.localImagesInput.clicked, undefined, "no dialog from a Gecko popup");
  assert.deepEqual(p.tabs, ["moz-extension://abc/viewer/viewer.html?pick=images", "moz-extension://abc/viewer/viewer.html?pick=folder"]);
  p.restore();
  pass("Gecko popup hands the pick to the viewer tab");
}
{
  // Chromium without File System Access: Brave gets the flag hint, others the viewer (drag a folder).
  const brave = await popup("chrome-extension://abc/", { picker: undefined, brave: true });
  brave.els.openLocalFolder.listeners.click();
  await flush();
  assert.match(brave.els.localPickerMsg.textContent, /brave:\/\/flags/);
  assert.deepEqual(brave.tabs, []);
  brave.restore();
  const other = await popup("chrome-extension://abc/", { picker: undefined });
  other.els.openLocalFolder.listeners.click();
  await flush();
  assert.doesNotMatch(other.els.localPickerMsg.textContent, /Brave/);
  assert.deepEqual(other.tabs, ["chrome-extension://abc/viewer/viewer.html?pick=folder"]);
  other.restore();
  pass("no folder picker: Brave hint only in Brave");
}
{
  // Folder via File System Access from the popup.
  const dir = { name: "ch", async *values() { for (const n of ["3.png", "1.png", "._1.png"]) yield { kind: "file", name: n, getFile: async () => file(n) }; } };
  const p = await popup("chrome-extension://abc/", { picker: async () => dir });
  p.els.openLocalFolder.listeners.click();
  await flush(); await flush();
  assert.deepEqual(p.tabs, ["chrome-extension://abc/viewer/viewer.html?sid=sid-1"]);
  const session = stores.get("sessions").get("sid-1");
  assert.deepEqual(session.pages.map((pg) => [pg.name, pg.relativePath]), [["1.png", "ch/1.png"], ["3.png", "ch/3.png"]]);
  assert.equal(session.title, "folder");
  p.restore();
  pass("Chromium popup Select folder");
}

// --------------------------------------------- 5. viewer page wiring (source)
{
  const [html, js, manifest] = await Promise.all([read("src/viewer/viewer.html"), read("src/viewer/viewer.js"), read("platform/base.json")]);
  const scripts = [...html.matchAll(/<script src="\.\.\/([^"]+)"/g)].map((m) => m[1]);
  const confirm = scripts.indexOf("content/credit-confirm.js");
  assert.ok(confirm > 0 && confirm < scripts.indexOf("content/messaging.js"),
    "viewer answers the Paid low-credit question (otherwise right-click translate is cancelled unasked)");
  const order = JSON.parse(manifest).content_scripts[0].js;
  const loaded = scripts.filter((s) => order.includes(s));
  assert.deepEqual(loaded, order.filter((s) => loaded.includes(s)), "viewer loads content scripts in manifest order");
  assert.match(js, /isBraveBrowser\(\) \? BRAVE_FOLDER_HINT : FOLDER_DRAG_HINT/, "no-picker hint depends on the browser");
  assert.match(js, /get\("pick"\) === "folder"/, "an empty viewer opened by the popup explains the next step");
  assert.doesNotMatch(js, /Missing local viewer session/);
  assert.match(html, /id="viewer-images-input" type="file" accept="image\/\*" multiple/);
  pass("viewer page wiring");
}

// ----------------------------------------------- 6. Auto translate (source)
{
  const [popupHtml, events, auto, autoHtml] = await Promise.all([read("src/popup/popup.html"),
    read("src/popup/controllers/popup-event-controller.js"), read("src/auto/auto.js"), read("src/auto/auto.html")]);
  assert.match(popupHtml, /id="open-auto-translate"/);
  assert.match(events, /openAutoTranslate\?\.addEventListener\("click"[\s\S]{0,120}auto\/auto\.html/);
  assert.match(autoHtml, /<input id="auto-file" type="file" accept="image\/\*" hidden \/>/);
  assert.match(auto, /isImageFile\(\{ type: blob\.type, name \}\)/, "Auto translate refuses non-images");
  assert.match(auto, /if \(runId !== state\.runId \|\| !settingsEpochGuard\.accepts\(settingsEpoch\)\)/, "a superseded run is ignored");
  assert.match(auto, /function onTranslated\(detail, kind\) \{\s*if \(!state\.objectUrl \|\| !belongsToCurrentImage\(detail\?\.original\)\) return;/,
    "a late result for a previous image never lands on the current one");
  assert.match(auto, /TP\(\)\?\.resetForNavigation\?\.\("auto_new_image"\);\s*revokeCurrent\(\);/, "the old object URL is revoked");
  pass("Auto translate wiring");
}

console.log(JSON.stringify({ passed: checks.length, checks }));
