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

const modeSel     = document.getElementById("mode");
const langSel     = document.getElementById("lang");
const langWrap    = document.getElementById("lang-wrap");
const apiInput    = document.getElementById("api-url");
const emojiEl     = document.getElementById("api-status-emoji");
const resetBtn    = document.getElementById("reset-api");

let userInteractedApi = false;
let lastApiOk = false;

function populateControls() {
  MODES.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    modeSel.appendChild(opt);
  });
  LANGS.forEach(l => {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    langSel.appendChild(opt);
  });
}

function toggleLangUi(modeId) {
  const mode = MODES.find(m => m.id === modeId);
  langWrap.style.display = mode && mode.needLang ? "" : "none";
}

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }
  try {
    const u = new URL(url.replace(/\/+$/, ""));
    if (u.hostname === "0.0.0.0") {
      u.hostname = "localhost";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function setEmojiStatus(type, detail) {
  if (!emojiEl) return;
  if (type === "loading") {
    emojiEl.textContent = "⏳";
    emojiEl.title = detail || "Checking API...";
  } else if (type === "ok") {
    emojiEl.textContent = "✅";
    emojiEl.title = detail || "Online";
  } else if (type === "error") {
    emojiEl.textContent = "❌";
    emojiEl.title = detail || "Offline / Not reachable";
  }
}

async function checkHealth(base) {
  const url = normalizeUrl(base);
  if (!url) return;
  setEmojiStatus("loading", "Checking API...");
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${url}/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (data?.ok) {
      lastApiOk = true;
      setEmojiStatus("ok", `Online (${data.mode})`);
    } else {
      lastApiOk = false;
      if (userInteractedApi) setEmojiStatus("error", "Health failed");
      else setEmojiStatus("loading", "Waiting…");
    }
  } catch {
    lastApiOk = false;
    if (userInteractedApi) setEmojiStatus("error", "Offline");
    else setEmojiStatus("loading", "Waiting…");
  }
}

let debounceTimer = null;
function scheduleSaveApi(raw) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const normalized = normalizeUrl(raw);
    if (!normalized) return;
    userInteractedApi = true;
    await chrome.storage.sync.set({ customApiUrl: normalized });
    checkHealth(normalized);
    chrome.runtime.sendMessage({type:"API_URL_CHANGED"});
  }, 2500);
}

function handleWsStatus(status) {
  if (!lastApiOk) {
    if (status === "connected") {
      setEmojiStatus("ok", "WS connected");
    } else if (status === "connecting") {
      setEmojiStatus("loading", "Connecting…");
    } else {
      setEmojiStatus("error", "WS disconnected");
    }
  }
}

async function loadSettings() {
  populateControls();
  const stored = await chrome.storage.sync.get(["mode", "lang", "customApiUrl"]);
  const mode = stored.mode || "lens_images";
  const lang = stored.lang || "en";
  const customApiUrl = stored.customApiUrl || "";

  modeSel.value = mode;
  langSel.value = lang;
  toggleLangUi(mode);
  apiInput.value = customApiUrl || "http://0.0.0.0:8080";

  if (customApiUrl) {
    userInteractedApi = true;
    await checkHealth(customApiUrl);
  } else {
    setEmojiStatus("loading", "Waiting…");
  }

  chrome.runtime.sendMessage({ type: "GET_API_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      console.debug(chrome.runtime.lastError.message);
      return;
    }
    if (resp && typeof resp.ok === "boolean") {
      if (resp.ok) {
        lastApiOk = true;
        setEmojiStatus("ok", "Online");
      }
    }
  });

  chrome.runtime.sendMessage({ type: "GET_WS_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      console.debug(chrome.runtime.lastError.message);
      return;
    }
    if (typeof resp === "string") {
      handleWsStatus(resp);
    }
  });
}

chrome.runtime.onMessage?.addListener((msg, _sender) => {
  if (msg.type === "WS_STATUS_UPDATE") {
    handleWsStatus(msg.status);
  } else if (msg.type === "API_STATUS_UPDATE") {
    if (typeof msg.ok === "boolean") {
      lastApiOk = msg.ok;
      if (msg.ok) {
        setEmojiStatus("ok", "Online");
      } else if (userInteractedApi) {
        setEmojiStatus("error", "API unhealthy");
      } else {
        setEmojiStatus("loading", "Waiting…");
      }
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
apiInput.addEventListener("blur", e => scheduleSaveApi(e.target.value));

resetBtn.addEventListener("click", () => {
  const def = "http://localhost:8080";
  apiInput.value = def;
  const normalized = normalizeUrl(def);
  chrome.storage.sync.set({ customApiUrl: normalized });
  userInteractedApi = false;
  setEmojiStatus("loading", "Reset to local");
  checkHealth(normalized);
});

loadSettings();
