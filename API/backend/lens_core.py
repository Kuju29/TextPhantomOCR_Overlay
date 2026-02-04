import base64, copy, hashlib, json, math, os, re, struct, time, unicodedata, cv2, httpx, numpy as np, budoux

from urllib.parse import parse_qs, urlencode, urlparse
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

IMAGE_PATH = "33.jpg"
OUT_JSON = "output.json"
LANG = "th"

AI_API_KEY = os.getenv("AI_API_KEY", "").strip()

FIREBASE_URL = "https://cookie-6e1cd-default-rtdb.asia-southeast1.firebasedatabase.app/lens/cookie.json"

WRITE_OUT_JSON = True

DECODE_IMAGEURL_TO_DATAURI = True

DO_ORIGINAL = True
DO_TRANSLATED = True
DO_ORIGINAL_HTML = True
DO_TRANSLATED_HTML = True
DO_AI_HTML = True
HTML_INCLUDE_CSS = True

DRAW_OVERLAY_ORIGINAL = False
DRAW_OVERLAY_TRANSLATED = False
OVERLAY_ORIGINAL_PATH = "overlay_original.png"
OVERLAY_TRANSLATED_PATH = "overlay_translated.png"

TRANSLATED_OVERLAY_FONT_SCALE = 1.0
TRANSLATED_OVERLAY_FIT_TO_BOX = True

AI_OVERLAY_FONT_SCALE = 1.5
AI_OVERLAY_FIT_TO_BOX = True

DO_AI = True
DO_AI_JSON = False
DO_AI_OVERLAY = False
AI_CACHE = False
AI_CACHE_PATH = "ai_cache.json"
AI_PATH_OVERLAY = "overlay_ai.png"
AI_PROVIDER = "auto"
AI_MODEL = "auto"
AI_BASE_URL = "auto"
AI_TEMPERATURE = 0.2

AI_MAX_TOKENS = 1200
AI_TIMEOUT_SEC = 120

DRAW_BOX_OUTLINE = True
AUTO_TEXT_COLOR = True
TEXT_COLOR = (0, 0, 0, 255)
TEXT_COLOR_DARK = (0, 0, 0, 255)
TEXT_COLOR_LIGHT = (255, 255, 255, 255)
BOX_OUTLINE = (0, 255, 0, 255)
BOX_OUTLINE_WIDTH = 2

DRAW_OUTLINE_PARA = False
DRAW_OUTLINE_ITEM = False
DRAW_OUTLINE_SPAN = False
PARA_OUTLINE = (0, 0, 255, 255)
ITEM_OUTLINE = (255, 0, 0, 255)
SPAN_OUTLINE = BOX_OUTLINE
PARA_OUTLINE_WIDTH = 3
ITEM_OUTLINE_WIDTH = 2
SPAN_OUTLINE_WIDTH = BOX_OUTLINE_WIDTH

ERASE_OLD_TEXT_WITH_ORIGINAL_BOXES = True
ERASE_PADDING_PX = 2
ERASE_SAMPLE_MARGIN_PX = 6
ERASE_MODE = "inpaint"
ERASE_MOSAIC_BLOCK_PX = 10
ERASE_CLONE_GAP_PX = 4
ERASE_CLONE_BORDER_PX = 6
ERASE_CLONE_FEATHER_PX = 3

ERASE_BLEND_GAP_PX = 3
ERASE_BLEND_FEATHER_PX = 4

INPAINT_RADIUS = 3
INPAINT_METHOD = "telea"
INPAINT_DILATE_PX = 1

BG_SAMPLE_BORDER_PX = 3

BASELINE_SHIFT = True
BASELINE_SHIFT_FACTOR = 0.40

FONT_DOWNLOD = True
FONT_THAI_PATH = "NotoSansThai-Regular.ttf"
FONT_LATIN_PATH = "NotoSans-Regular.ttf"

FONT_THAI_URLS = [
    "https://github.com/google/fonts/raw/main/ofl/notosansthai/NotoSansThai-Regular.ttf",
    "https://github.com/google/fonts/raw/main/ofl/notosansthaiui/NotoSansThaiUI-Regular.ttf",
]
FONT_LATIN_URLS = [
    "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans-Regular.ttf",
]
FONT_JA_PATH = "NotoSansCJKjp-Regular.otf"
FONT_JA_URLS = [
    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
    "https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
]
FONT_ZH_SC_PATH = "NotoSansCJKsc-Regular.otf"
FONT_ZH_SC_URLS = [
    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
    "https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
]
FONT_ZH_TC_PATH = "NotoSansCJKtc-Regular.otf"
FONT_ZH_TC_URLS = [
    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf",
    "https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf",
]

UI_LANGUAGES = [
    {"code": "en", "name": "English"},
    {"code": "th", "name": "Thai"},
    {"code": "ja", "name": "Japanese"},
    {"code": "ko", "name": "Korean"},
    {"code": "zh-CN", "name": "Chinese (Simplified)"},
    {"code": "vi", "name": "Vietnamese"},
    {"code": "es", "name": "Spanish"},
    {"code": "de", "name": "German"},
    {"code": "fr", "name": "French"},
]

AI_PROVIDER_DEFAULTS = {
    "gemini": {
        "model": "gemini-2.5-flash",
        "base_url": "",
    },
    "openai": {
        "model": "gpt-4o-mini",
        "base_url": "https://api.openai.com/v1",
    },
    "openrouter": {
        "model": "openai/o4-mini",
        "base_url": "https://openrouter.ai/api/v1",
    },
    "huggingface": {
        "model": "google/gemma-2-2b-it",
        "base_url": "https://router.huggingface.co/v1",
    },
    "featherless": {
        "model": "Qwen/Qwen2.5-7B-Instruct",
        "base_url": "https://api.featherless.ai/v1",
    },
    "groq": {
        "model": "openai/gpt-oss-20b",
        "base_url": "https://api.groq.com/openai/v1",
    },
    "together": {
        "model": "openai/gpt-oss-20b",
        "base_url": "https://api.together.xyz/v1",
    },
    "deepseek": {
        "model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
    },
    "anthropic": {
        "model": "claude-sonnet-4-20250514",
        "base_url": "https://api.anthropic.com",
    },
}

AI_PROVIDER_ALIASES = {
    "hf": "huggingface",
    "huggingface_router": "huggingface",
    "hf_router": "huggingface",
    "openai_compat": "openai",
    "openai-compatible": "openai",
    "gemini3": "gemini",
    "gemini-3": "gemini",
    "google": "gemini",
}

AI_MODEL_ALIASES = {
    "gemini": {
        "flash-lite": "gemini-2.5-flash-lite",
        "flash": "gemini-2.5-flash",
        "pro": "gemini-2.5-pro",
        "3-flash": "gemini-3-flash-preview",
        "3-pro": "gemini-3-pro-preview",
        "3-pro-image": "gemini-3-pro-image-preview",
        "flash-image": "gemini-2.5-flash-image",
    }
}

AI_PROMPT_SYSTEM_BASE = ""

AI_LANG_STYLE = {"default": ""}

AI_PROMPT_USER_BY_LANG = {"default": ""}

TP_REMOTE_DEFAULTS_URL = (
    os.environ.get("TP_REMOTE_DEFAULTS_URL")
    or "https://raw.githubusercontent.com/Kuju29/TextPhantomOCR_Overlay/refs/heads/main/defaults_api.json"
).strip()
TP_REMOTE_DEFAULTS_TIMEOUT_SEC = float(os.environ.get("TP_REMOTE_DEFAULTS_TIMEOUT_SEC", "2"))


def _remote_defaults() -> dict:
    url = TP_REMOTE_DEFAULTS_URL
    if not url:
        raise RuntimeError("TP_REMOTE_DEFAULTS_URL is required")

    if url.startswith("file://"):
        with open(url[len("file://"):], "r", encoding="utf-8") as f:
            raw = f.read()
    else:
        with httpx.Client(timeout=TP_REMOTE_DEFAULTS_TIMEOUT_SEC) as client:
            r = client.get(
                url,
                headers={"accept": "application/json"},
                follow_redirects=True,
            )
            r.raise_for_status()
            raw = r.text

    data = json.loads((raw or "").strip() or "{}")
    if not isinstance(data, dict) or not data:
        raise RuntimeError("Remote defaults is empty")
    return data


def _remote_first_str(data: dict, *keys: str) -> str:
    if not data:
        return ""
    for k in keys:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _remote_first_map(data: dict, *keys: str) -> dict:
    if not data:
        return {}
    for k in keys:
        v = data.get(k)
        if isinstance(v, dict) and v:
            return v
    return {}


def ai_prompt_system_base(data: dict | None = None) -> str:
    d = data if isinstance(data, dict) else _remote_defaults()
    v = _remote_first_str(
        d,
        "AI_PROMPT_SYSTEM_BASE",
        "aiPromptSystemBase",
        "promptSystemBase",
        "systemBase",
    )
    if not v:
        raise RuntimeError("Missing AI_PROMPT_SYSTEM_BASE in remote defaults")
    return v


def ai_lang_style_map(data: dict | None = None) -> dict[str, str]:
    d = data if isinstance(data, dict) else _remote_defaults()
    remote = _remote_first_map(d, "AI_LANG_STYLE", "aiLangStyle", "langStyle")
    if not remote:
        raise RuntimeError("Missing AI_LANG_STYLE in remote defaults")
    out: dict[str, str] = {}
    for k, v in remote.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        kk = _normalize_lang(k)
        if not kk:
            continue
        out[kk] = v.strip()
    out.setdefault("default", "")
    return out


def ai_prompt_user_by_lang_map(data: dict | None = None) -> dict[str, str]:
    d = data if isinstance(data, dict) else _remote_defaults()
    remote = _remote_first_map(
        d,
        "AI_PROMPT_USER_BY_LANG",
        "aiPromptUserByLang",
        "promptUserByLang",
    )
    if not remote:
        raise RuntimeError("Missing AI_PROMPT_USER_BY_LANG in remote defaults")
    out: dict[str, str] = {}
    for k, v in remote.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        kk = _normalize_lang(k)
        if not kk:
            continue
        out[kk] = v.strip()
    out.setdefault("default", "")
    return out


AI_PROMPT_RESPONSE_CONTRACT_JSON = (
    "Return ONLY valid JSON (no markdown, no extra text).\n"
    "Output JSON MUST have exactly one key: \"aiTextFull\".\n"
    "\"aiTextFull\" MUST be a single JSON string WITHOUT raw newlines.\n"
    "Use literal \\n and \\n\\n to represent line breaks.\n"
    "You MUST preserve paragraph boundaries and order. Paragraphs are separated by a blank line (\\n\\n).\n"
    "Do NOT add extra paragraphs. Do NOT remove paragraphs.\n"
    "Never include code fences or XML/HTML tags.\n"
    "All string values MUST NOT contain raw newlines."
)

AI_PROMPT_RESPONSE_CONTRACT_TEXT = (
    "Return ONLY the translated text (no JSON, no markdown, no commentary).\n"
    "You MUST preserve paragraph boundaries and order. Paragraphs are separated by a blank line.\n"
    "Use actual newlines for line breaks.\n"
    "Do NOT add extra paragraphs. Do NOT remove paragraphs.\n"
    "Never include code fences or XML/HTML tags."
)
AI_PROMPT_DATA_TEMPLATE = (
    "Input JSON:\n{input_json}\n\n"
    "Output JSON schema (MUST match exactly):\n{output_schema}"
)

AI_PROMPT_DATA_TEMPLATE_TEXT = (
    "Input JSON:\n{input_json}\n\n"
    "Return the translation as plain text only."
)

FIREBASE_COOKIE_TTL_SEC = int(os.getenv("FIREBASE_COOKIE_TTL_SEC", "900"))
_FIREBASE_COOKIE_CACHE = {"ts": 0.0, "url": "", "data": None}
_FONT_RESOLVE_CACHE = {}
_HF_MODELS_CACHE = {}
_FONT_PAIR_CACHE = {}
_TP_HTML_EPS_PX = 0.0
ZWSP = "\u200b"

def ai_prompt_user_default(lang: str, data: dict | None = None) -> str:
    l = _normalize_lang(lang)
    m = ai_prompt_user_by_lang_map(data)
    return (m.get(l) or m.get("default") or "").strip()

def _active_ai_contract() -> str:
    return AI_PROMPT_RESPONSE_CONTRACT_JSON if DO_AI_JSON else AI_PROMPT_RESPONSE_CONTRACT_TEXT

def _active_ai_data_template() -> str:
    return AI_PROMPT_DATA_TEMPLATE if DO_AI_JSON else AI_PROMPT_DATA_TEMPLATE_TEXT

def _canonical_provider(provider: str) -> str:
    p = (provider or "").strip().lower()
    return AI_PROVIDER_ALIASES.get(p, p)

def _resolve_model(provider: str, model: str) -> str:
    m = (model or "").strip()
    if not m or m.lower() == "auto":
        d = AI_PROVIDER_DEFAULTS.get(provider) or {}
        return (d.get("model") or "").strip() or AI_PROVIDER_DEFAULTS["openai"]["model"]
    key = m.lower()
    aliases = AI_MODEL_ALIASES.get(provider) or {}
    return aliases.get(key) or m

def _normalize_lang(lang: str) -> str:
    t = (lang or "").strip().lower()
    if t in ("jp", "jpn", "japanese"):
        return "ja"
    if t in ("thai",):
        return "th"
    if t in ("eng", "english"):
        return "en"
    if t.startswith("zh"):
        return t
    if len(t) >= 2:
        return t[:2]
    return t

def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

def _hf_router_available_models(api_key: str, base_url: str) -> list[str]:
    if not api_key or not base_url:
        return []
    key = _sha1(f"{_sha1(api_key)}|{base_url}")
    now = time.time()
    cached = _HF_MODELS_CACHE.get(key) or {}
    if cached.get("ts") and now - float(cached["ts"]) < 3600 and isinstance(cached.get("models"), list):
        return cached["models"]

    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        with httpx.Client(timeout=float(AI_TIMEOUT_SEC)) as client:
            r = client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []

    models = []
    for m in (data.get("data") or []):
        mid = (m.get("id") if isinstance(m, dict) else None)
        if isinstance(mid, str) and mid.strip():
            models.append(mid.strip())
    _HF_MODELS_CACHE[key] = {"ts": now, "models": models}
    return models

def _pick_hf_fallback_model(models: list[str]) -> str:
    if not models:
        return ""
    priority_substrings = (
        "gemma-3",
        "gemma-2",
        "llama-3.1",
        "llama-3",
        "mistral",
        "qwen",
        "glm",
    )
    lowered = [(m, m.lower()) for m in models]
    for sub in priority_substrings:
        for m, ml in lowered:
            if sub in ml and ("instruct" in ml or ml.endswith("-it") or ":" in ml):
                return m
    for m, ml in lowered:
        if "instruct" in ml or ml.endswith("-it") or ":" in ml:
            return m
    return models[0]

def _load_ai_cache(path: str):
    if not path:
        return {}
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def _save_ai_cache(path: str, cache: dict):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, path)

def _build_ai_prompt_packet(target_lang: str, original_text_full: str, defaults: dict | None = None):
    lang = _normalize_lang(target_lang)
    d = defaults if isinstance(defaults, dict) else _remote_defaults()
    input_json = json.dumps({"target_lang": lang, "originalTextFull": original_text_full}, ensure_ascii=False)
    output_schema = json.dumps({"aiTextFull": "..."}, ensure_ascii=False)
    data_template = _active_ai_data_template()
    if DO_AI_JSON:
        data_text = data_template.format(input_json=input_json, output_schema=output_schema)
    else:
        data_text = data_template.format(input_json=input_json)

    styles = ai_lang_style_map(d)
    style = styles.get(lang) or styles.get("default") or ""
    editable = (ai_prompt_user_default(lang, d) or "").strip()

    system_parts = [ai_prompt_system_base(d)]
    if style:
        system_parts.append(style)
    system_parts.append(_active_ai_contract())
    system_text = "\n\n".join([p for p in system_parts if p])

    user_parts = []
    if editable:
        user_parts.append(editable)
    user_parts.append(data_text)
    return system_text, user_parts


def _gemini_generate_json(api_key: str, model: str, system_text: str, user_parts: list[str]):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    parts = [{"text": p} for p in user_parts if (p or "").strip()]
    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": float(AI_TEMPERATURE),
            "maxOutputTokens": int(AI_MAX_TOKENS),
            "responseMimeType": "text/plain",
        },
    }
    with httpx.Client(timeout=float(AI_TIMEOUT_SEC)) as client:
        r = client.post(url, json=payload)
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise Exception(f"Gemini HTTP {r.status_code}: {r.text}") from e
        data = r.json()
    candidates = data.get("candidates") or []
    if not candidates:
        raise Exception("Gemini returned no candidates")
    c = (candidates[0].get("content") or {})
    out_parts = c.get("parts") or []
    if not out_parts:
        raise Exception("Gemini returned empty content parts")
    txt = "".join([str(p.get("text") or "") for p in out_parts]).strip()
    if not txt:
        raise Exception("Gemini returned empty text")
    return txt


