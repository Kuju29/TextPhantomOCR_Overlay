const MODES = [
  { id: "lens_images", name: "Google Lens (image)", needLang: true },
  { id: "lens_text",   name: "Google Lens (text)",  needLang: false }
];

const LANGS = [
  { code: "en",    name: "English" },
  { code: "th",    name: "Thai" },
  { code: "ja",    name: "Japanese" },
  { code: "ko",    name: "Korean" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "vi",    name: "Vietnamese" },
  { code: "es",    name: "Spanish" },
  { code: "de",    name: "German" },
  { code: "fr",    name: "French" }
];

const HEALTH_PATH = "/health";
const HEALTH_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [600, 1200, 2500, 5000];

const modeSel  = document.getElementById("mode");
const langSel  = document.getElementById("lang");
const langWrap = document.getElementById("lang-wrap");
const apiInput = document.getElementById("api-url");
const emojiEl  = document.getElementById("api-status-emoji");
const resetBtn = document.getElementById("reset-api");

let userInteractedApi = false;
let lastApiOk = false; 
let lastSavedApiUrl = "";
let retryTimer = null;
const inFlight = {
  seq: 0,
  url: "",
  controller: null
};

function populateControls() {
  MODES.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.id; opt.textContent = m.name; modeSel.appendChild(opt);
  });
  LANGS.forEach(l => {
    const opt = document.createElement("option");
    opt.value = l.code; opt.textContent = l.name; langSel.appendChild(opt);
  });
}

function toggleLangUi(modeId) {
  const mode = MODES.find(m => m.id === modeId);
  langWrap.style.display = mode && mode.needLang ? "" : "none";
}

function normalizeUrl(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    const cleaned = url.replace(/\/+$/, "");
    const u = new URL(cleaned);
    if (u.hostname === "0.0.0.0" || u.hostname === "127.0.0.1") u.hostname = "localhost";
    if (u.hostname === "[::1]") u.hostname = "localhost";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function setEmojiStatus(type, detail) {
  if (!emojiEl) return;
  if (type === "loading") {
    emojiEl.textContent = "⏳"; emojiEl.title = detail || "Checking API...";
  } else if (type === "ok") {
    emojiEl.textContent = "✅"; emojiEl.title = detail || "Online";
  } else if (type === "error") {
    emojiEl.textContent = "❌"; emojiEl.title = detail || "Offline / Not reachable";
  }
}

function abortInFlight() {
  if (inFlight.controller) {
    try { inFlight.controller.abort(); } catch {}
  }
  inFlight.controller = null;
}

function scheduleRetry(url, attemptIndex) {
  clearTimeout(retryTimer);
  if (attemptIndex >= RETRY_DELAYS_MS.length) return;
  const delay = RETRY_DELAYS_MS[attemptIndex];
  retryTimer = setTimeout(() => {
    if (normalizeUrl(apiInput.value) === url) {
      checkHealth(url, attemptIndex);
    }
  }, delay);
}

async function parseHealth(res) {
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return await res.json();
    }
  } catch {}
  try {
    const txt = await res.text();
    return { ok: /\bok\b/i.test(txt), raw: txt };
  } catch {
    return null;
  }
}

