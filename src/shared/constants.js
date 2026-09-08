/**
 * Constants shared across the extension (API paths, defaults, fallbacks).
 *
 */

import { cloudRatePresets } from "./ai/providers/cloud-registry.js";

/** REST/meta endpoints on the TextPhantom API. */
export const API_PATHS = {
  HEALTH: "/health",
  META: "/meta",
  WARMUP: "/warmup",
  TRANSLATE: "/translate",
  TRANSLATE_CANCEL: "/translate/cancel",
  TRANSLATE_POLL: "/translate/poll",
  // v1: one request, one result. TRANSLATE/TRANSLATE_POLL above are the legacy
  // submit+poll pair, kept so an updated extension still works against a
  // server that has not been deployed yet.
  CAPABILITIES: "/v1/capabilities",
  TRANSLATE_V1: "/v1/translate",
  // No LENS_DECODE. The protobuf decode runs in the service worker now
  // (`src/shared/lens-tree.js`, `README.md#architecture-and-ownership`). The server route
  // still exists for older builds, but nothing in this one calls it, and a
  // constant for a path we never request is a wrong answer to "what does the
  // extension talk to?".
  // Service 1: the API uploads to Lens and returns the response UNDECODED, so
  // the service worker can decode it with `src/shared/lens-tree.js`. A browser
  // cannot do this upload itself; see `README.md#architecture-and-ownership`.
  LENS_RAW: "/v1/lens/raw",
  // Service 3: text units only. The image/tree stays in the extension.
  AI_TRANSLATE_V1: "/v1/ai/translate",
  // Canonical engine-owned routes. Grouping has no compatibility alias: its
  // raw-to-document contract belongs exclusively to runs:Extension.
  ENGINE_EXTENSION_LENS_RAW: "/v2/engine/runsextension/lens/raw",
  ENGINE_EXTENSION_GROUPS: "/v2/engine/runsextension/groups",
  ENGINE_EXTENSION_AI_TRANSLATE: "/v2/engine/runsextension/ai/translate",
  ENGINE_API_TRANSLATE: "/v2/engine/runsapi/translate",
  AI_RESOLVE: "/ai/resolve",
  AI_PROBE: "/ai/probe",
  AI_PROMPT_DEFAULT: "/ai/prompt/default",
};

/** Select an engine-owned route only when the server explicitly advertises it. */
export function engineApiPath(capabilities, canonicalPath, compatibilityAlias) {
  return capabilities?.engineRoutesV2 === true
    ? canonicalPath
    : compatibilityAlias;
}

/** Translation modes shown in the popup. */
export const MODES = [
  { id: "lens_images", name: "Google Lens (image)", needLang: true },
  { id: "lens_text", name: "Google Lens (text)", needLang: true },
];

/** Overlay sources for `lens_text` mode. */
export const FALLBACK_SOURCES = [
  { id: "original", name: "Original" },
  { id: "translated", name: "Translated" },
  { id: "ai", name: "Ai" },
];

/** Stored-settings defaults. */
export const DEFAULT_MODE = "lens_text";
export const DEFAULT_LANG = "en";
export const DEFAULT_SOURCE = "translated";

/** Client-side cap. 0 = unlimited submit; server split queues own backpressure. */
export const DEFAULT_MAX_CONCURRENCY = 0;

/**
 * How the content script encodes a canvas-captured page before uploading it.
 *
 * PNG was the original behaviour and is lossless, but a full manga page costs
 * 5-15 MB — base64'd (+33%) through the service worker, over the wire, and
 * then decoded by the API container, where on a 2-vCPU box that decode is the
 * heaviest thing the direct lane does before translation even starts. WebP
 * q92 is visually equivalent at OCR resolution and 15-25x smaller.
 *
 * Set `uploadFormat` to "png" to restore the lossless upload. The API accepts
 * any of these, so this switch is independent of the server's own
 * TP_LENS_DIRECT_IMG_FORMAT (which governs the RESULT background, not the
 * upload). Mirrored in content/payload.js — content scripts are classic
 * scripts and cannot import this module, so keep both in sync.
 */
export const DEFAULT_UPLOAD_FORMAT = "webp";
export const DEFAULT_UPLOAD_QUALITY = 0.92;
export const UPLOAD_FORMATS = ["webp", "png", "jpeg"];

/**
 * Relayout default — rebuild the Translated overlay's boxes when the source
 * page reads on the other axis from the target language (vertical Japanese ->
 * horizontal Thai). ON, because an unreadable 90°-rotated overlay is never the
 * better default, and the work only happens on pages that change axis.
 */
export const DEFAULT_RELAYOUT_TRANSLATED = true;

/**
 * Manual Cloud-AI request pacing is opt-in. Provider quotas, the image queue,
 * bounded concurrency and real 429 responses remain active on a fresh install.
 */
export const DEFAULT_RATE_LIMIT_ENABLED = false;
export const DEFAULT_RATE_RPM = 30;
export const DEFAULT_RATE_BURST = 4;

/**
 * Hard bounds for the rate inputs. These exist to stop a typo from breaking
 * translation silently: 1000000 RPM is not "no limit", it just guarantees the
 * provider answers 429 and the whole batch fails; 0.5 RPM would pace one page
 * every two minutes and look like a hang.
 */
export const RATE_RPM_MIN = 1;
export const RATE_RPM_MAX = 600;
export const RATE_BURST_MIN = 1;
export const RATE_BURST_MAX = 60;

export const RATE_PRESETS = Object.freeze(cloudRatePresets());