def _read_first_env(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return ""

def _detect_ai_provider_from_key(api_key: str) -> str:
    k = (api_key or "").strip()
    if k.startswith("AIza"):
        return "gemini"
    if k.startswith("hf_"):
        return "huggingface"
    if k.startswith("sk-or-"):
        return "openrouter"
    if k.startswith("sk-ant-"):
        return "anthropic"
    if k.startswith("gsk_"):
        return "groq"
    return "openai"

def _resolve_ai_config():
    api_key = (AI_API_KEY or _read_first_env(
        "AI_API_KEY",
        "OPENAI_API_KEY",
        "HF_TOKEN",
        "HUGGINGFACEHUB_API_TOKEN",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "FEATHERLESS_API_KEY",
        "GROQ_API_KEY",
        "TOGETHER_API_KEY",
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
    )).strip()

    provider = _canonical_provider((AI_PROVIDER or "auto"))
    model = (AI_MODEL or "auto").strip()
    base_url = (AI_BASE_URL or "auto").strip()

    if provider in ("", "auto"):
        provider = _canonical_provider(_detect_ai_provider_from_key(api_key))

    preset = AI_PROVIDER_DEFAULTS.get(provider) or {}

    model = _resolve_model(provider, model)

    if base_url in ("", "auto"):
        base_url = (preset.get("base_url") or "").strip()

    if provider not in ("gemini", "anthropic"):
        if not base_url:
            base_url = (AI_PROVIDER_DEFAULTS.get("openai") or {}).get(
                "base_url") or "https://api.openai.com/v1"

    return provider, api_key, model, base_url

def _openai_compat_generate_json(api_key: str, base_url: str, model: str, system_text: str, user_parts: list[str]):
    url = (base_url.rstrip("/") + "/chat/completions")

    def _user_only_prompt_for_model(m: str) -> bool:
        ml = (m or "").strip().lower()
        if not ml:
            return False
        if "gemma-3" in ml or "gemma-2" in ml:
            return True
        if "gemma" in ml and ("-it" in ml or "instruct" in ml):
            return True
        return False

    def _build_messages(m: str):
        parts = [p.strip() for p in (user_parts or []) if isinstance(p, str) and p.strip()]
        sys = (system_text or "").strip()
        if _user_only_prompt_for_model(m):
            combined = "\n\n".join([x for x in ([sys] + parts) if x])
            return [{"role": "user", "content": combined}]
        msgs = [{"role": "system", "content": system_text}]
        for p in parts:
            msgs.append({"role": "user", "content": p})
        return msgs

    messages = _build_messages(model)
    payload = {
        "model": model,
        "messages": messages,
        "temperature": float(AI_TEMPERATURE),
        "max_tokens": int(AI_MAX_TOKENS),
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    used_model = model
    with httpx.Client(timeout=float(AI_TIMEOUT_SEC)) as client:
        r = client.post(url, json=payload, headers=headers)
        try:
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPStatusError as e:
            if (
                r.status_code == 400
                and "router.huggingface.co" in (base_url or "")
                and ((AI_MODEL or "").strip().lower() in ("", "auto") or model == (AI_PROVIDER_DEFAULTS.get("huggingface") or {}).get("model"))
            ):
                try:
                    err = r.json().get("error") or {}
                except Exception:
                    err = {}
                if (err.get("code") or "") == "model_not_supported":
                    models = _hf_router_available_models(api_key, base_url)
                    fallback = _pick_hf_fallback_model(models)
                    if fallback and fallback != model:
                        payload["model"] = fallback
                        payload["messages"] = _build_messages(fallback)
                        used_model = fallback
                        r2 = client.post(url, json=payload, headers=headers)
                        try:
                            r2.raise_for_status()
                        except httpx.HTTPStatusError as e2:
                            raise Exception(
                                f"AI HTTP {r2.status_code}: {r2.text}") from e2
                        data = r2.json()
                    else:
                        preview = ", ".join(models[:8])
                        hint = f"\nAvailable models (first 8): {preview}" if preview else ""
                        raise Exception(
                            f"AI HTTP {r.status_code}: {r.text}{hint}") from e
                else:
                    raise Exception(
                        f"AI HTTP {r.status_code}: {r.text}") from e
            else:
                raise Exception(f"AI HTTP {r.status_code}: {r.text}") from e
    choices = data.get("choices") or []
    if not choices:
        raise Exception("AI returned no choices")
    msg = (choices[0].get("message") or {})
    txt = (msg.get("content") or "").strip()
    if not txt:
        raise Exception("AI returned empty text")
    return txt, used_model

def _anthropic_generate_json(api_key: str, model: str, system_text: str, user_parts: list[str]):
    url = "https://api.anthropic.com/v1/messages"
    messages = []
    for p in user_parts:
        if (p or "").strip():
            messages.append({"role": "user", "content": p})
    payload = {
        "model": model,
        "max_tokens": int(AI_MAX_TOKENS),
        "temperature": float(AI_TEMPERATURE),
        "system": system_text,
        "messages": messages,
    }
    headers = {
        "x-api-key": api_key,
        "content-type": "application/json",
    }
    with httpx.Client(timeout=float(AI_TIMEOUT_SEC)) as client:
        r = client.post(url, json=payload, headers=headers)
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise Exception(f"Anthropic HTTP {r.status_code}: {r.text}") from e
        data = r.json()
    content = data.get("content") or []
    txt = "".join([(c.get("text") or "") for c in content if isinstance(
        c, dict) and c.get("type") == "text"]).strip()
    if not txt:
        raise Exception("Anthropic returned empty text")
    return txt

def _strip_wrappers(s: str) -> str:
    t = (s or "").strip()
    if not t:
        return ""
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    if "```" in t:
        t = re.sub(r"```[a-zA-Z0-9_-]*", "", t)
        t = t.replace("```", "")
    t = re.sub(r"</?AiTextFull>", "", t, flags=re.IGNORECASE).strip()
    return t

def _sanitize_json_like_text(raw: str) -> str:
    t = _strip_wrappers(raw)
    if not t:
        return ""
    out = []
    in_str = False
    esc = False
    run_ch = ""
    run_len = 0

    def _flush_run():
        nonlocal run_ch, run_len
        if run_len:
            out.append(run_ch * min(run_len, 3))
        run_ch = ""
        run_len = 0

    for ch in t:
        if in_str:
            if esc:
                _flush_run()
                out.append(ch)
                esc = False
                continue
            if ch == "\\":
                _flush_run()
                out.append(ch)
                esc = True
                continue
            if ch == '"':
                _flush_run()
                out.append(ch)
                in_str = False
                continue
            if ch == "\n":
                _flush_run()
                out.append("\\n")
                continue
            if ch == "\t":
                _flush_run()
                out.append("\\t")
                continue
            if ch == run_ch:
                run_len += 1
                continue
            _flush_run()
            run_ch = ch
            run_len = 1
            continue

        _flush_run()
        if ch == '"':
            out.append(ch)
            in_str = True
            esc = False
            continue
        out.append(ch)

    _flush_run()
    return "".join(out)

def _extract_first_json(raw: str):
    t = _sanitize_json_like_text(raw)
    if not t:
        raise Exception("AI returned empty text")
    start = t.find("{")
    if start < 0:
        raise Exception("AI returned no JSON object")

    in_str = False
    esc = False
    depth = 0
    json_start = None

    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                json_start = i
            depth += 1
            continue
        if ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and json_start is not None:
                    cand = t[json_start: i + 1]
                    return json.loads(cand)

    raise Exception("Failed to parse AI JSON")

def _parse_ai_textfull_only(raw: str) -> str:
    obj = _extract_first_json(raw)
    if not isinstance(obj, dict):
        raise Exception("AI JSON is not an object")
    txt = obj.get("aiTextFull")
    if txt is None:
        txt = obj.get("textFull")
    if txt is None:
        raise Exception("AI JSON missing aiTextFull")
    t = str(txt)
    if "\\n" in t and "\n" not in t:
        t = t.replace("\\n", "\n")
    t = t.replace("\r\n", "\n").replace("\r", "\n").strip()
    return t

def _parse_ai_textfull_text_only(raw: str) -> str:
    t = _strip_wrappers(raw)
    if not t:
        raise Exception("AI returned empty text")
    if t.lstrip().startswith("{"):
        return _parse_ai_textfull_only(t)
    if "\\n" in t and "\n" not in t:
        t = t.replace("\\n", "\n")
    t = re.sub(r"^aiTextFull\s*[:=]\s*", "", t, flags=re.IGNORECASE).strip()
    return t

def _budoux_parser_for_lang(lang: str):
    lang = _normalize_lang(lang)
    if not budoux:
        return None
    if lang == "th":
        return budoux.load_default_thai_parser()
    if lang == "ja":
        return budoux.load_default_japanese_parser()
    if lang in ("zh", "zh-hans", "zh_cn", "zh-cn", "zh_hans"):
        return budoux.load_default_simplified_chinese_parser()
    if lang in ("zh-hant", "zh_tw", "zh-tw", "zh_hant"):
        return budoux.load_default_traditional_chinese_parser()
    model_path = os.environ.get("BUDOUX_MODEL_PATH")
    if not model_path:
        return None
    with open(model_path, "r", encoding="utf-8") as f:
        model = json.load(f)
    return budoux.Parser(model)

def _ensure_box_fields(box: dict):
    if not isinstance(box, dict):
        return {}
    b = copy.deepcopy(box)
    if "rotation_deg" not in b:
        b["rotation_deg"] = 0.0
    if "rotation_deg_css" not in b:
        b["rotation_deg_css"] = 0.0
    if "center" not in b and all(k in b for k in ("left", "top", "width", "height")):
        b["center"] = {"x": b["left"] + b["width"] /
                       2.0, "y": b["top"] + b["height"]/2.0}
    if all(k in b for k in ("left", "top", "width", "height")):
        if "left_pct" not in b:
            b["left_pct"] = b["left"] * 100.0
        if "top_pct" not in b:
            b["top_pct"] = b["top"] * 100.0
        if "width_pct" not in b:
            b["width_pct"] = b["width"] * 100.0
        if "height_pct" not in b:
            b["height_pct"] = b["height"] * 100.0
    return b

def _tokens_with_spaces(text: str, parser, lang: str):
    t = (text or "")
    if not t:
        return []
    out = []
    parts = re.findall(r"\s+|\S+", t)
    for part in parts:
        if not part:
            continue
        if part.isspace():
            out.append(("space", part))
            continue
        segs = parser.parse(part) if parser else [part]
        for seg in segs:
            if seg:
                out.append(("word", seg))
    return out

def _line_cap_px_for_item(item: dict, img_w: int, img_h: int) -> float:
    p1 = item.get("baseline_p1") or {}
    p2 = item.get("baseline_p2") or {}
    dx = (float(p2.get("x") or 0.0) - float(p1.get("x") or 0.0)) * float(img_w)
    dy = (float(p2.get("y") or 0.0) - float(p1.get("y") or 0.0)) * float(img_h)
    cap = float(math.hypot(dx, dy))
    if cap > 1e-6:
        return cap
    b = _ensure_box_fields(item.get("box") or {})
    return float(b.get("width") or 0.0) * float(img_w)

def _wrap_tokens_to_lines_px(tokens, items, img_w: int, img_h: int, thai_font: str, latin_font: str, font_size: int, min_lines: int):
    max_lines = len(items)
    if max_lines <= 0:
        return []

    caps = [_line_cap_px_for_item(it, img_w, img_h) for it in items]
    desired = max(1, min(int(min_lines), max_lines))
    soft_factor = 0.90 if desired > 1 else 1.0

    lines = [[]]
    cur_w = 0.0
    li = 0

    last_word_hint = ""
    pending_space = ""

    tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    dtmp = ImageDraw.Draw(tmp)

    def _measure_w(font, txt: str) -> float:
        try:
            return float(font.getlength(txt))
        except Exception:
            try:
                bb = dtmp.textbbox((0, 0), txt, font=font, anchor="ls")
                return float(bb[2] - bb[0])
            except Exception:
                w, _ = dtmp.textsize(txt, font=font)
                return float(w)

    def _cap_for_line(idx: int) -> float:
        return float(caps[min(idx, max_lines - 1)])

    for k, s in (tokens or []):
        if k == "space":
            if not lines[-1]:
                continue
            pending_space += str(s)
            continue

        if k != "word":
            continue

        txt = str(s)
        if not txt:
            continue

        font = pick_font(txt, thai_font, latin_font, int(font_size))
        w = _measure_w(font, txt)

        sw = 0.0
        if pending_space:
            hint = last_word_hint or txt
            font_s = pick_font(hint, thai_font, latin_font, int(font_size))
            sw = _measure_w(font_s, pending_space)

        cap = _cap_for_line(li)
        soft_cap = cap * soft_factor if (li < desired and cap > 0.0) else cap

        need_w = cur_w + sw + w
        if lines[-1] and li < max_lines - 1:
            if cap > 0.0 and need_w > cap:
                lines.append([])
                li += 1
                cur_w = 0.0
                pending_space = ""
                sw = 0.0
            elif soft_cap > 0.0 and need_w > soft_cap:
                lines.append([])
                li += 1
                cur_w = 0.0
                pending_space = ""
                sw = 0.0

        if pending_space and lines[-1]:
            lines[-1].append(("space", pending_space, sw))
            cur_w += sw
            pending_space = ""

        lines[-1].append(("word", txt, w))
        cur_w += w
        last_word_hint = txt

    if len(lines) > max_lines:
        head = lines[: max_lines - 1]
        tail = []
        for seg in lines[max_lines - 1:]:
            tail.extend(seg)
        lines = head + [tail]

    for i in range(len(lines)):
        while lines[i] and lines[i][0][0] == "space":
            lines[i] = lines[i][1:]
        while lines[i] and lines[i][-1][0] == "space":
            lines[i] = lines[i][:-1]

    return lines

def _ensure_min_lines_by_split(lines, min_lines: int, max_lines: int):
    if not lines:
        return []
    min_lines = int(min_lines)
    max_lines = int(max_lines)
    if min_lines <= 1:
        return lines

    target = min(min_lines, max_lines)
    lines = [list(seg) for seg in (lines or [])]

    def _trim(seg):
        while seg and seg[0][0] == "space":
            seg.pop(0)
        while seg and seg[-1][0] == "space":
            seg.pop()
        return seg

    while len(lines) < target:
        idx = None
        best = 0
        for i, seg in enumerate(lines):
            n_words = sum(1 for k, s, _ in seg if k == "word" and s != ZWSP)
            if n_words > best and n_words > 1:
                best = n_words
                idx = i
        if idx is None:
            break

        seg = lines[idx]
        word_pos = [i for i, (k, s, _) in enumerate(seg)
                    if k == "word" and s != ZWSP]
        if len(word_pos) <= 1:
            break
        cut_word = len(word_pos) // 2
        cut_pos = word_pos[cut_word]

        left = _trim(seg[:cut_pos])
        right = _trim(seg[cut_pos:])

        lines[idx] = left
        lines.insert(idx + 1, right)
        if len(lines) >= max_lines:
            break

    return lines

def _fit_para_size_and_lines(ptext: str, parser, items, img_w: int, img_h: int, thai_font: str, latin_font: str, base_size: int, min_lines: int, lang: str):
    tokens2 = _tokens_with_spaces(ptext, parser, lang)
    if not tokens2 or not items:
        return int(base_size), [[] for _ in range(len(items))]

    max_lines = len(items)
    n_words = 0
    for k, s in tokens2:
        if k == "word" and str(s):
            n_words += 1
    desired_lines = max(1, min(max_lines, n_words))
    size = max(10, int(base_size))

    heights = []
    for it in items:
        b = _ensure_box_fields(it.get("box") or {})
        heights.append(float(b.get("height") or 0.0) * float(img_h))

    while size >= 10:
        lines = _wrap_tokens_to_lines_px(
            tokens2, items, img_w, img_h, thai_font, latin_font, size, min_lines=desired_lines)
        lines = _ensure_min_lines_by_split(
            lines, min_lines=desired_lines, max_lines=max_lines)

        if len(lines) <= max_lines:
            ok = True
            for ii, seg in enumerate(lines):
                words = [s for k, s, _ in seg if k == "word" and s != ZWSP]
                if not words:
                    continue
                line_text = "".join(words)
                mline = _line_metrics_px(
                    line_text, thai_font, latin_font, size)
                if mline is None:
                    continue
                _, th, _ = mline
                if ii < len(heights) and heights[ii] > 0.0 and th > heights[ii] * 1.01:
                    ok = False
                    break
            if ok:
                return size, lines

        size -= 1

    lines10 = _wrap_tokens_to_lines_px(
        tokens2, items, img_w, img_h, thai_font, latin_font, 10, min_lines=desired_lines)
    lines10 = _ensure_min_lines_by_split(
        lines10, min_lines=desired_lines, max_lines=max_lines)
    return 10, lines10

def _pad_lines(lines, max_lines: int):
    max_lines = int(max_lines)
    if max_lines <= 0:
        return []
    lines = list(lines or [])
    if len(lines) > max_lines:
        return lines[:max_lines]
    if len(lines) < max_lines:
        lines.extend([[] for _ in range(max_lines - len(lines))])
    return lines

def _contains_thai(text: str) -> bool:
    for ch in (text or ""):
        if _is_thai_char(ch):
            return True
    return False

def _apply_line_to_item(
    item: dict,
    line_tokens,
    para_index: int,
    item_index: int,
    abs_line_start_raw: int,
    W: int,
    H: int,
    thai_path: str,
    latin_path: str,
    forced_size_px: int | None,
    apply_baseline_shift: bool = True,
    kerning_adjust: bool = False,
):
    tokens = []
    for t in (line_tokens or []):
        if not isinstance(t, (list, tuple)) or len(t) < 2:
            continue
        k = str(t[0])
        s = str(t[1])
        w = float(t[2]) if len(t) > 2 and isinstance(
            t[2], (int, float)) else 0.0
        tokens.append((k, s, w))

    words = [s for k, s, _ in tokens if k == "word" and s != ZWSP]
    item_text = "".join(s for _, s, _ in tokens if s != ZWSP).strip()
    item["text"] = item_text
    item["valid_text"] = bool(item_text)

    b = _ensure_box_fields(item.get("box") or {})
    item["box"] = b
    base_left = float(b.get("left") or 0.0)
    base_top = float(b.get("top") or 0.0)
    base_w = float(b.get("width") or 0.0)
    base_h = float(b.get("height") or 0.0)

    if not words or base_w <= 0.0 or base_h <= 0.0 or W <= 0 or H <= 0:
        item["spans"] = []
        return

    p1 = item.get("baseline_p1") or {}
    p2 = item.get("baseline_p2") or {}
    x1 = float(p1.get("x") or 0.0) * float(W)
    y1 = float(p1.get("y") or 0.0) * float(H)
    x2 = float(p2.get("x") or 0.0) * float(W)
    y2 = float(p2.get("y") or 0.0) * float(H)

    dx = x2 - x1
    dy = y2 - y1
    L = float(math.hypot(dx, dy))
    if L <= 1e-9:
        item["spans"] = []
        return

    ux = dx / L
    uy = dy / L
    nx = -uy
    ny = ux
    if ny < 0:
        nx, ny = -nx, -ny

    base_w_px = L
    base_h_px = base_h * float(H)

    base_size = 96

    widths_px = []
    max_ascent = 0
    max_descent = 0

    layout_units = []
    for k, s, _ in tokens:
        if s == ZWSP:
            continue
        if k == "space":
            layout_units.append(("space", _sanitize_draw_text(s)))
        elif k == "word":
            layout_units.append(("word", _sanitize_draw_text(s)))

    def _measure_len_px(font, text: str) -> float:
        try:
            return float(font.getlength(text))
        except Exception:
            tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
            dtmp = ImageDraw.Draw(tmp)
            try:
                bb = dtmp.textbbox((0, 0), text, font=font, anchor="ls")
                return float(bb[2] - bb[0])
            except Exception:
                w, _ = dtmp.textsize(text, font=font)
                return float(w)

    for i, (k, t) in enumerate(layout_units):
        if k == "space":
            hint = ""
            for j in range(i - 1, -1, -1):
                if layout_units[j][0] == "word":
                    hint = layout_units[j][1]
                    break
            if not hint:
                for j in range(i + 1, len(layout_units)):
                    if layout_units[j][0] == "word":
                        hint = layout_units[j][1]
                        break
            font0 = pick_font(hint or "a", thai_path, latin_path, base_size)
            widths_px.append(max(0.0, _measure_len_px(font0, t)))
            continue

        font0 = pick_font(t, thai_path, latin_path, base_size)
        try:
            ascent, descent = font0.getmetrics()
        except Exception:
            ascent, descent = base_size, int(base_size * 0.25)
        if ascent > max_ascent:
            max_ascent = ascent
        if descent > max_descent:
            max_descent = descent

        if kerning_adjust and (i + 1) < len(layout_units) and layout_units[i + 1][0] == "word":
            nxt = layout_units[i + 1][1]
            nxt1 = nxt[:1] if nxt else ""
            if nxt1 and (_contains_thai(t) == _contains_thai(nxt1)):
                tw = _measure_len_px(font0, t + nxt1) - \
                    _measure_len_px(font0, nxt1)
            else:
                tw = _measure_len_px(font0, t)
        else:
            tw = _measure_len_px(font0, t)

        widths_px.append(max(0.0, tw))

    line_tw = sum(widths_px)
    bo_base = _baseline_offset_px_for_text(
        item_text, thai_path, latin_path, base_size)
    if bo_base is not None:
        _, total_h_base = bo_base
        line_th = float(total_h_base)
    else:
        line_th = float(max_ascent + max_descent)

    if line_tw <= 1e-9 or line_th <= 1e-9:
        item["spans"] = []
        return

    if forced_size_px is None:
        scale_line = min((base_w_px * 1.0) / line_tw,
                         (base_h_px * 0.995) / line_th)
        if scale_line <= 0.0:
            item["spans"] = []
            return
        final_size = max(10, int(base_size * scale_line))
    else:
        final_size = int(max(10, forced_size_px))
        scale_line = float(final_size) / float(base_size)

    item["font_size_px"] = final_size

    w_scaled = [w * scale_line for w in widths_px]
    total_scaled = sum(w_scaled)
    margin_px = (base_w_px - total_scaled) / \
        2.0 if total_scaled < base_w_px else 0.0

    bo = _baseline_offset_px_for_text(
        item_text, thai_path, latin_path, final_size)
    if apply_baseline_shift and bo is not None:
        baseline_offset_px, _ = bo
        cx = (base_left + (base_w / 2.0)) * float(W)
        cy = (base_top + (base_h / 2.0)) * float(H)
        target = (cx + (baseline_offset_px * nx),
                  cy + (baseline_offset_px * ny))
        s = ((target[0] - x1) * nx) + ((target[1] - y1) * ny)
        x1 += nx * s
        y1 += ny * s
        x2 += nx * s
        y2 += ny * s

        item["baseline_p1"] = {"x": x1 / float(W), "y": y1 / float(H)}
        item["baseline_p2"] = {"x": x2 / float(W), "y": y2 / float(H)}

    raw_pos = 0
    span_i = 0
    unit_i = 0
    cum_px = 0.0
    spans = []

    for kind, s, _ in tokens:
        if s == ZWSP:
            continue

        start_raw = abs_line_start_raw + raw_pos
        raw_pos += len(s)
        end_raw = abs_line_start_raw + raw_pos

        if unit_i >= len(w_scaled):
            break

        wpx = w_scaled[unit_i]
        t0 = (margin_px + cum_px) / base_w_px
        cum_px += wpx
        t1 = (margin_px + cum_px) / base_w_px

        if kind == "space":
            unit_i += 1
            continue

        span_box = _ensure_box_fields({
            "left": base_left + (base_w * t0),
            "top": base_top,
            "width": base_w * (t1 - t0),
            "height": base_h,
            "rotation_deg": float(b.get("rotation_deg") or 0.0),
            "rotation_deg_css": float(b.get("rotation_deg_css") or 0.0),
        })

        spans.append({
            "side": "Ai",
            "para_index": para_index,
            "item_index": item_index,
            "span_index": span_i,
            "text": s,
            "valid_text": True,
            "start_raw": start_raw,
            "end_raw": end_raw,
            "t0_raw": t0,
            "t1_raw": t1,
            "box": span_box,
            "height_raw": item.get("height_raw"),
            "baseline_p1": item.get("baseline_p1"),
            "baseline_p2": item.get("baseline_p2"),
            "font_size_px": final_size,
        })
        span_i += 1
        unit_i += 1
    item["spans"] = spans

def patch(payload: dict, img_w: int, img_h: int, thai_font: str, latin_font: str, lang: str | None = None) -> dict:
    ai = payload.get("Ai") or {}
    ai_text_full = str(ai.get("aiTextFull") or "")
    template_tree = ai.get("aiTree") or {}
    if not isinstance(template_tree, dict):
        raise ValueError("Ai.aiTree template must be a dict")
    lang_norm = _normalize_lang(lang or LANG)
    parser = _budoux_parser_for_lang(lang_norm)

    out_tree = copy.deepcopy(template_tree)
    out_tree["side"] = "Ai"
    paragraphs = out_tree.get("paragraphs") or []

    ai_text_full_clean = ai_text_full

    def _extract_paras_by_markers(txt: str, expected: int) -> tuple[list[str], str, int] | None:
        if not txt or expected <= 0 or "<<TP_P" not in txt:
            return None
        matches = list(re.finditer(r"<<TP_P(\d+)>>", txt))
        if not matches:
            return None
        out: list[str] = [""] * expected
        for mi, m in enumerate(matches):
            try:
                idx = int(m.group(1))
            except Exception:
                continue
            seg_start = m.end()
            seg_end = matches[mi + 1].start() if (mi +
                                                  1) < len(matches) else len(txt)
            seg = (txt[seg_start:seg_end] or "").lstrip("\r\n").strip()
            if 0 <= idx < expected and not out[idx]:
                out[idx] = seg
        clean = "\n\n".join(out)
        return out, clean, len(matches)

    marked = _extract_paras_by_markers(ai_text_full, len(paragraphs))
    if marked is not None:
        ai_paras, ai_text_full_clean, _marker_count = marked
    else:
        ai_paras = ai_text_full.split("\n\n") if ai_text_full else []
        if len(ai_paras) < len(paragraphs):
            ai_paras = ai_paras + [""] * (len(paragraphs) - len(ai_paras))
        if len(ai_paras) > len(paragraphs):
            ai_paras = ai_paras[:len(paragraphs)]
        ai_text_full_clean = "\n\n".join(ai_paras)

    raw_cursor = 0
    for pi, (p, ptext) in enumerate(zip(paragraphs, ai_paras)):
        p["side"] = "Ai"
        p["para_index"] = int(p.get("para_index", pi))
        items = p.get("items") or []
        max_lines = len(items)
        if max_lines <= 0:
            continue

        base_size_ref = None
        if isinstance(p.get("para_font_size_px"), int) and int(p.get("para_font_size_px")) > 0:
            base_size_ref = int(p.get("para_font_size_px"))
        else:
            ref_sizes = []
            for it in items:
                fs = it.get("font_size_px")
                if isinstance(fs, int) and fs > 0:
                    ref_sizes.append(fs)
            if ref_sizes:
                base_size_ref = min(ref_sizes)

        base_size = int(base_size_ref or 96)
        min_lines = int(max_lines)

        para_size, lines = _fit_para_size_and_lines(
            ptext,
            parser,
            items,
            img_w,
            img_h,
            thai_font,
            latin_font,
            base_size,
            min_lines=min_lines,
            lang=lang_norm,
        )
        lines = _pad_lines(lines, max_lines)
        p["para_font_size_px"] = int(para_size)

        p["text"] = ptext
        p["valid_text"] = bool(ptext)
        p["start_raw"] = raw_cursor
        p["end_raw"] = raw_cursor + len(ptext)

        line_start = raw_cursor
        for ii in range(max_lines):
            it = items[ii]
            it["side"] = "Ai"
            it["para_index"] = pi
            it["item_index"] = ii
            _apply_line_to_item(
                it,
                (lines[ii] if ii < len(lines) else []),
                pi,
                ii,
                line_start,
                img_w,
                img_h,
                thai_font,
                latin_font,
                para_size,
                apply_baseline_shift=True,
                kerning_adjust=True,
            )
            line_raw_len = sum(len(s) for k, s, w in (
                lines[ii] if ii < len(lines) else []) if s != ZWSP)
            line_start += line_raw_len
        raw_cursor = p["end_raw"] + 2

    return {"Ai": {"aiTextFull": ai_text_full_clean, "aiTree": out_tree}}

def _uniformize_ai_item_span_font_size(item: dict, img_w: int, img_h: int, thai_font: str, latin_font: str):
    spans = item.get("spans") or []
    if not spans or img_w <= 0 or img_h <= 0:
        return

    base_size = item.get("font_size_px")
    try:
        base_size = int(base_size) if base_size is not None else None
    except Exception:
        base_size = None

    if not base_size:
        for sp in spans:
            fs = sp.get("font_size_px") if isinstance(sp, dict) else None
            if isinstance(fs, int) and fs > 0:
                base_size = fs
                break

    if not base_size or base_size <= 0:
        return

    tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    dtmp = ImageDraw.Draw(tmp)
    font_cache = {}

    def _font_for(text: str, size: int):
        key = (int(size), 1 if _contains_thai(text) else 0)
        f = font_cache.get(key)
        if f:
            return f
        f = pick_font(text, thai_font, latin_font, int(size))
        font_cache[key] = f
        return f

    min_size = int(base_size)

    for sp in spans:
        if not isinstance(sp, dict):
            continue
        txt = _sanitize_draw_text(sp.get("text") or "")
        if txt.strip() == "":
            continue

        b = sp.get("box") or {}
        aw = float(b.get("width") or 0.0) * float(img_w)
        ah = float(b.get("height") or 0.0) * float(img_h)
        if aw <= 0.0 or ah <= 0.0:
            continue

        font = _font_for(txt, base_size)
        try:
            bb = dtmp.textbbox((0, 0), txt, font=font, anchor="ls")
            tw = float(bb[2] - bb[0])
            th = float(bb[3] - bb[1])
        except Exception:
            tw, th = dtmp.textsize(txt, font=font)
            tw = float(tw)
            th = float(th)

        if tw <= 0.0 or th <= 0.0:
            continue

        s = min((aw * 0.995) / tw, (ah * 0.995) / th)
        if s < 1.0:
            req = max(10, int(base_size * s))
            if req < min_size:
                min_size = req

    if min_size != base_size:
        item["font_size_px"] = int(min_size)
        for sp in spans:
            if isinstance(sp, dict):
                sp["font_size_px"] = int(min_size)

def _rebuild_ai_spans_after_font_resize(ai_tree: dict, img_w: int, img_h: int, thai_font: str, latin_font: str, lang: str | None = None):
    if not ai_tree or img_w <= 0 or img_h <= 0:
        return
    lang_norm = _normalize_lang(lang or LANG)
    parser = _budoux_parser_for_lang(lang_norm)
    for pi, p in _iter_paragraphs(ai_tree):
        items = p.get("items") or []
        for ii, it in enumerate(items):
            txt = _item_line_text(it)
            if not str(txt).strip():
                it["spans"] = []
                continue
            tokens = _tokens_with_spaces(str(txt), parser, lang_norm)
            line_tokens = [(k, s, 0.0) for k, s in tokens]

            forced = it.get("font_size_px") or p.get("para_font_size_px")
            if isinstance(forced, float):
                forced = int(forced)
            elif isinstance(forced, str) and forced.strip().isdigit():
                forced = int(forced.strip())

            _apply_line_to_item(
                it,
                line_tokens,
                int(p.get("para_index", pi)),
                int(it.get("item_index", ii)),
                int(it.get("start_raw", 0)),
                img_w,
                img_h,
                thai_font,
                latin_font,
                forced,
                apply_baseline_shift=False,
                kerning_adjust=True,
            )
            _uniformize_ai_item_span_font_size(
                it, img_w, img_h, thai_font, latin_font)

def ai_translate_original_text(original_text_full: str, target_lang: str):
    provider, api_key, model, base_url = _resolve_ai_config()
    if not api_key:
        raise Exception("AI_API_KEY is required for AI translation")

    defaults = _remote_defaults()
    lang = _normalize_lang(target_lang)
    styles = ai_lang_style_map(defaults)
    edit_map = ai_prompt_user_by_lang_map(defaults)
    sys_base = ai_prompt_system_base(defaults)

    prompt_sig = _sha1(
        json.dumps(
            {
                "sys": sys_base,
                "edit": edit_map,
                "contract": _active_ai_contract(),
                "data": _active_ai_data_template(),
                "style": styles.get(lang) or styles.get("default") or "",
            },
            ensure_ascii=False,
        )
    )

    cache = None
    cache_key = None
    if AI_CACHE:
        cache = _load_ai_cache(AI_CACHE_PATH)
        cache_key = _sha1(
            json.dumps(
                {"provider": provider, "m": model, "u": base_url, "l": lang, "p": prompt_sig, "t": original_text_full},
                ensure_ascii=False,
            )
        )
        if cache_key in cache:
            cached = cache[cache_key]
            if lang == "th" and cached:
                t = str(cached.get("aiTextFull") or "")
                if t:
                    t2 = re.sub(r"(?:(?<=^)|(?<=[\s\"'“”‘’()\[\]{}<>]))นาย(?=(?:\s|$))", "", t)
                    t2 = re.sub(r"[ 	]{2,}", " ", t2)
                    t2 = re.sub(r"^[ 	]+", "", t2, flags=re.MULTILINE)
                    if t2 != t:
                        cached = dict(cached)
                        cached["aiTextFull"] = t2
                        cache[cache_key] = cached
                        _save_ai_cache(AI_CACHE_PATH, cache)
            return cached

    system_text, user_parts = _build_ai_prompt_packet(lang, original_text_full, defaults)

    started = time.time()
    used_model = model
    if provider == "gemini":
        raw = _gemini_generate_json(api_key, model, system_text, user_parts)
    elif provider == "anthropic":
        raw = _anthropic_generate_json(api_key, model, system_text, user_parts)
    else:
        raw, used_model = _openai_compat_generate_json(api_key, base_url, model, system_text, user_parts)

    ai_text_full = _parse_ai_textfull_only(raw) if DO_AI_JSON else _parse_ai_textfull_text_only(raw)

    if lang == "th" and ai_text_full:
        ai_text_full = re.sub(r"(?:(?<=^)|(?<=[\s\"'“”‘’()\[\]{}<>]))นาย(?=(?:\s|$))", "", ai_text_full)
        ai_text_full = re.sub(r"[ 	]{2,}", " ", ai_text_full)
        ai_text_full = re.sub(r"^[ 	]+", "", ai_text_full, flags=re.MULTILINE)

    result = {
        "aiTextFull": ai_text_full,
        "meta": {"model": used_model, "provider": provider, "base_url": base_url, "latency_sec": round(time.time() - started, 3)},
    }
    if AI_CACHE and cache is not None and cache_key is not None:
        cache[cache_key] = result
        _save_ai_cache(AI_CACHE_PATH, cache)
    return result

def to_translated(u, lang="th"):
    q = parse_qs(urlparse(u).query)
    return "https://lens.google.com/translatedimage?" + urlencode(
        dict(
            vsrid=q["vsrid"][0],
            gsessionid=q["gsessionid"][0],
            sl="auto",
            tl=lang,
            se=1,
            ib="1",
        )
    )

def _b64pad(s: str) -> str:
    return s + "=" * ((4 - (len(s) % 4)) % 4)

def decode_imageurl_to_datauri(imageUrl: str):
    if not imageUrl:
        return None
    if isinstance(imageUrl, str) and imageUrl.startswith("data:image") and "base64," in imageUrl:
        return imageUrl
    for fn in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            b = fn(_b64pad(imageUrl))
            try:
                t = b.decode("utf-8")
            except Exception:
                t = b.decode("utf-8", errors="ignore")
            if "data:image" in t and "base64," in t:
                i = t.find("data:image")
                return t[i:].strip() if i >= 0 else t.strip()
        except Exception:
            pass
    return None

def read_varint(buf, i):
    shift = 0
    result = 0
    while True:
        if i >= len(buf):
            raise ValueError("eof varint")
        b = buf[i]
        i += 1
        result |= ((b & 0x7F) << shift)
        if (b & 0x80) == 0:
            return result, i
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")

def parse_proto(buf, start=0, end=None):
    if end is None:
        end = len(buf)
    i = start
    out = []
    while i < end:
        key, i = read_varint(buf, i)
        field = key >> 3
        wire = key & 7
        if wire == 0:
            val, i = read_varint(buf, i)
            out.append((field, wire, val))
        elif wire == 1:
            val = buf[i: i + 8]
            i += 8
            out.append((field, wire, val))
        elif wire == 2:
            l, i = read_varint(buf, i)
            val = buf[i: i + l]
            i += l
            out.append((field, wire, val))
        elif wire == 5:
            val = buf[i: i + 4]
            i += 4
            out.append((field, wire, val))
        else:
            raise ValueError(f"wiretype {wire}")
    return out

def b2f(b4):
    return struct.unpack("<f", b4)[0]

def b2hex(b):
    return b.hex()

def _get_float_field(msg_fields, field_num):
    for f, w, v in msg_fields:
        if f == field_num and w == 5:
            return b2f(v)
    return None


def _get_points_from_geom(geom_bytes):
    pts = []
    height = None
    geom_fields = parse_proto(geom_bytes)
    for f, w, v in geom_fields:
        if f == 1 and w == 2:
            p_fields = parse_proto(v)
            x = _get_float_field(p_fields, 1)
            y = _get_float_field(p_fields, 2)
            if x is not None and y is not None:
                pts.append((x, y))
        if f == 3 and w == 5:
            height = b2f(v)
    if len(pts) >= 2 and height is not None:
        return pts[0], pts[1], height
    return None, None, None

def _looks_like_geom(geom_bytes):
    geom_fields = parse_proto(geom_bytes)
    pts = 0
    has_height = False
    for f, w, v in geom_fields:
        if f == 1 and w == 2:
            p_fields = parse_proto(v)
            if _get_float_field(p_fields, 1) is not None and _get_float_field(p_fields, 2) is not None:
                pts += 1
        elif f == 3 and w == 5:
            has_height = True
    return pts >= 2 and has_height

def _looks_like_span(span_bytes):
    span_fields = parse_proto(span_bytes)
    has_t = False
    has_range = False
    for f, w, v in span_fields:
        if f in (3, 4) and w == 5:
            has_t = True
        elif f in (1, 2) and w == 0:
            has_range = True
    return has_t and has_range

def _is_item_message(msg_bytes):
    fields = parse_proto(msg_bytes)
    geom_ok = False
    span_ok = 0
    for f, w, v in fields:
        if f == 1 and w == 2 and not geom_ok:
            geom_ok = _looks_like_geom(v)
        elif f == 2 and w == 2:
            if _looks_like_span(v):
                span_ok += 1
    return geom_ok and span_ok > 0

def _extract_items_from_paragraph(par_bytes):
    top = parse_proto(par_bytes)
    items = []
    for _, w, v in top:
        if w == 2 and _is_item_message(v):
            items.append(v)
    if items:
        return items
    items = []
    seen = set()
    nodes = 0

    def walk(buf, depth):
        nonlocal nodes
        if depth >= 4 or nodes > 20000:
            return
        for _, w, v in parse_proto(buf):
            if w != 2:
                continue
            nodes += 1
            if nodes > 20000:
                return
            if _is_item_message(v):
                if v in seen:
                    continue
                seen.add(v)
                items.append(v)
            else:
                walk(v, depth + 1)
    walk(par_bytes, 0)
    return items

def _extract_item_geom_spans(item_bytes):
    fields = parse_proto(item_bytes)
    geom_bytes = None
    spans_bytes = []
    for f, w, v in fields:
        if f == 1 and w == 2:
            geom_bytes = v
        if f == 2 and w == 2:
            spans_bytes.append(v)
    return geom_bytes, spans_bytes

def _extract_span(span_bytes):
    span_fields = parse_proto(span_bytes)
    start = None
    end = None
    t0 = None
    t1 = None
    for f, w, v in span_fields:
        if f == 1 and w == 0:
            start = int(v)
        elif f == 2 and w == 0:
            end = int(v)
        elif f == 3 and w == 5:
            t0 = b2f(v)
        elif f == 4 and w == 5:
            t1 = b2f(v)
    return start, end, t0, t1, span_fields

def _normalize_angle_deg(angle_deg):
    while angle_deg <= -180.0:
        angle_deg += 360.0
    while angle_deg > 180.0:
        angle_deg -= 360.0
    if angle_deg < -90.0:
        angle_deg += 180.0
    if angle_deg > 90.0:
        angle_deg -= 180.0
    return angle_deg

def _slice_text(full_text, start, end):
    if start is None or end is None:
        return ""
    if start < 0 or end < 0 or start > end or end > len(full_text):
        return ""
    return full_text[start:end]

def _range_min_max(ranges):
    if not ranges:
        return None, None
    s = min(r[0] for r in ranges)
    e = max(r[1] for r in ranges)
    return s, e

def decode_tree(paragraphs_b64, full_text, side, img_w, img_h, want_raw=True):
    raw_dump = []
    paragraphs = []

    cursor = 0

    for para_index, b64s in enumerate(paragraphs_b64):
        par_bytes = base64.b64decode(b64s)
        if want_raw:
            raw_dump.append({"para_index": para_index,
                            "b64": b64s, "bytes_hex": b2hex(par_bytes)})

        item_msgs = _extract_items_from_paragraph(par_bytes)
        items = []
        para_ranges = []
        para_bounds = None

        for item_index, item_bytes in enumerate(item_msgs):
            geom_bytes, spans_bytes = _extract_item_geom_spans(item_bytes)
            if geom_bytes is None:
                continue

            p1, p2, height_norm = _get_points_from_geom(geom_bytes)
            if p1 is None or p2 is None or height_norm is None:
                continue

            x1n, y1n = p1
            x2n, y2n = p2
            x1 = x1n * img_w
            y1 = y1n * img_h
            x2 = x2n * img_w
            y2 = y2n * img_h

            dx = x2 - x1
            dy = y2 - y1
            if dx < 0 or (abs(dx) < 1e-12 and dy < 0):
                x1, y1, x2, y2 = x2, y2, x1, y1
                x1n, y1n, x2n, y2n = x2n, y2n, x1n, y1n
                dx = x2 - x1
                dy = y2 - y1

            L = math.hypot(dx, dy)
            if L <= 1e-12:
                continue

            ux = dx / L
            uy = dy / L

            angle_deg_raw = math.degrees(math.atan2(dy, dx))
            angle_deg = _normalize_angle_deg(angle_deg_raw)
            
            angle_deg_css = angle_deg

            height_px = height_norm * img_h

            item_spans = []
            item_ranges = []
            item_bounds = None

            for span_index, sb in enumerate(spans_bytes):
                start, end, t0, t1, _ = _extract_span(sb)

                if start is None:
                    start = cursor
                else:
                    cursor = max(cursor, start)
                if end is None:
                    continue
                cursor = max(cursor, end)

                if t0 is None and t1 is None:
                    continue
                if t0 is None:
                    t0 = 0.0
                if t1 is None:
                    t1 = 1.0

                valid_text = False
                span_text = ""
                if start is not None and end is not None and 0 <= start <= end <= len(full_text):
                    span_text = full_text[start:end]
                    valid_text = span_text.strip() != ""
                    if valid_text:
                        item_ranges.append((start, end))

                e1x = x1 + ux * (t0 * L)
                e1y = y1 + uy * (t0 * L)
                e2x = x1 + ux * (t1 * L)
                e2y = y1 + uy * (t1 * L)

                cx = (e1x + e2x) / 2.0
                cy = (e1y + e2y) / 2.0

                width_px = abs(t1 - t0) * L
                left_px = cx - width_px / 2.0
                top_px = cy - height_px / 2.0

                left = left_px / img_w
                top = top_px / img_h
                width = width_px / img_w
                height = height_px / img_h

                span_node = {
                    "side": side,
                    "para_index": para_index,
                    "item_index": item_index,
                    "span_index": span_index,
                    "start_raw": start,
                    "end_raw": end,
                    "t0_raw": t0,
                    "t1_raw": t1,
                    "height_raw": height_norm,
                    "baseline_p1": {"x": x1n, "y": y1n},
                    "baseline_p2": {"x": x2n, "y": y2n},
                    "box": {
                        "left": left,
                        "top": top,
                        "width": width,
                        "height": height,
                        "rotation_deg": angle_deg,
                        "rotation_deg_css": angle_deg_css,
                        "center": {"x": cx / img_w, "y": cy / img_h},
                        "left_pct": left * 100.0,
                        "top_pct": top * 100.0,
                        "width_pct": width * 100.0,
                        "height_pct": height * 100.0,
                    },
                    "text": span_text,
                    "valid_text": valid_text,
                }

                quad = _token_box_quad_px(span_node, img_w, img_h, pad_px=0)
                if quad:
                    xs = [p[0] for p in quad]
                    ys = [p[1] for p in quad]
                    b = (min(xs), min(ys), max(xs), max(ys))
                    item_bounds = b if item_bounds is None else (min(item_bounds[0], b[0]), min(
                        item_bounds[1], b[1]), max(item_bounds[2], b[2]), max(item_bounds[3], b[3]))
                    item_bounds = item_bounds
                item_spans.append(span_node)

            s0, s1 = _range_min_max(item_ranges)
            item_text = _slice_text(
                full_text, s0, s1).strip() if s0 is not None else ""
            item_valid_text = item_text.strip() != ""
            if s0 is not None:
                para_ranges.append((s0, s1))

            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            left_px = cx - L / 2.0
            top_px = cy - height_px / 2.0

            item_box = {
                "left": left_px / img_w,
                "top": top_px / img_h,
                "width": L / img_w,
                "height": height_px / img_h,
                "rotation_deg": angle_deg,
                "rotation_deg_css": angle_deg_css,
                "center": {"x": cx / img_w, "y": cy / img_h},
            }

            if item_bounds is not None:
                para_bounds = item_bounds if para_bounds is None else (min(para_bounds[0], item_bounds[0]), min(
                    para_bounds[1], item_bounds[1]), max(para_bounds[2], item_bounds[2]), max(para_bounds[3], item_bounds[3]))

            items.append(
                {
                    "side": side,
                    "para_index": para_index,
                    "item_index": item_index,
                    "start_raw": s0,
                    "end_raw": s1,
                    "text": item_text,
                    "valid_text": item_valid_text,
                    "height_raw": height_norm,
                    "baseline_p1": {"x": x1n, "y": y1n},
                    "baseline_p2": {"x": x2n, "y": y2n},
                    "box": item_box,
                    "bounds_px": item_bounds,
                    "spans": item_spans,
                }
            )

        p0, p1 = _range_min_max(para_ranges)
        para_text = _slice_text(
            full_text, p0, p1).strip() if p0 is not None else ""
        para_valid_text = para_text.strip() != ""
        paragraphs.append(
            {
                "side": side,
                "para_index": para_index,
                "start_raw": p0,
                "end_raw": p1,
                "text": para_text,
                "valid_text": para_valid_text,
                "bounds_px": para_bounds,
                "items": items,
            }
        )

    tree = {"side": side, "paragraphs": paragraphs}
    return tree, raw_dump

def flatten_tree_spans(tree):
    spans = []
    for p in tree.get("paragraphs") or []:
        for it in p.get("items") or []:
            for sp in it.get("spans") or []:
                spans.append(sp)
    return spans

def flatten_tree_items_as_tokens(tree, img_w, img_h):
    toks = []
    for p in tree.get("paragraphs") or []:
        for it in p.get("items") or []:
            t = {
                "side": it["side"],
                "para_index": it["para_index"],
                "item_index": it["item_index"],
                "span_index": -1,
                "start_raw": it.get("start_raw"),
                "end_raw": it.get("end_raw"),
                "t0_raw": 0.0,
                "t1_raw": 1.0,
                "height_raw": it.get("height_raw"),
                "baseline_p1": it.get("baseline_p1"),
                "baseline_p2": it.get("baseline_p2"),
                "box": it.get("box"),
                "text": it.get("text") or "",
                "valid_text": it.get("valid_text", False),
            }
            toks.append(t)
    return toks

def _mean_angle_deg(angles_deg):
    vals = [a for a in (angles_deg or []) if a is not None]
    if not vals:
        return 0.0
    xs = [math.cos(math.radians(a)) for a in vals]
    ys = [math.sin(math.radians(a)) for a in vals]
    return math.degrees(math.atan2(sum(ys) / len(ys), sum(xs) / len(xs)))

def _rotate_xy(x, y, cos_a, sin_a):
    return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)

def _para_obb_quad_px(para_node, W, H):
    items = para_node.get("items") or []
    if not items:
        return None

    angles = []
    pts = []
    for it in items:
        b = (it.get("box") or {})
        angles.append(b.get("rotation_deg", 0.0))
        q = _token_box_quad_px(it, W, H, pad_px=0)
        if q:
            pts.extend(q)

    if len(pts) < 4:
        return None

    ang = _mean_angle_deg(angles)
    cos_a = math.cos(math.radians(ang))
    sin_a = math.sin(math.radians(ang))
    cos_n = cos_a
    sin_n = -sin_a

    rpts = [_rotate_xy(x, y, cos_n, sin_n) for (x, y) in pts]
    xs = [p[0] for p in rpts]
    ys = [p[1] for p in rpts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    corners = [(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)]
    return [_rotate_xy(x, y, cos_a, sin_a) for (x, y) in corners]

def build_level_outlines(tree, W, H):
    outlines = []
    if not tree:
        return outlines

    if DRAW_OUTLINE_PARA:
        for para in tree.get("paragraphs") or []:
            q = _para_obb_quad_px(para, W, H)
            if q:
                outlines.append(
                    {"quad": q, "color": PARA_OUTLINE, "width": PARA_OUTLINE_WIDTH})

    if DRAW_OUTLINE_ITEM:
        for itok in flatten_tree_items_as_tokens(tree, W, H):
            q = _token_box_quad_px(itok, W, H, pad_px=0)
            if q:
                outlines.append(
                    {"quad": q, "color": ITEM_OUTLINE, "width": ITEM_OUTLINE_WIDTH})

    return outlines

def tokens_to_html(tokens, container_class="RTMDre"):
    parts = []
    parts.append(f'<div class="{container_class}">')
    for t in tokens:
        if not t.get("valid_text"):
            continue
        b = t["box"]
        aria = (t.get("text") or "").replace('"', "&quot;").replace("\n", " ")
        wi = t.get("wi", 0)
        rot = b.get("rotation_deg_css", b.get("rotation_deg", 0.0))
        fs = t.get("font_size_px") or b.get("font_size_px")
        lh = None
        if fs:
            try:
                lh = max(1, int(round(float(fs) * 1.05)))
            except Exception:
                lh = None
        style = (
            f'top: calc({b["top_pct"]}%); '
            f'left: calc({b["left_pct"]}%); '
            f'width: calc({b["width_pct"]}%); '
            f'height: calc({b["height_pct"]}%); '
            f"transform: rotate({rot}deg);"
        )
        if fs:
            style += f" font-size: {float(fs):.4g}px;"
        if lh:
            style += f" line-height: {lh}px;"
        parts.append(
            f'<div class="IwqbBf" aria-label="{aria}" data-wi="{wi}" role="button" tabindex="-1" style="{style}"></div>'
        )
    parts.append("</div>")
    return "".join(parts)

def tp_overlay_css():
    return (
        ".tp-draw-root{position:absolute;inset:0;pointer-events:none;}"
        ".tp-draw-scope{position:absolute;left:0;top:0;transform-origin:0 0;}"
        ".tp-para{position:absolute;left:0;top:0;}"
        ".tp-item{position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;"
        "white-space:pre;pointer-events:none;box-sizing:border-box;overflow:visible;"
        "font-family:var(--tp-font,system-ui);font-weight:500;"
        "color:var(--tp-fg,rgba(20,20,20,.98));"
        "text-shadow:0 0 2px rgba(255,255,255,.90),0 0 2px rgba(0,0,0,.60),0 1px 1px rgba(0,0,0,.35);}"
        ".tp-item>span{display:inline-block;white-space:pre;transform-origin:center;"
        "padding:0;border-radius:3px;"
        "background:var(--tp-bg,rgba(255,255,255,.65));"
        "box-decoration-break:clone;-webkit-box-decoration-break:clone;}"
        ".tp-item[data-wrap='1'],.tp-item[data-wrap='1']>span{white-space:pre-wrap;word-break:break-word;}"
        ".tp-item[data-wrap='1']>span{text-align:center;}"
    )

def _tp_norm_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        try:
            return [v[k] for k in sorted(v.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))]
        except Exception:
            return list(v.values())
    return []

def _tp_num(x):
    try:
        n = float(x)
        return n if math.isfinite(n) else None
    except Exception:
        return None

def _tp_escape_text(s: str) -> str:
    if not s:
        return ""
    s = s.replace("\r", "")
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s

def _tp_get_rect(obj: dict, base_w: float, base_h: float):
    if not isinstance(obj, dict):
        return None
    box = obj.get("box") if isinstance(obj.get("box"), dict) else {}

    l0 = _tp_num(box.get("left"))
    t0 = _tp_num(box.get("top"))
    w0 = _tp_num(box.get("width"))
    h0 = _tp_num(box.get("height"))
    if None not in (l0, t0, w0, h0) and w0 > 0 and h0 > 0:
        l = l0 * base_w
        t = t0 * base_h
        r = (l0 + w0) * base_w
        b = (t0 + h0) * base_h
        deg = _tp_num(box.get("rotation_deg_css"))
        if deg is None:
            deg = _tp_num(box.get("rotation_deg"))
        return {"l": l, "t": t, "r": r, "b": b, "deg": deg or 0.0}

    lp = _tp_num(box.get("left_pct"))
    tp = _tp_num(box.get("top_pct"))
    wp = _tp_num(box.get("width_pct"))
    hp = _tp_num(box.get("height_pct"))
    if None not in (lp, tp, wp, hp) and wp > 0 and hp > 0:
        l0p = lp / 100.0
        t0p = tp / 100.0
        w0p = wp / 100.0
        h0p = hp / 100.0
        l = l0p * base_w
        t = t0p * base_h
        r = (l0p + w0p) * base_w
        b = (t0p + h0p) * base_h
        deg = _tp_num(box.get("rotation_deg_css"))
        if deg is None:
            deg = _tp_num(box.get("rotation_deg"))
        return {"l": l, "t": t, "r": r, "b": b, "deg": deg or 0.0}

    bpx = obj.get("bounds_px")
    if isinstance(bpx, list) and len(bpx) == 4:
        l = _tp_num(bpx[0])
        t = _tp_num(bpx[1])
        r = _tp_num(bpx[2])
        bb = _tp_num(bpx[3])
        if None not in (l, t, r, bb) and r > l and bb > t:
            return {"l": l, "t": t, "r": r, "b": bb, "deg": 0.0}
    return None

def _tp_union_rect(items: list, base_w: float, base_h: float):
    l = float("inf")
    t = float("inf")
    r = float("-inf")
    b = float("-inf")
    for it in items:
        bx = _tp_get_rect(it, base_w, base_h)
        if not bx:
            continue
        l = min(l, bx["l"])
        t = min(t, bx["t"])
        r = max(r, bx["r"])
        b = max(b, bx["b"])
    if not math.isfinite(l) or not math.isfinite(t) or not math.isfinite(r) or not math.isfinite(b):
        return None
    return {"l": l, "t": t, "r": r, "b": b, "deg": 0.0}

def _tp_mean_item_deg(items: list, base_w: float, base_h: float) -> float:
    angles = []
    for it in items or []:
        bx = _tp_get_rect(it, base_w, base_h)
        if not bx:
            continue
        a = _tp_num(bx.get("deg"))
        if a is None:
            continue
        angles.append(float(a))
    if not angles:
        return 0.0
    return float(_mean_angle_deg(angles))

def _tp_oriented_rect_from_points(pts: list, para_deg: float) -> dict | None:
    if len(pts) < 2:
        return None

    ang = float(para_deg or 0.0)
    if not math.isfinite(ang):
        ang = 0.0

    rad_n = math.radians(-ang)
    cn = math.cos(rad_n)
    sn = math.sin(rad_n)
    rpts = [(x * cn - y * sn, x * sn + y * cn) for x, y in pts]
    xs = [p[0] for p in rpts]
    ys = [p[1] for p in rpts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)

    w = float(maxx - minx)
    h = float(maxy - miny)
    if w <= 0.0 or h <= 0.0:
        return None

    cx0 = float((minx + maxx) / 2.0)
    cy0 = float((miny + maxy) / 2.0)
    rad_a = math.radians(ang)
    ca = math.cos(rad_a)
    sa = math.sin(rad_a)
    cx = (cx0 * ca) - (cy0 * sa)
    cy = (cx0 * sa) + (cy0 * ca)

    l = cx - (w / 2.0)
    t = cy - (h / 2.0)
    return {"l": float(l), "t": float(t), "r": float(l + w), "b": float(t + h), "deg": float(ang)}

def _tp_rect_corners(l: float, t: float, r: float, b: float, deg: float) -> list:
    w = float(r - l)
    h = float(b - t)
    if w <= 0.0 or h <= 0.0:
        return []
    cx = float((l + r) / 2.0)
    cy = float((t + b) / 2.0)
    hw = w / 2.0
    hh = h / 2.0
    rad = math.radians(float(deg or 0.0))
    c = math.cos(rad)
    s = math.sin(rad)
    out = []
    for x, y in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
        rx = (x * c) - (y * s)
        ry = (x * s) + (y * c)
        out.append((cx + rx, cy + ry))
    return out

def _tp_para_rect_from_items(items: list, base_w: float, base_h: float, para_deg: float) -> dict | None:
    if not items:
        return None

    pts = []
    for it in items:
        ibx = _tp_get_rect(it, base_w, base_h)
        if not ibx:
            continue
        w = float(ibx["r"] - ibx["l"])
        h = float(ibx["b"] - ibx["t"])
        if w <= 0.0 or h <= 0.0:
            continue
        deg = float(ibx.get("deg") or 0.0)
        cx = float(ibx["l"] + w / 2.0)
        cy = float(ibx["t"] + h / 2.0)
        hw = w / 2.0
        hh = h / 2.0
        rad = math.radians(deg)
        c = math.cos(rad)
        s = math.sin(rad)
        for x, y in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
            rx = (x * c) - (y * s)
            ry = (x * s) + (y * c)
            pts.append((cx + rx, cy + ry))

    return _tp_oriented_rect_from_points(pts, para_deg)

def _tp_extract_item_text(it: dict) -> str:
    if not isinstance(it, dict):
        return ""
    for k in (
        "text",
        "translated_text",
        "translatedText",
        "ai_text",
        "aiText",
        "display_text",
        "displayText",
    ):
        v = it.get(k)
        if isinstance(v, str) and v:
            return v
    spans = _tp_norm_list(it.get("spans"))
    if spans:
        return "".join(s.get("text") if isinstance(s, dict) and isinstance(s.get("text"), str) else "" for s in spans)
    return ""

def ai_tree_to_tp_html(tree: dict, base_w: int, base_h: int) -> str:
    base_w = int(base_w or 0)
    base_h = int(base_h or 0)
    if base_w <= 0 or base_h <= 0:
        return ""
    paras = _tp_norm_list(tree.get("paragraphs")
                          if isinstance(tree, dict) else None)
    if not paras:
        return ""

    parts = [
        f'<div class="tp-draw-scope" style="width: {base_w}px; height: {base_h}px;">']
    for pi, p in enumerate(paras):
        if not isinstance(p, dict):
            continue
        items = _tp_norm_list(p.get("items"))
        if len(items) > 1 and any(isinstance(x, dict) and _tp_num(x.get("item_index")) is not None for x in items):
            items = sorted(
                items,
                key=lambda x: _tp_num(
                    x.get("item_index")) if isinstance(x, dict) else 0.0,
            )

        para_idx = int(_tp_num(p.get("para_index")) or pi)
        pbx = _tp_get_rect(p, base_w, base_h) or _tp_union_rect(
            items, base_w, base_h)
        if not pbx:
            continue

        para_deg = float(pbx.get("deg") or 0.0)
        if abs(para_deg) <= 0.01:
            derived = _tp_mean_item_deg(items, base_w, base_h)
            if abs(derived) > 0.01:
                pbx2 = _tp_para_rect_from_items(items, base_w, base_h, derived)
                if pbx2:
                    pbx = pbx2
                    para_deg = float(pbx.get("deg") or 0.0)

        pbx_items = _tp_para_rect_from_items(items, base_w, base_h, para_deg)
        if pbx_items:
            pts = _tp_rect_corners(
                pbx["l"], pbx["t"], pbx["r"], pbx["b"], para_deg)
            pts += _tp_rect_corners(pbx_items["l"], pbx_items["t"],
                                    pbx_items["r"], pbx_items["b"], para_deg)
            merged = _tp_oriented_rect_from_points(pts, para_deg)
            if merged:
                pbx = merged

        eps = float(_TP_HTML_EPS_PX or 0.0)
        if eps > 0.0:
            pbx = {
                "l": float(pbx["l"] - eps),
                "t": float(pbx["t"] - eps),
                "r": float(pbx["r"] + eps),
                "b": float(pbx["b"] + eps),
                "deg": float(pbx.get("deg") or para_deg or 0.0),
            }

        pw = max(0.0, pbx["r"] - pbx["l"])
        ph = max(0.0, pbx["b"] - pbx["t"])

        para_style = (
            f'left: {pbx["l"]:.6f}px; '
            f'top: {pbx["t"]:.6f}px; '
            f'width: {pw:.6f}px; '
            f'height: {ph:.6f}px;'
        )
        if abs(para_deg) > 0.01:
            para_style += f' transform: rotate({para_deg:.6g}deg); transform-origin: center center;'

        parts.append(
            f'<div class="tp-para tp-para-{para_idx}" data-para-index="{para_idx}" style="{para_style}">'
        )

        para_cx = (pbx["l"] + pbx["r"]) / 2.0
        para_cy = (pbx["t"] + pbx["b"]) / 2.0
        inv_c = inv_s = None
        if abs(para_deg) > 0.01:
            rad_inv = math.radians(-para_deg)
            inv_c = math.cos(rad_inv)
            inv_s = math.sin(rad_inv)

        raw_texts = [_tp_extract_item_text(it) for it in items]
        mapped = list(raw_texts)
        p_text = p.get("text") if isinstance(p.get("text"), str) else ""
        non_empty = sum(
            1 for t in raw_texts if isinstance(t, str) and t.strip())
        any_nl = any(isinstance(t, str) and re.search(r"\r?\n", t)
                     for t in raw_texts)
        first_nl = bool(raw_texts and isinstance(
            raw_texts[0], str) and re.search(r"\r?\n", raw_texts[0]))
        lines = None
        if p_text and re.search(r"\r?\n", p_text) and (non_empty <= 1 or any_nl):
            lines = [s.rstrip()
                     for s in re.split(r"\r?\n+", p_text) if s.strip()]
        elif first_nl and (non_empty <= 1 or all(not (t or "").strip() for t in raw_texts[1:])):
            lines = [s.rstrip() for s in re.split(
                r"\r?\n+", raw_texts[0]) if s.strip()]
        if lines:
            mapped = [lines[i] if i < len(lines) else (
                raw_texts[i] if i < len(raw_texts) else "") for i in range(len(items))]

        for ii, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            text = (mapped[ii] if ii < len(mapped) else "") or ""
            if not text.strip():
                continue

            ibx = _tp_get_rect(it, base_w, base_h)
            if not ibx:
                continue

            w0 = max(0.0, ibx["r"] - ibx["l"])
            h0 = max(0.0, ibx["b"] - ibx["t"])
            if w0 <= 0 or h0 <= 0:
                continue

            w = float(w0 + (2.0 * eps)) if eps > 0.0 else float(w0)
            h = float(h0 + (2.0 * eps)) if eps > 0.0 else float(h0)

            item_idx = int(_tp_num(it.get("item_index")) or ii)

            fs_raw = _tp_num(it.get("font_size_px"))
            
            fs = int(round(fs_raw)) if fs_raw and fs_raw > 0 else max(
                10, int(round(h0 * 0.85)))
            fs = max(6, min(fs, max(6, int(math.floor(h0 * 0.95)))))
            lh = max(1, min(int(round(h0)), int(round(fs * 1.12))))
            if inv_c is not None and inv_s is not None:
                icx = (ibx["l"] + ibx["r"]) / 2.0
                icy = (ibx["t"] + ibx["b"]) / 2.0
                dx = icx - para_cx
                dy = icy - para_cy
                rcx = para_cx + (dx * inv_c - dy * inv_s)
                rcy = para_cy + (dx * inv_s + dy * inv_c)
                left = (rcx - (w / 2.0)) - pbx["l"]
                top = (rcy - (h / 2.0)) - pbx["t"]
            else:
                left = (ibx["l"] - pbx["l"]) - eps
                top = (ibx["t"] - pbx["t"]) - eps

            style = (
                f'left: {left:.6f}px; '
                f'top: {top:.6f}px; '
                f'width: {w:.6f}px; '
                f'height: {h:.6f}px; '
                f'font-size: {fs}px; '
                f'line-height: {lh}px; '
                'padding-bottom: 0px;'
            )
            deg = float(ibx.get("deg") or 0.0)
            if inv_c is not None:
                deg = deg - para_deg
            if abs(deg) > 0.01:
                style += f' transform: rotate({deg:.6g}deg); transform-origin: center center;'

            wrap_attr = ' data-wrap="1"' if it.get("_tp_wrap") else ""
            parts.append(
                f'<div class="tp-item tp-item-{item_idx}" data-para-index="{para_idx}" data-item-index="{item_idx}"{wrap_attr} style="{style}">'
                f'<span>{_tp_escape_text(text)}</span></div>'
            )

        parts.append("</div>")
    parts.append("</div>")
    return "".join(parts)

def overlay_css(container_class="RTMDre", token_class="IwqbBf"):
    c = container_class
    t = token_class
    return (
        f".{c}{{"
        "position:absolute!important;"
        "inset:0!important;"
        "width:100%!important;"
        "height:100%!important;"
        "display:block!important;"
        "opacity:1!important;"
        "visibility:visible!important;"
        "pointer-events:none!important;"
        "overflow:visible!important;"
        "z-index:2147483647!important;"
        "transform:none!important;"
        "contain:layout style paint!important;"
        "--lens-text-color:#fff;"
        "--lens-font-family:\"Noto Sans Thai\",\"Noto Sans Thai UI\",\"Noto Sans\",system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Arial,sans-serif;"
        "--lens-text-shadow:0 1px 2px rgba(0,0,0,.85),0 0 1px rgba(0,0,0,.85);"
        "}}"
        f".{c} *{{box-sizing:border-box!important;}}"
        f".{c} .{t}{{"
        "position:absolute!important;"
        "display:flex!important;"
        "align-items:center!important;"
        "justify-content:center!important;"
        "opacity:1!important;"
        "visibility:visible!important;"
        "pointer-events:none!important;"
        "user-select:none!important;"
        "overflow:visible!important;"
        "white-space:pre!important;"
        "transform-origin:top left!important;"
        "filter:none!important;"
        "mix-blend-mode:normal!important;"
        "text-transform:none!important;"
        "letter-spacing:normal!important;"
        "}}"
        f".{c} .{t}::before{{"
        "content:attr(aria-label)!important;"
        "display:block!important;"
        "white-space:pre!important;"
        "color:var(--lens-text-color)!important;"
        "font-family:var(--lens-font-family)!important;"
        "text-shadow:var(--lens-text-shadow)!important;"
        "font-weight:400!important;"
        "font-style:normal!important;"
        "line-height:inherit!important;"
        "text-rendering:geometricPrecision!important;"
        "}}"
    )

def ensure_font(path, urls):
    key = str(path or "")
    cached = _FONT_RESOLVE_CACHE.get(key)
    if cached is not None:
        return cached or None

    if path and os.path.isfile(path):
        _FONT_RESOLVE_CACHE[key] = path
        return path

    candidates = []
    for root in ("/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts")):
        if os.path.isdir(root):
            for p in os.walk(root):
                for fn in p[2]:
                    if fn.lower() == os.path.basename(path).lower():
                        candidates.append(os.path.join(p[0], fn))
    if candidates:
        _FONT_RESOLVE_CACHE[key] = candidates[0]
        return candidates[0]

    for url in urls:
        try:
            r = httpx.get(url, timeout=30)
            if r.status_code == 200 and len(r.content) > 10000:
                with open(path, "wb") as f:
                    f.write(r.content)
                if os.path.isfile(path):
                    _FONT_RESOLVE_CACHE[key] = path
                    return path
        except Exception:
            pass
    _FONT_RESOLVE_CACHE[key] = ""
    return None

