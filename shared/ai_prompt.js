export function promptKey(lang, model) {
  const l = String(lang || "en").trim() || "en";
  const m = String(model || "auto").trim() || "auto";
  return `${l}::${m}`;
}

export function sanitizeAiPrompt(raw, { maxChars = 1200 } = {}) {
  let s = typeof raw === "string" ? raw : String(raw || "");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.trim();
  if (!s) return "";
  s = s.replace(/[\t ]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd();
  return s;
}