async function checkHealthOnce(url, seq) {
  const controller = new AbortController();
  inFlight.controller = controller;
  try {
    const res = await fetch(`${url}${HEALTH_PATH}`, {
      method: "GET",
      headers: { "accept": "application/json, text/plain;q=0.8" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await parseHealth(res);
    return Boolean(data && (data.ok === true || data.ok === "ok" || data.ok === 1));
  } finally {
    if (seq === inFlight.seq) inFlight.controller = null;
  }
}

async function checkHealth(base, attemptIndex = 0) {
  const url = normalizeUrl(base);
  if (!url) return;

  abortInFlight();
  inFlight.seq += 1;
  inFlight.url = url;
  const seq = inFlight.seq;

  setEmojiStatus("loading", attemptIndex ? `Retrying… (${attemptIndex})` : "Checking API...");

  const timeout = setTimeout(() => inFlight.controller?.abort(), HEALTH_TIMEOUT_MS);
  try {
    const healthy = await checkHealthOnce(url, seq);
    if (seq !== inFlight.seq) return;
    lastApiOk = healthy;
    if (healthy) {
      clearTimeout(retryTimer);
      setEmojiStatus("ok", "Online");
    } else {
      setEmojiStatus("error", userInteractedApi ? "Health failed" : "Waiting…");
      scheduleRetry(url, attemptIndex);
    }
  } catch (err) {
    if (seq !== inFlight.seq) return;
    lastApiOk = false;
    const msg = (err && (err.name === "AbortError")) ? "Timed out" : (err?.message || "Offline");
    setEmojiStatus(userInteractedApi ? "error" : "loading", userInteractedApi ? msg : "Waiting…");
    scheduleRetry(url, attemptIndex);
  } finally {
    clearTimeout(timeout);
  }
}

let debounceTimer = null;
function scheduleSaveApi(raw) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const normalized = normalizeUrl(raw);
    if (!normalized) return;

    if (normalized === lastSavedApiUrl) {
      checkHealth(normalized);
      return;
    }

    userInteractedApi = true;
    await chrome.storage.sync.set({ customApiUrl: normalized });
    lastSavedApiUrl = normalized;
    chrome.runtime.sendMessage({ type: "API_URL_CHANGED" });
    checkHealth(normalized);
  }, 800);
}

function handleWsStatus(status) {
  if (lastApiOk) return;
  if (status === "connected") setEmojiStatus("ok", "WS connected");
  else if (status === "connecting") setEmojiStatus("loading", "Connecting…");
  else setEmojiStatus("error", "WS disconnected");
}

async function loadSettings() {
  populateControls();
  const stored = await chrome.storage.sync.get(["mode", "lang", "customApiUrl"]);
  const mode = stored.mode || "lens_images";
  const lang = stored.lang || "en";
  const customApiUrl = stored.customApiUrl || "";

  modeSel.value = mode; langSel.value = lang; toggleLangUi(mode);

  const fallback = "http://localhost:8080";
  const initial = customApiUrl || fallback;
  lastSavedApiUrl = customApiUrl || "";
  apiInput.value = initial;

  if (customApiUrl) {
    userInteractedApi = true;
  }
  setEmojiStatus("loading", "Initializing…");
  await checkHealth(initial);

  chrome.runtime.sendMessage({ type: "GET_API_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) { console.debug(chrome.runtime.lastError.message); return; }
    if (resp && typeof resp.ok === "boolean" && resp.ok) {
      lastApiOk = true; setEmojiStatus("ok", "Online");
    }
  });

  chrome.runtime.sendMessage({ type: "GET_WS_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) { console.debug(chrome.runtime.lastError.message); return; }
    if (typeof resp === "string") handleWsStatus(resp);
  });
}

window.addEventListener("offline", () => { lastApiOk = false; setEmojiStatus("error", "No internet"); });
window.addEventListener("online",  () => { if (apiInput.value) checkHealth(apiInput.value); });

chrome.runtime.onMessage?.addListener((msg) => {
  if (msg.type === "WS_STATUS_UPDATE") {
    handleWsStatus(msg.status);
  } else if (msg.type === "API_STATUS_UPDATE") {
    if (typeof msg.ok === "boolean") {
      lastApiOk = msg.ok;
      if (msg.ok) setEmojiStatus("ok", "Online");
      else setEmojiStatus(userInteractedApi ? "error" : "loading", userInteractedApi ? "API unhealthy" : "Waiting…");
    }
  }
});

modeSel.addEventListener("change", () => {
  chrome.storage.sync.set({ mode: modeSel.value });
  toggleLangUi(modeSel.value);
});

langSel.addEventListener("change", () => {
  chrome.storage.sync.set({ lang: langSel.value });
});

apiInput.addEventListener("input", e => scheduleSaveApi(e.target.value));
apiInput.addEventListener("blur",  e => scheduleSaveApi(e.target.value));

resetBtn.addEventListener("click", () => {
  const def = "http://localhost:8080";
  apiInput.value = def;
  const normalized = normalizeUrl(def);
  chrome.storage.sync.set({ customApiUrl: normalized });
  lastSavedApiUrl = normalized;
  userInteractedApi = false;
  setEmojiStatus("loading", "Reset to local");
  checkHealth(normalized);
  apiInput.focus();
});

loadSettings();