def pick_font(text, thai_path, latin_path, size):
    def has_thai(s):
        for ch in s:
            o = ord(ch)
            if 0x0E00 <= o <= 0x0E7F:
                return True
        return False

    fp = thai_path if has_thai(text) else latin_path
    if fp and os.path.isfile(fp):
        try:
            return ImageFont.truetype(fp, size=size, layout_engine=getattr(ImageFont, "LAYOUT_RAQM", 0))
        except Exception:
            try:
                return ImageFont.truetype(fp, size=size)
            except Exception:
                pass
    return ImageFont.load_default()

def _get_font_pair(thai_path, latin_path, size):
    key = (str(thai_path or ""), str(latin_path or ""), int(size))
    v = _FONT_PAIR_CACHE.get(key)
    if v:
        return v
    f_th = pick_font("ก", thai_path, latin_path, size)
    f_lat = pick_font("A", thai_path, latin_path, size)
    _FONT_PAIR_CACHE[key] = (f_th, f_lat)
    return f_th, f_lat

def _is_thai_char(ch: str) -> bool:
    if not ch:
        return False
    o = ord(ch)
    return 0x0E00 <= o <= 0x0E7F

def _split_runs_for_fallback(text: str):
    runs = []
    cur = []
    cur_is_th = None
    for ch in text:
        if ch == "\n":
            if cur:
                runs.append(("".join(cur), cur_is_th))
                cur = []
            runs.append(("\n", None))
            cur_is_th = None
            continue
        is_th = _is_thai_char(ch)
        if ch.isspace() and cur_is_th is not None:
            is_th = cur_is_th
        if cur_is_th is None:
            cur_is_th = is_th
            cur = [ch]
            continue
        if is_th == cur_is_th:
            cur.append(ch)
        else:
            runs.append(("".join(cur), cur_is_th))
            cur = [ch]
            cur_is_th = is_th
    if cur:
        runs.append(("".join(cur), cur_is_th))
    return runs