/** Fallback policy for providers not listed above. */
export const RATE_PRESET_DEFAULT = { rpm: 30, burst: 4 };

/** Port name used by the content-script keep-alive connection. */
export const KEEPALIVE_PORT_NAME = "TP_KEEPALIVE";

/**
 * Popular languages pinned to the top of the language picker, in this exact
 * order. Everything else is listed alphabetically by name after these.
 * Codes are matched case-insensitively against each entry's `code`.
 * @type {string[]}
 */
export const PINNED_LANG_CODES = ["en", "th", "ja", "ko", "zh-CN", "zh-TW"];

/** Languages shown when the API's `/meta` is unreachable. */
export const FALLBACK_LANGS = [
  { code: "en", name: "English" },
  { code: "th", name: "Thai" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "zh-TW", name: "Chinese (Traditional)" },
  { code: "vi", name: "Vietnamese" },
  { code: "id", name: "Indonesian" },
  { code: "ms", name: "Malay" },
  { code: "tl", name: "Tagalog" },
  { code: "fil", name: "Filipino" },
  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "ur", name: "Urdu" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "ml", name: "Malayalam" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "kn", name: "Kannada" },
  { code: "pa", name: "Punjabi" },
  { code: "ne", name: "Nepali" },
  { code: "si", name: "Sinhala" },
  { code: "my", name: "Myanmar (Burmese)" },
  { code: "km", name: "Khmer" },
  { code: "lo", name: "Lao" },
  { code: "jv", name: "Javanese" },
  { code: "su", name: "Sundanese" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "cs", name: "Czech" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "hr", name: "Croatian" },
  { code: "sr", name: "Serbian" },
  { code: "bs", name: "Bosnian" },
  { code: "bg", name: "Bulgarian" },
  { code: "mk", name: "Macedonian" },
  { code: "el", name: "Greek" },
  { code: "tr", name: "Turkish" },
  { code: "hu", name: "Hungarian" },
  { code: "fi", name: "Finnish" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "no", name: "Norwegian" },
  { code: "et", name: "Estonian" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },
  { code: "is", name: "Icelandic" },
  { code: "ga", name: "Irish" },
  { code: "cy", name: "Welsh" },
  { code: "mt", name: "Maltese" },
  { code: "sq", name: "Albanian" },
  { code: "hy", name: "Armenian" },
  { code: "ka", name: "Georgian" },
  { code: "az", name: "Azerbaijani" },
  { code: "kk", name: "Kazakh" },
  { code: "ky", name: "Kyrgyz" },
  { code: "tg", name: "Tajik" },
  { code: "uz", name: "Uzbek" },
  { code: "tk", name: "Turkmen" },
  { code: "mn", name: "Mongolian" },
  { code: "ar", name: "Arabic" },
  { code: "fa", name: "Persian" },
  { code: "iw", name: "Hebrew" },
  { code: "ps", name: "Pashto" },
  { code: "ug", name: "Uyghur" },
  { code: "ku", name: "Kurdish (Kurmanji)" },
  { code: "sw", name: "Swahili" },
  { code: "am", name: "Amharic" },
  { code: "ha", name: "Hausa" },
  { code: "ig", name: "Igbo" },
  { code: "yo", name: "Yoruba" },
  { code: "zu", name: "Zulu" },
  { code: "xh", name: "Xhosa" },
  { code: "so", name: "Somali" },
  { code: "rw", name: "Kinyarwanda" },
  { code: "mg", name: "Malagasy" },
  { code: "af", name: "Afrikaans" },
  { code: "ca", name: "Catalan" },
  { code: "eu", name: "Basque" },
  { code: "gl", name: "Galician" },
  { code: "eo", name: "Esperanto" },
  { code: "be", name: "Belarusian" },
  { code: "ceb", name: "Cebuano" },
  { code: "co", name: "Corsican" },
  { code: "fy", name: "Frisian" },
  { code: "haw", name: "Hawaiian" },
  { code: "hmn", name: "Hmong" },
  { code: "ht", name: "Haitian Creole" },
  { code: "lb", name: "Luxembourgish" },
  { code: "la", name: "Latin" },
  { code: "mi", name: "Maori" },
  { code: "or", name: "Odia (Oriya)" },
  { code: "gd", name: "Scots Gaelic" },
  { code: "sm", name: "Samoan" },
  { code: "sn", name: "Shona" },
  { code: "st", name: "Sesotho" },
  { code: "sd", name: "Sindhi" },
  { code: "tt", name: "Tatar" },
  { code: "yi", name: "Yiddish" },
  { code: "ny", name: "Chichewa" },
];

import { isNamedLocalProvider } from "./ai/providers/local-registry.js";
import { isLocalHostUrl as providerLocalHostUrl } from "./ai/providers/local-spec.js";

export function isLocalAiProvider(provider) {
  const id = String(provider || "")
    .trim()
    .toLowerCase();
  return isNamedLocalProvider(id) || id === "customlocal";
}

// Mirrors the API server's is_local_target(): named local providers or an
// exact loopback destination. This intentionally excludes bind addresses,
// LAN suffix guesses and hostnames that merely contain "localhost".
export function isLocalAiTarget(provider, baseUrl = "") {
  if (isLocalAiProvider(provider)) return true;
  let host = "";
  try {
    host = new URL(String(baseUrl || "").trim()).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

// Returns whether a URL points at this machine or the local network.
export function isLocalHostUrl(url) {
  return providerLocalHostUrl(url);
}
