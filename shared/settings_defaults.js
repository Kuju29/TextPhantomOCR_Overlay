export const DEFAULT_MODE = "lens_text";
export const DEFAULT_LANG = "en";
export const DEFAULT_SOURCE = "translated";

export function normalizeMode(value) {
  const v = String(value || "").trim();
  return v === "lens_images" || v === "lens_text" ? v : DEFAULT_MODE;
}

export function normalizeLang(value) {
  return String(value || "").trim() || DEFAULT_LANG;
}

export function normalizeSource(value) {
  const v = String(value || "").trim().toLowerCase();
  return v || DEFAULT_SOURCE;
}