def _draw_text_centered_fallback(draw_ctx, center_xy, text, thai_path, latin_path, size, fill):
    t = _sanitize_draw_text(text)
    if not t:
        return
    f_th, f_lat = _get_font_pair(thai_path, latin_path, size)
    runs = _split_runs_for_fallback(t)

    x = 0.0
    min_t = 0.0
    max_b = 0.0
    for run, is_th in runs:
        if run == "\n":
            continue
        f = f_th if is_th else f_lat
        try:
            bb = draw_ctx.textbbox((x, 0), run, font=f, anchor="ls")
            min_t = min(min_t, float(bb[1]))
            max_b = max(max_b, float(bb[3]))
            x = float(bb[2])
        except Exception:
            try:
                w, h = draw_ctx.textsize(run, font=f)
            except Exception:
                w, h = (len(run) * size * 0.5, size)
            min_t = min(min_t, -float(h) * 0.8)
            max_b = max(max_b, float(h) * 0.2)
            x += float(w)

    total_w = max(1.0, x)
    total_h = max(1.0, max_b - min_t)

    cx, cy = center_xy
    start_x = float(cx) - (total_w / 2.0)
    baseline_y = float(cy) - (total_h / 2.0) - min_t

    x = start_x
    for run, is_th in runs:
        if run == "\n":
            continue
        f = f_th if is_th else f_lat
        draw_ctx.text((x, baseline_y), run, font=f, fill=fill, anchor="ls")
        try:
            x += float(draw_ctx.textlength(run, font=f))
        except Exception:
            try:
                w, _ = draw_ctx.textsize(run, font=f)
            except Exception:
                w = len(run) * size * 0.5
            x += float(w)

