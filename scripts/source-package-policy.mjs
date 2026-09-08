export function isEditorArtifact(entryName) {
  const parts = String(entryName || "").replaceAll("\\", "/").split("/");
  return parts.some(name => /(?:\.(?:tmp|swp|swo|orig|rej)|~)$/i.test(name) ||
    /^\.#[^/]+$/.test(name) || /^#[^/]+#$/.test(name) ||
    [".DS_Store", "Thumbs.db", ".rsync-tmp"].includes(name));
}
export function isForbiddenProjectArchiveEntry(entryName) {
  const normalized = String(entryName || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  return isEditorArtifact(normalized) || /^(?:(?:e2e|launcher)(?:\/|$)|api\/(?:tests|logs|state)(?:\/|$))/i.test(normalized);
}