def _draw_text_baseline_fallback(draw, pos, text, thai_path, latin_path, size, fill):
    t = _sanitize_draw_text(text)
    if not t:
        return 0.0, 0.0
    f_th, f_lat = _get_font_pair(thai_path, latin_path, size)
    runs = _split_runs_for_fallback(t)

    x0, y0 = pos
    x = float(x0)
    max_ascent = 0
    max_descent = 0

    for run, is_th in runs:
        if run == "\n":
            continue
        f = f_th if is_th else f_lat
        try:
            ascent, descent = f.getmetrics()
        except Exception:
            ascent, descent = size, int(size * 0.25)
        max_ascent = max(max_ascent, ascent)
        max_descent = max(max_descent, descent)

        draw.text((x, y0), run, font=f, fill=fill, anchor="ls")
        try:
            adv = float(f.getlength(run))
        except Exception:
            tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
            dtmp = ImageDraw.Draw(tmp)
            try:
                bb = dtmp.textbbox((0, 0), run, font=f, anchor="ls")
                adv = float(bb[2] - bb[0])
            except Exception:
                w, _ = dtmp.textsize(run, font=f)
                adv = float(w)
        x += adv

    return float(x - x0), float(max_ascent + max_descent)

def _baseline_offset_px_for_text(text: str, thai_path: str, latin_path: str, size: int):
    t = _sanitize_draw_text(text)
    if not t:
        return None
    f_th, f_lat = _get_font_pair(thai_path, latin_path, size)
    runs = _split_runs_for_fallback(t)

    tmp = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    dtmp = ImageDraw.Draw(tmp)

    x = 0.0
    min_t = 0.0
    max_b = 0.0
    for run, is_th in runs:
        if run == "\n":
            continue
        f = f_th if is_th else f_lat
        try:
            bb = dtmp.textbbox((x, 0), run, font=f, anchor="ls")
            min_t = min(min_t, float(bb[1]))
            max_b = max(max_b, float(bb[3]))
            x = float(bb[2])
        except Exception:
            try:
                w, h = dtmp.textsize(run, font=f)
            except Exception:
                w, h = (len(run) * size * 0.5, size)
            min_t = min(min_t, -float(h) * 0.8)
            max_b = max(max_b, float(h) * 0.2)
            x += float(w)

    total_h = max(1.0, max_b - min_t)
    baseline_offset = -(total_h / 2.0) - min_t
    return baseline_offset, total_h

def _line_metrics_px(text: str, thai_path: str, latin_path: str, size: int):
    t = _sanitize_draw_text(text)
    if not t:
        return None
    f_th, f_lat = _get_font_pair(thai_path, latin_path, size)
    runs = _split_runs_for_fallback(t)

    tmp = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    dtmp = ImageDraw.Draw(tmp)

    x = 0.0
    min_t = 0.0
    max_b = 0.0
    for run, is_th in runs:
        if run == "\n":
            continue
        f = f_th if is_th else f_lat
        try:
            bb = dtmp.textbbox((x, 0), run, font=f, anchor="ls")
            min_t = min(min_t, float(bb[1]))
            max_b = max(max_b, float(bb[3]))
            x = float(bb[2])
        except Exception:
            try:
                w, h = dtmp.textsize(run, font=f)
            except Exception:
                w, h = (len(run) * size * 0.5, size)
            min_t = min(min_t, -float(h) * 0.8)
            max_b = max(max_b, float(h) * 0.2)
            x += float(w)

    width = max(1.0, x)
    total_h = max(1.0, max_b - min_t)
    baseline_to_center = -((min_t + max_b) / 2.0)
    return width, total_h, baseline_to_center

def _item_avail_w_px(item: dict, W: int, H: int) -> float:
    b = item.get("box") or {}
    w_box = float(b.get("width") or 0.0) * float(W)
    
    L = 0.0
    p1 = item.get("baseline_p1") or {}
    p2 = item.get("baseline_p2") or {}
    if ("x" in p1 and "y" in p1 and "x" in p2 and "y" in p2):
        dx = (float(p2.get("x") or 0.0) - float(p1.get("x") or 0.0)) * float(W)
        dy = (float(p2.get("y") or 0.0) - float(p1.get("y") or 0.0)) * float(H)
        L = float(math.hypot(dx, dy))

    avail = max(w_box, L)
    return max(1.0, float(avail))

def _item_avail_h_px(item: dict, H: int) -> float:
    b = item.get("box") or {}
    return max(1.0, (float(b.get("height") or 0.0) * float(H)) - 2.0)

def _item_line_text(item: dict) -> str:
    t = str(item.get("text") or "")
    if t.strip():
        return t
    spans = item.get("spans") or []
    return "".join(str(s.get("text") or "") for s in spans)

def _compute_fit_size_px_for_item(item: dict, thai_path: str, latin_path: str, W: int, H: int, base_size: int = 96) -> int | None:
    item.pop("_tp_wrap", None)
    text = _item_line_text(item)
    if not text.strip():
        return None
    m = _line_metrics_px(text, thai_path, latin_path, base_size)
    if m is None:
        return None
    tw, th, _ = m
    avail_w = _item_avail_w_px(item, W, H)
    avail_h = _item_avail_h_px(item, H)
    if tw <= 1e-6 or th <= 1e-6:
        return None

    is_thai = any(_is_thai_char(ch) for ch in text)
    scale_w = (avail_w * 0.98) / tw
    scale_h = (avail_h * (0.90 if is_thai else 0.94)) / th
    scale = min(scale_w, scale_h)
    if scale <= 0:
        return None

    size = max(10, int(base_size * scale))

    while size > 10:
        mm = _line_metrics_px(text, thai_path, latin_path, size)
        if mm is None:
            return None
        tw2, th2, _ = mm
        if (tw2 <= avail_w * 0.999) and (th2 <= avail_h * 0.999):
            break
        size -= 1
        
    if size <= 12 and avail_h >= 24:
        tw0, th0, _ = m
        if tw0 > (avail_w * 1.2):
            def _wrap_fits(s: int) -> bool:
                if s <= 0:
                    return False
                k = float(s) / float(base_size)
                tw = float(tw0) * k
                th = float(th0) * k
                lines = int(math.ceil(max(1.0, tw) / max(1.0, avail_w)))
                return (float(lines) * th) <= float(avail_h)

            hi = int(min(max(16, avail_h), base_size * 3))
            lo = int(size)
            best = int(size)
            while lo <= hi:
                mid = (lo + hi) // 2
                if _wrap_fits(mid):
                    best = int(mid)
                    lo = mid + 1
                else:
                    hi = mid - 1

            if best >= int(size * 1.25):
                item["_tp_wrap"] = True
                size = int(best)

    return int(size)

def fit_tree_font_sizes_for_tp_html(tree: dict, thai_path: str, latin_path: str, W: int, H: int) -> dict:
    paras = tree.get("paragraphs") or []
    for p in paras:
        items = p.get("items") or []
        if not items:
            continue

        per_item_fit: dict[int, int] = {}
        fits: list[int] = []

        for i, it in enumerate(items):
            s = _compute_fit_size_px_for_item(it, thai_path, latin_path, W, H)
            if s is None:
                continue
            per_item_fit[i] = int(s)
            fits.append(int(s))

        if not fits:
            continue
        
        fits.sort()
        p["para_font_size_px"] = int(fits[len(fits) // 2])

        for i, it in enumerate(items):
            fs = per_item_fit.get(i)
            if fs is None:
                continue
            it["font_size_px"] = int(fs)
            for sp in (it.get("spans") or []):
                sp["font_size_px"] = int(fs)

    return tree

def _iter_paragraphs(tree: dict):
    ps = (tree or {}).get("paragraphs") or []
    for i, p in enumerate(ps):
        yield i, p

def _apply_para_font_size(tree: dict, para_sizes: dict[int, int]):
    if not tree:
        return
    for pi, p in _iter_paragraphs(tree):
        sz = para_sizes.get(pi)
        if not sz:
            continue
        p["para_font_size_px"] = int(sz)
        for it in (p.get("items") or []):
            it["font_size_px"] = int(sz)
            for sp in (it.get("spans") or []):
                sp["font_size_px"] = int(sz)

def _compute_shared_para_sizes(trees: list[dict], thai_path: str, latin_path: str, W: int, H: int) -> dict[int, int]:
    sizes: dict[int, int] = {}
    for tree in trees:
        if not tree:
            continue
        for pi, p in _iter_paragraphs(tree):
            for it in (p.get("items") or []):
                fit = _compute_fit_size_px_for_item(
                    it, thai_path, latin_path, W, H)
                if fit is None:
                    continue
                cur = sizes.get(pi)
                sizes[pi] = fit if cur is None else min(cur, fit)

    vals = [v for v in sizes.values() if isinstance(v, int) and v > 0]
    if not vals:
        return sizes
    vals.sort()
    mid = len(vals) // 2
    target = vals[mid] if (len(vals) % 2 == 1) else int(
        round((vals[mid - 1] + vals[mid]) / 2))
    for k in list(sizes.keys()):
        try:
            sizes[k] = int(min(int(sizes[k]), int(target)))
        except Exception:
            pass
    return sizes

def _sanitize_draw_text(s: str) -> str:
    t = (s or "").replace("\r\n", "\n").replace("\r", "\n")
    t = t.replace("\u200b", "").replace("\ufeff", "")
    t = "".join(ch for ch in t if (ch == "\n") or (
        unicodedata.category(ch)[0] != "C"))
    return t

def _token_box_px(t, W, H, pad_px=0):
    b = t.get("box") or {}
    left = int(round(float(b.get("left", 0.0)) * W)) - pad_px
    top = int(round(float(b.get("top", 0.0)) * H)) - pad_px
    right = int(round((float(b.get("left", 0.0)) +
                float(b.get("width", 0.0))) * W)) + pad_px
    bottom = int(
        round((float(b.get("top", 0.0)) + float(b.get("height", 0.0))) * H)) + pad_px
    left = max(0, min(W, left))
    top = max(0, min(H, top))
    right = max(0, min(W, right))
    bottom = max(0, min(H, bottom))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom

def _token_quad_px(t, W, H, pad_px=0, apply_baseline_shift=True):
    if not t.get("valid_text"):
        return None

    p1 = t.get("baseline_p1") or {}
    p2 = t.get("baseline_p2") or {}
    x1 = float(p1.get("x", 0.0)) * W
    y1 = float(p1.get("y", 0.0)) * H
    x2 = float(p2.get("x", 0.0)) * W
    y2 = float(p2.get("y", 0.0)) * H

    dx = x2 - x1
    dy = y2 - y1
    if dx < 0 or (abs(dx) < 1e-12 and dy < 0):
        x1, y1, x2, y2 = x2, y2, x1, y1
        dx = x2 - x1
        dy = y2 - y1

    L = math.hypot(dx, dy)
    if L <= 1e-9:
        return None

    ux = dx / L
    uy = dy / L

    nx = -uy
    ny = ux
    if ny < 0:
        nx, ny = -nx, -ny

    t0 = float(t.get("t0_raw") if t.get("t0_raw") is not None else 0.0)
    t1 = float(t.get("t1_raw") if t.get("t1_raw") is not None else 1.0)

    sx = x1 + ux * (t0 * L)
    sy = y1 + uy * (t0 * L)
    ex = x1 + ux * (t1 * L)
    ey = y1 + uy * (t1 * L)

    h = max(1.0, float(t.get("height_raw") or 0.0) * H)
    if apply_baseline_shift and BASELINE_SHIFT:
        shift = h * BASELINE_SHIFT_FACTOR
        sx += nx * shift
        sy += ny * shift
        ex += nx * shift
        ey += ny * shift

    pad = max(0.0, float(pad_px))
    sx -= ux * pad
    sy -= uy * pad
    ex += ux * pad
    ey += uy * pad

    hh = (h / 2.0) + pad
    ox = nx * hh
    oy = ny * hh

    return [(sx - ox, sy - oy), (ex - ox, ey - oy), (ex + ox, ey + oy), (sx + ox, sy + oy)]

def _token_box_quad_px(t, W, H, pad_px=0):
    b = t.get("box") or {}
    w = float(b.get("width", 0.0)) * W
    h = float(b.get("height", 0.0)) * H
    if w <= 0.0 or h <= 0.0:
        return None

    left = float(b.get("left", 0.0)) * W
    top = float(b.get("top", 0.0)) * H
    cx = left + (w / 2.0)
    cy = top + (h / 2.0)

    hw = (w / 2.0) + float(pad_px)
    hh = (h / 2.0) + float(pad_px)

    angle_deg = float(b.get("rotation_deg", 0.0))
    rad = math.radians(angle_deg)
    c = math.cos(rad)
    s = math.sin(rad)

    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    out = []
    for x, y in corners:
        rx = (x * c) - (y * s)
        ry = (x * s) + (y * c)
        out.append((cx + rx, cy + ry))
    return out

def _quad_bbox(quad, W, H):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    l = max(0, min(W, int(math.floor(min(xs)))))
    t = max(0, min(H, int(math.floor(min(ys)))))
    r = max(0, min(W, int(math.ceil(max(xs)))))
    b = max(0, min(H, int(math.ceil(max(ys)))))
    if r <= l or b <= t:
        return None
    return l, t, r, b

def _median_rgba(pixels):
    if not pixels:
        return None
    rs = sorted(p[0] for p in pixels)
    gs = sorted(p[1] for p in pixels)
    bs = sorted(p[2] for p in pixels)
    a = 255
    mid = len(rs) // 2
    return (rs[mid], gs[mid], bs[mid], a)

def _rel_luminance(rgb):
    r, g, b = rgb

    def lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def _contrast_ratio(l1, l2):
    a = max(l1, l2) + 0.05
    b = min(l1, l2) + 0.05
    return a / b

def _pick_bw_text_color(bg_rgb):
    Lb = _rel_luminance(bg_rgb)
    c_black = _contrast_ratio(Lb, 0.0)
    c_white = _contrast_ratio(Lb, 1.0)
    return TEXT_COLOR_LIGHT if c_white >= c_black else TEXT_COLOR_DARK

def _sample_bg_color_from_quad(base_rgb, quad, rect, border_px=3, margin_px=6):
    l, t, r, b = rect
    w = r - l
    h = b - t
    if w <= 0 or h <= 0:
        return _sample_bg_color(base_rgb, rect, margin_px)
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    qrel = [(x - l, y - t) for x, y in quad]
    d.polygon(qrel, fill=255)
    bp = int(max(0, border_px or 0))
    if bp > 0:
        k = min(w, h)
        bp = min(bp, max(1, (k - 1) // 2))
    if bp > 0:
        er = mask.filter(ImageFilter.MinFilter(size=bp * 2 + 1))
        border = ImageChops.subtract(mask, er)
    else:
        border = mask
    region = base_rgb.crop((l, t, r, b))
    rp = list(region.getdata())
    mp = list(border.getdata())
    samples = [p for p, m in zip(rp, mp) if m > 0]
    if len(samples) < 24:
        ext = _sample_bg_color(base_rgb, rect, margin_px)
        return ext
    med = _median_rgba(samples)
    if med:
        return med[:3]
    return _sample_bg_color(base_rgb, rect, margin_px)

def _sample_bg_color(base_rgb, rect, margin_px):
    W, H = base_rgb.size
    l, t, r, b = rect
    m = max(1, int(margin_px))
    samples = []

    def add_strip(x0, y0, x1, y1):
        x0 = max(0, min(W, x0))
        y0 = max(0, min(H, y0))
        x1 = max(0, min(W, x1))
        y1 = max(0, min(H, y1))
        if x1 <= x0 or y1 <= y0:
            return
        samples.extend(list(base_rgb.crop((x0, y0, x1, y1)).getdata()))
    add_strip(l, t - m, r, t)
    add_strip(l, b, r, b + m)
    add_strip(l - m, t, l, b)
    add_strip(r, t, r + m, b)
    med = _median_rgba(samples)
    if med:
        return med[:3]
    return base_rgb.getpixel((max(0, min(W - 1, l)), max(0, min(H - 1, t))))

def _sample_bg_color_from_quad_ring(base_rgb, quad, rect, ring_px=4):
    W, H = base_rgb.size
    l, t, r, b = rect
    w = r - l
    h = b - t
    if w <= 0 or h <= 0:
        return None

    mask = np.zeros((h, w), dtype=np.uint8)
    pts = np.array([[(x - l, y - t) for x, y in quad]], dtype=np.int32)
    cv2.fillPoly(mask, pts, 255)

    rp = int(max(1, ring_px or 1))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rp * 2 + 1, rp * 2 + 1))
    dil = cv2.dilate(mask, k, iterations=1)
    ring = cv2.bitwise_and(dil, cv2.bitwise_not(mask))

    rgb = np.array(base_rgb.crop((l, t, r, b)).convert("RGB"), dtype=np.uint8)
    sel = rgb[ring > 0]
    if sel.size < 24:
        return None
    med = np.median(sel, axis=0)
    return (int(med[0]), int(med[1]), int(med[2]))

def _pixelate(img, block_px):
    w, h = img.size
    if w <= 1 or h <= 1:
        return img
    block_px = int(block_px or 1)
    if block_px < 1:
        block_px = 1
    sw = max(1, w // block_px)
    sh = max(1, h // block_px)
    return img.resize((sw, sh), resample=Image.NEAREST).resize((w, h), resample=Image.NEAREST)

def _mean_abs_diff(a, b):
    if a.size != b.size:
        return 1e18
    a = a.convert("RGB")
    b = b.convert("RGB")
    da = list(a.getdata())
    db = list(b.getdata())
    if not da:
        return 1e18
    s = 0
    for (ar, ag, ab), (br, bg, bb) in zip(da, db):
        s += abs(ar - br) + abs(ag - bg) + abs(ab - bb)
    return s / (len(da) * 3)

def _resize_small(img, max_w=64, max_h=64):
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    scale = min(max_w / w, max_h / h, 1.0)
    nw = max(1, int(w * scale))
    nh = max(1, int(h * scale))
    return img.resize((nw, nh), resample=Image.BILINEAR)

def _clone_candidate_score(base, rect, cand_rect, direction, border_px):
    W, H = base.size
    l, t, r, b = rect
    cl, ct, cr, cb = cand_rect
    w = r - l
    h = b - t
    if w <= 1 or h <= 1:
        return 1e18
    border_px = max(1, int(border_px or 1))
    if direction == "up":
        a = base.crop((l, max(0, t - border_px), r, t))
        d = base.crop((cl, max(0, cb - border_px), cr, cb))
    elif direction == "down":
        a = base.crop((l, b, r, min(H, b + border_px)))
        d = base.crop((cl, ct, cr, min(H, ct + border_px)))
    elif direction == "left":
        a = base.crop((max(0, l - border_px), t, l, b))
        d = base.crop((max(0, cr - border_px), ct, cr, cb))
    else:
        a = base.crop((r, t, min(W, r + border_px), b))
        d = base.crop((cl, ct, min(W, cl + border_px), cb))
    a = _resize_small(a, 64, 16)
    d = _resize_small(d, 64, 16)
    return _mean_abs_diff(a, d)

def _choose_clone_rect(base, rect, gap_px, border_px):
    W, H = base.size
    l, t, r, b = rect
    w = r - l
    h = b - t
    gap_px = max(0, int(gap_px or 0))
    cands = []
    up = (l, t - gap_px - h, r, t - gap_px)
    down = (l, b + gap_px, r, b + gap_px + h)
    left = (l - gap_px - w, t, l - gap_px, b)
    right = (r + gap_px, t, r + gap_px + w, b)
    for direction, (cl, ct, cr, cb) in [("up", up), ("down", down), ("left", left), ("right", right)]:
        if cl < 0 or ct < 0 or cr > W or cb > H:
            continue
        cand_rect = (cl, ct, cr, cb)
        score = _clone_candidate_score(
            base, rect, cand_rect, direction, border_px)
        cands.append((score, cand_rect))
    if not cands:
        return None
    cands.sort(key=lambda x: x[0])
    return cands[0][1]

def _erase_with_clone(base, rect, mask, gap_px, border_px, feather_px):
    l, t, r, b = rect
    cand = _choose_clone_rect(base, rect, gap_px, border_px)
    if not cand:
        return False
    cl, ct, cr, cb = cand
    donor = base.crop((cl, ct, cr, cb))
    region = base.crop((l, t, r, b))
    feather_px = max(0, int(feather_px or 0))
    if feather_px > 0:
        m = mask.filter(ImageFilter.GaussianBlur(radius=feather_px))
    else:
        m = mask
    merged = Image.composite(donor, region, m)
    base.paste(merged, (l, t))
    return True

def _erase_with_blend_patches(base, rect, mask, gap_px=3, feather_px=4):
    l, t, r, b = rect
    W, H = base.size
    w = r - l
    h = b - t
    if w <= 2 or h <= 2:
        return False
    gap = int(max(0, gap_px))
    candidates = []
    dirs = [(0, -(h + gap)), (0, (h + gap)), (-(w + gap), 0), ((w + gap), 0),
            (-(w + gap), -(h + gap)), ((w + gap), -(h + gap)), (-(w + gap), (h + gap)), ((w + gap), (h + gap))]
    for dx, dy in dirs:
        ll = l + dx
        tt = t + dy
        rr = ll + w
        bb = tt + h
        if ll < 0 or tt < 0 or rr > W or bb > H:
            continue
        candidates.append(base.crop((ll, tt, rr, bb)).convert("RGB"))
    if not candidates:
        return False
    acc = candidates[0]
    for c in candidates[1:]:
        acc = ImageChops.add(acc, c, scale=1.0, offset=0)
    n = len(candidates)
    blended = acc.point(lambda p: int(p / n))
    m = mask
    fp = int(max(0, feather_px))
    if fp > 0:
        m = m.filter(ImageFilter.GaussianBlur(radius=fp))
    region = base.crop((l, t, r, b)).convert("RGB")
    merged = Image.composite(blended, region, m)
    base.paste(merged, (l, t))
    return True

def _erase_with_inpaint(base, box_tokens, pad_px=2):
    if not box_tokens:
        return base

    rgb = base.convert("RGB")
    W, H = rgb.size
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    for t in box_tokens:
        quad = _token_box_quad_px(t, W, H, pad_px=pad_px)
        if not quad:
            quad = _token_quad_px(t, W, H, pad_px=pad_px,
                                  apply_baseline_shift=True)
        if not quad:
            rect = _token_box_px(t, W, H, pad_px=pad_px)
            if not rect:
                continue
            l, tt, r, bb = rect
            quad = [(l, tt), (r, tt), (r, bb), (l, bb)]
        d.polygon(quad, fill=255)

    m = np.array(mask, dtype=np.uint8)
    ys, xs = np.where(m > 0)
    if xs.size == 0 or ys.size == 0:
        return rgb

    l = int(max(0, xs.min() - 8))
    t = int(max(0, ys.min() - 8))
    r = int(min(W, xs.max() + 1 + 8))
    b = int(min(H, ys.max() + 1 + 8))
    if r <= l or b <= t:
        return rgb

    crop_rgb = np.array(rgb.crop((l, t, r, b)), dtype=np.uint8)
    crop_m = m[t:b, l:r]
    dpx = int(max(0, INPAINT_DILATE_PX or 0))
    if dpx > 0:
        k = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (dpx * 2 + 1, dpx * 2 + 1))
        crop_m = cv2.dilate(crop_m, k, iterations=1)

    bgr = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2BGR)
    method = (INPAINT_METHOD or "telea").strip().lower()
    flag = cv2.INPAINT_TELEA if method in ("telea", "t") else cv2.INPAINT_NS
    radius = float(INPAINT_RADIUS or 3)
    out_bgr = cv2.inpaint(bgr, crop_m, radius, flag)
    out_rgb = cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB)

    out = rgb.copy()
    out.paste(Image.fromarray(out_rgb), (l, t))
    return out

def erase_text_with_boxes(img, box_tokens, pad_px=2, sample_margin_px=6, mode=None, mosaic_block_px=None):
    if not box_tokens:
        return img
    mode = (mode or ERASE_MODE or "solid").strip().lower()
    mosaic_block_px = int(mosaic_block_px or ERASE_MOSAIC_BLOCK_PX or 10)
    base = img.convert("RGB").copy()
    if mode in ("inpaint", "cv2", "opencv"):
        return _erase_with_inpaint(base, box_tokens, pad_px=pad_px)
    W, H = base.size
    for t in box_tokens:
        quad = _token_box_quad_px(t, W, H, pad_px=pad_px)
        if not quad:
            quad = _token_quad_px(t, W, H, pad_px=pad_px,
                                  apply_baseline_shift=True)
        if not quad:
            rect = _token_box_px(t, W, H, pad_px=pad_px)
            if not rect:
                continue
            l, tt, r, bb = rect
            quad = [(l, tt), (r, tt), (r, bb), (l, bb)]

        rect = _quad_bbox(quad, W, H)
        if not rect:
            continue

        l, tt, r, bb = rect
        region = base.crop((l, tt, r, bb))
        mask = Image.new("L", (r - l, bb - tt), 0)
        mdraw = ImageDraw.Draw(mask)
        qrel = [(x - l, y - tt) for x, y in quad]
        mdraw.polygon(qrel, fill=255)

        if mode in ("blend_patch", "blend", "avg_patch", "patch"):
            ok = _erase_with_blend_patches(
                base, rect, mask, ERASE_BLEND_GAP_PX, ERASE_BLEND_FEATHER_PX)
            if ok:
                continue
            mode = "solid"

        if mode == "clone":
            ok = _erase_with_clone(
                base, rect, mask, ERASE_CLONE_GAP_PX, ERASE_CLONE_BORDER_PX, ERASE_CLONE_FEATHER_PX)
            if ok:
                continue
            mode = "solid"

        if mode == "mosaic":
            pixelated = _pixelate(region, mosaic_block_px)
            merged = Image.composite(pixelated, region, mask)
            base.paste(merged, (l, tt))
        else:
            color = _sample_bg_color_from_quad(
                base, quad, rect, BG_SAMPLE_BORDER_PX, sample_margin_px)
            region.paste(color, mask=mask)
            base.paste(region, (l, tt))
    return base

def draw_overlay(img, tokens, out_path, thai_path, latin_path, level_outlines=None, font_scale: float = 1.0, fit_to_box: bool = True):
    base = img.convert("RGBA")
    base_rgb = img.convert("RGB")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for ol in (level_outlines or []):
        q = ol.get("quad")
        if not q:
            continue
        col = ol.get("color", BOX_OUTLINE)
        w = int(ol.get("width", 2))
        draw.line(q + [q[0]], fill=col, width=w)

    W, H = base.size

    for t in tokens:
        b = t.get("box") or {}
        box_quad = _token_box_quad_px(t, W, H, pad_px=0)
        use_box_center = False
        if box_quad:
            lq, tq, rq, bq = _quad_bbox(box_quad, W, H)
            box_cx = (lq + rq) / 2.0
            box_cy = (tq + bq) / 2.0
            box_w = max(1.0, float(rq - lq))
            box_h = max(1.0, float(bq - tq))
            use_box_center = True
        else:
            left0 = float(b.get("left", 0.0)) * W
            top0 = float(b.get("top", 0.0)) * H
            box_w = max(1.0, float(b.get("width", 0.0)) * W)
            box_h = max(1.0, float(b.get("height", 0.0)) * H)
            box_cx = left0 + (box_w / 2.0)
            box_cy = top0 + (box_h / 2.0)
        if DRAW_OUTLINE_SPAN and DRAW_BOX_OUTLINE:
            quad = _token_box_quad_px(t, W, H, pad_px=0)
            if quad:
                draw.line(quad + [quad[0]], fill=SPAN_OUTLINE,
                          width=SPAN_OUTLINE_WIDTH)
            else:
                left = b["left"] * W
                top = b["top"] * H
                width = b["width"] * W
                height = b["height"] * H
                draw.rectangle([left, top, left + width, top + height],
                               outline=SPAN_OUTLINE, width=SPAN_OUTLINE_WIDTH)

        text = _sanitize_draw_text(t.get("text") or "")
        if text.strip() == "":
            continue

        p1 = t["baseline_p1"]
        p2 = t["baseline_p2"]
        x1 = float(p1["x"]) * W
        y1 = float(p1["y"]) * H
        x2 = float(p2["x"]) * W
        y2 = float(p2["y"]) * H

        dx = x2 - x1
        dy = y2 - y1
        if dx < 0 or (abs(dx) < 1e-12 and dy < 0):
            x1, y1, x2, y2 = x2, y2, x1, y1
            dx = x2 - x1
            dy = y2 - y1

        L = math.hypot(dx, dy)
        if L <= 1e-9:
            continue

        ux = dx / L
        uy = dy / L

        t0 = float(t.get("t0_raw") if t.get("t0_raw") is not None else 0.0)
        t1 = float(t.get("t1_raw") if t.get("t1_raw") is not None else 1.0)

        sx = x1 + ux * (t0 * L)
        sy = y1 + uy * (t0 * L)
        ex = x1 + ux * (t1 * L)
        ey = y1 + uy * (t1 * L)

        avail_w = box_w
        avail_h = box_h

        if BASELINE_SHIFT and (not use_box_center):
            nx, ny = -uy, ux
            shift = avail_h * BASELINE_SHIFT_FACTOR
            sx += nx * shift
            sy += ny * shift

        angle_deg = float(b.get("rotation_deg", 0.0))

        forced_size = t.get("font_size_px")
        if forced_size is not None:
            final_size = int(
                max(10, round(float(forced_size) * float(font_scale))))
            font = pick_font(text, thai_path, latin_path, final_size)

            if fit_to_box:
                tmpc = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
                dc = ImageDraw.Draw(tmpc)
                try:
                    bbc = dc.textbbox((0, 0), text, font=font, anchor="ls")
                    twc = float(bbc[2] - bbc[0])
                    thc = float(bbc[3] - bbc[1])
                except Exception:
                    twc, thc = dc.textsize(text, font=font)
                    twc = float(twc)
                    thc = float(thc)

                if twc > 0 and thc > 0 and (twc > avail_w or thc > avail_h):
                    s = min(avail_w / twc, avail_h / thc)
                    if s < 1.0:
                        final_size = max(10, int(final_size * s))
                        font = pick_font(
                            text, thai_path, latin_path, final_size)
        else:
            base_size = 96
            font0 = pick_font(text, thai_path, latin_path, base_size)

            tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
            dtmp = ImageDraw.Draw(tmp)
            try:
                bb = dtmp.textbbox((0, 0), text, font=font0, anchor="ls")
                tw = bb[2] - bb[0]
                th = bb[3] - bb[1]
            except Exception:
                tw, th = dtmp.textsize(text, font=font0)

            if tw <= 0 or th <= 0:
                continue

            scale = min(avail_w / tw, avail_h / th)
            final_size = max(10, int(base_size * scale))
            if not fit_to_box:
                final_size = max(10, int(final_size * float(font_scale)))
            font = pick_font(text, thai_path, latin_path, final_size)

        tmp2 = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
        d2 = ImageDraw.Draw(tmp2)
        try:
            bb2 = d2.textbbox((0, 0), text, font=font, anchor="ls")
            tw2 = bb2[2] - bb2[0]
            th2 = bb2[3] - bb2[1]
        except Exception:
            tw2, th2 = d2.textsize(text, font=font)

        side = int(max(tw2, th2, avail_h, avail_w) * 2.2 + 40)
        side = min(side, int(max(W, H) * 4))
        if side < 128:
            side = 128

        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        dc = ImageDraw.Draw(canvas)

        fill = TEXT_COLOR
        if AUTO_TEXT_COLOR:
            q = _token_box_quad_px(t, W, H, pad_px=0)
            if q:
                rr = _quad_bbox(q, W, H)
                if rr:
                    bg = _sample_bg_color_from_quad_ring(
                        base_rgb, q, rr, ring_px=max(2, BG_SAMPLE_BORDER_PX))
                    if bg is None:
                        bg = _sample_bg_color_from_quad(
                            base_rgb, q, rr, BG_SAMPLE_BORDER_PX, ERASE_SAMPLE_MARGIN_PX)
                    fill = _pick_bw_text_color(bg)
            else:
                rr = _token_box_px(t, W, H, pad_px=0)
                if rr:
                    bg = _sample_bg_color(base_rgb, rr, ERASE_SAMPLE_MARGIN_PX)
                    fill = _pick_bw_text_color(bg)

        origin = (side // 2, side // 2)

        p1 = t.get("baseline_p1") or {}
        p2 = t.get("baseline_p2") or {}
        has_baseline = ("x" in p1 and "y" in p1 and "x" in p2 and "y" in p2)

        if has_baseline:
            x1 = float(p1.get("x") or 0.0) * float(W)
            y1 = float(p1.get("y") or 0.0) * float(H)
            x2 = float(p2.get("x") or 0.0) * float(W)
            y2 = float(p2.get("y") or 0.0) * float(H)
            dx = x2 - x1
            dy = y2 - y1
            Lb = float(math.hypot(dx, dy))
            if Lb <= 1e-6:
                Lb = 1.0
            ux = dx / Lb
            uy = dy / Lb
            nx = -uy
            ny = ux

            bb = t.get("box") or {}
            cx = (float(bb.get("left") or 0.0) +
                  float(bb.get("width") or 0.0) / 2.0) * float(W)
            cy = (float(bb.get("top") or 0.0) +
                  float(bb.get("height") or 0.0) / 2.0) * float(H)

            tt = _sanitize_draw_text(text)
            if not tt:
                continue
            font_m = pick_font(tt, thai_path, latin_path, final_size)
            try:
                tw = float(font_m.getlength(tt))
            except Exception:
                tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
                dtmp = ImageDraw.Draw(tmp)
                try:
                    bbm = dtmp.textbbox((0, 0), tt, font=font_m, anchor="ls")
                    tw = float(bbm[2] - bbm[0])
                except Exception:
                    tw, _ = dtmp.textsize(tt, font=font_m)
                    tw = float(tw)

            f_th, f_lat = _get_font_pair(thai_path, latin_path, final_size)
            try:
                a_th, d_th = f_th.getmetrics()
            except Exception:
                a_th, d_th = final_size, int(final_size * 0.25)
            try:
                a_lat, d_lat = f_lat.getmetrics()
            except Exception:
                a_lat, d_lat = final_size, int(final_size * 0.25)
            ascent = float(max(a_th, a_lat))
            descent = float(max(d_th, d_lat))
            center_y_rel = (-ascent + descent) / 2.0

            bx = cx - ux * (tw / 2.0) - nx * center_y_rel
            by = cy - uy * (tw / 2.0) - ny * center_y_rel

            angle_deg = float(math.degrees(math.atan2(dy, dx)))

            _draw_text_baseline_fallback(
                dc, origin, text, thai_path, latin_path, final_size, fill)
            rotated = canvas.rotate(-angle_deg, resample=Image.BICUBIC,
                                    expand=False, center=origin)
            paste_x = int(round(bx - origin[0]))
            paste_y = int(round(by - origin[1]))
            overlay.alpha_composite(rotated, dest=(paste_x, paste_y))
        else:
            _draw_text_centered_fallback(
                dc, origin, text, thai_path, latin_path, final_size, fill)
            rotated = canvas.rotate(-angle_deg, resample=Image.BICUBIC,
                                    expand=False, center=origin)
            paste_x = int(round(box_cx - origin[0]))
            paste_y = int(round(box_cy - origin[1]))
            overlay.alpha_composite(rotated, dest=(paste_x, paste_y))

    out = Image.alpha_composite(base, overlay).convert("RGB")
    out.save(out_path)

def get_lens_data_from_image(image_path, firebase_url, lang):
    ck = _get_firebase_cookie(firebase_url)

    with open(image_path, "rb") as f:
        img_bytes = f.read()

    hdr = {"User-Agent": "Mozilla/5.0", "Referer": "https://lens.google.com/"}
    with httpx.Client(cookies=ck, headers=hdr, follow_redirects=False, timeout=60) as c:
        r = c.post(
            "https://lens.google.com/v3/upload",
            files={"encoded_image": ("file.jpg", img_bytes, "image/jpeg")},
        )
        if r.status_code not in (302, 303):
            raise Exception(f"Upload failed: {r.status_code}\n{r.text}")
        redirect = r.headers["location"]

    u = to_translated(redirect, lang=lang)
    with httpx.Client(cookies=ck, headers=hdr, timeout=60) as c:
        j = c.get(u).text

    data = json.loads(j[5:] if j.startswith(")]}'") else j)
    return data

def _get_firebase_cookie(firebase_url: str):
    u = (firebase_url or '').strip()
    now = time.time()
    cache = _FIREBASE_COOKIE_CACHE
    if cache.get('data') and cache.get('url') == u and (now - float(cache.get('ts') or 0)) < float(FIREBASE_COOKIE_TTL_SEC):
        return cache.get('data')
    r = httpx.get(u, timeout=30)
    ck = r.json()
    cache['ts'] = now
    cache['url'] = u
    cache['data'] = ck
    return ck

def warmup(lang: str = "th") -> dict:
    l = _normalize_lang(lang)
    cookie_ok = False
    try:
        _get_firebase_cookie(FIREBASE_URL)
        cookie_ok = True
    except Exception:
        pass
    thai_font = FONT_THAI_PATH
    latin_font = FONT_LATIN_PATH
    if l == "ja":
        latin_font = FONT_JA_PATH
    elif l in ("zh", "zh-hans", "zh_cn", "zh-cn", "zh_hans"):
        latin_font = FONT_ZH_SC_PATH
    elif l in ("zh-hant", "zh_tw", "zh-tw", "zh_hant"):
        latin_font = FONT_ZH_TC_PATH

    if FONT_DOWNLOD:
        thai_font = ensure_font(thai_font, FONT_THAI_URLS)
        if l == "ja":
            latin_font = ensure_font(latin_font, FONT_JA_URLS)
        elif l in ("zh", "zh-hans", "zh_cn", "zh-cn", "zh_hans"):
            latin_font = ensure_font(latin_font, FONT_ZH_SC_URLS)
        elif l in ("zh-hant", "zh_tw", "zh-tw", "zh_hant"):
            latin_font = ensure_font(latin_font, FONT_ZH_TC_URLS)
        else:
            latin_font = ensure_font(latin_font, FONT_LATIN_URLS)

    _get_font_pair(thai_font or "", latin_font or "", 22)
    _get_font_pair(thai_font or "", latin_font or "", 28)
    return {"ok": True, "lang": l, "thai_font": thai_font or "", "latin_font": latin_font or "", "cookie_ok": cookie_ok}

def main():
    data = get_lens_data_from_image(IMAGE_PATH, FIREBASE_URL, LANG)

    img = Image.open(IMAGE_PATH).convert("RGB")
    W, H = img.size

    thai_font = FONT_THAI_PATH
    latin_font = FONT_LATIN_PATH

    lang = _normalize_lang(LANG)

    if lang == "ja":
        latin_font = FONT_JA_PATH
    elif lang in ("zh", "zh-hans", "zh_cn", "zh-cn", "zh_hans"):
        latin_font = FONT_ZH_SC_PATH
    elif lang in ("zh-hant", "zh_tw", "zh-tw", "zh_hant"):
        latin_font = FONT_ZH_TC_PATH

    if FONT_DOWNLOD:
        thai_font = ensure_font(thai_font, FONT_THAI_URLS)
        if lang == "ja":
            latin_font = ensure_font(latin_font, FONT_JA_URLS)
        elif lang in ("zh", "zh-hans", "zh_cn", "zh-cn", "zh_hans"):
            latin_font = ensure_font(latin_font, FONT_ZH_SC_URLS)
        elif lang in ("zh-hant", "zh_tw", "zh-tw", "zh_hant"):
            latin_font = ensure_font(latin_font, FONT_ZH_TC_URLS)
        else:
            latin_font = ensure_font(latin_font, FONT_LATIN_URLS)

    image_url = data.get("imageUrl") if isinstance(data, dict) else None
    image_datauri = ""
    if DECODE_IMAGEURL_TO_DATAURI and image_url:
        image_datauri = decode_imageurl_to_datauri(image_url)

    out = {
        "imageUrl": image_url,
        "imageDataUri": image_datauri,
        "originalContentLanguage": data.get("originalContentLanguage"),
        "originalTextFull": data.get("originalTextFull"),
        "translatedTextFull": data.get("translatedTextFull"),
        "AiTextFull": "",
        "originalParagraphs": data.get("originalParagraphs") or [],
        "translatedParagraphs": data.get("translatedParagraphs") or [],
        "original": {},
        "translated": {},
        "Ai": {},
    }
    original_span_tokens = None
    original_tree = None
    translated_tree = None

    def _base_img_for_overlay() -> Image.Image:
        if not (ERASE_OLD_TEXT_WITH_ORIGINAL_BOXES and original_span_tokens):
            return img
        return erase_text_with_boxes(
            img,
            original_span_tokens,
            pad_px=ERASE_PADDING_PX,
            sample_margin_px=ERASE_SAMPLE_MARGIN_PX,
        )

    if DO_ORIGINAL:
        tree, _ = decode_tree(
            data.get("originalParagraphs") or [],
            data.get("originalTextFull") or "",
            "original",
            W,
            H,
            want_raw=False,
        )
        original_tree = tree
        original_span_tokens = flatten_tree_spans(tree)
        out["original"] = {"originalTree": tree}
        if DO_ORIGINAL_HTML:
            out["original"]["originalhtml"] = tokens_to_html(
                original_span_tokens)

        if DRAW_OVERLAY_ORIGINAL:
            base_img = _base_img_for_overlay()
            draw_overlay(
                base_img,
                original_span_tokens,
                OVERLAY_ORIGINAL_PATH,
                thai_font or "",
                latin_font or "",
                level_outlines=build_level_outlines(original_tree, W, H),
            )

    if DO_AI and original_tree is None:
        tree0, _ = decode_tree(
            data.get("originalParagraphs") or [],
            data.get("originalTextFull") or "",
            "original",
            W,
            H,
            want_raw=False,
        )
        original_tree = tree0

    if DO_TRANSLATED:
        tree, _ = decode_tree(
            data.get("translatedParagraphs") or [],
            data.get("translatedTextFull") or "",
            "translated",
            W,
            H,
            want_raw=False,
        )
        translated_tree = tree
        out["translated"] = {"translatedTree": tree}
        translated_span_tokens = flatten_tree_spans(tree)
        if DO_TRANSLATED_HTML:
            out["translated"]["translatedhtml"] = tokens_to_html(
                translated_span_tokens)

        if DRAW_OVERLAY_TRANSLATED:
            base_img = _base_img_for_overlay()
            draw_overlay(
                base_img,
                translated_span_tokens,
                OVERLAY_TRANSLATED_PATH,
                thai_font or "",
                latin_font or "",
                level_outlines=build_level_outlines(tree, W, H),
                font_scale=TRANSLATED_OVERLAY_FONT_SCALE,
                fit_to_box=TRANSLATED_OVERLAY_FIT_TO_BOX,
            )

    ai = None
    if DO_AI:
        src_text = out.get("originalTextFull") or ""
        if not src_text:
            src_text = data.get("originalTextFull") or ""

        tree_for_boxes = translated_tree or original_tree
        if tree_for_boxes is None:
            tree_for_boxes, _ = decode_tree(
                data.get("originalParagraphs") or [],
                data.get("originalTextFull") or "",
                "original",
                W,
                H,
                want_raw=False,
            )
            original_tree = tree_for_boxes

        ai = ai_translate_original_text(
            src_text,
            LANG,
        )

        template_tree = translated_tree
        patched = patch({"Ai": {"aiTextFull": str(ai.get(
            "aiTextFull") or ""), "aiTree": template_tree}}, W, H, thai_font, latin_font)
        ai_tree = (patched.get("Ai") or {}).get("aiTree") or {}

        ai["aiTree"] = ai_tree

        shared_para_sizes = _compute_shared_para_sizes(
            [original_tree or {}, translated_tree or {}, ai_tree or {}],
            thai_font or "",
            latin_font or "",
            W,
            H,
        )
        _apply_para_font_size(original_tree or {}, shared_para_sizes)
        _apply_para_font_size(translated_tree or {}, shared_para_sizes)
        _apply_para_font_size(ai_tree or {}, shared_para_sizes)

        _rebuild_ai_spans_after_font_resize(
            ai_tree or {}, W, H, thai_font or "", latin_font or "")

        out["AiTextFull"] = str(ai.get("aiTextFull") or "")
        out["Ai"] = {
            "aiTextFull": str(ai.get("aiTextFull") or ""),
            "aiTree": ai_tree,
        }

        if DO_AI_HTML:
            if AI_OVERLAY_FIT_TO_BOX:
                fit_tree_font_sizes_for_tp_html(
                    ai_tree or {}, thai_font or "", latin_font or "", W, H)
            out["Ai"]["aihtml"] = ai_tree_to_tp_html(ai_tree, W, H)
            out["Ai"]["aihtmlCss"] = tp_overlay_css()
            out["Ai"]["aihtmlMeta"] = {
                "baseW": int(W),
                "baseH": int(H),
                "format": "tp",
            }

        if DO_AI_OVERLAY and translated_tree is not None:
            base_img = _base_img_for_overlay()
            tokens_for_draw = flatten_tree_spans(ai_tree)
            draw_overlay(
                base_img,
                tokens_for_draw,
                AI_PATH_OVERLAY,
                thai_font or "",
                latin_font or "",
                level_outlines=build_level_outlines(ai_tree, W, H),
                font_scale=AI_OVERLAY_FONT_SCALE,
                fit_to_box=AI_OVERLAY_FIT_TO_BOX,
            )

    if HTML_INCLUDE_CSS and (DO_ORIGINAL_HTML or DO_TRANSLATED_HTML or DO_AI_HTML):
        out["htmlCss"] = overlay_css()
        out["htmlMeta"] = {
            "containerClass": "RTMDre",
            "tokenClass": "IwqbBf",
            "sourceWidth": int(W),
            "sourceHeight": int(H),
        }

    if "htmlMeta" not in out:
        out["htmlMeta"] = {
            "containerClass": "RTMDre",
            "tokenClass": "IwqbBf",
            "sourceWidth": int(W),
            "sourceHeight": int(H),
        }

    if WRITE_OUT_JSON:
        with open(OUT_JSON, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()
