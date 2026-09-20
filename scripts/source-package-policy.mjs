export function isEditorArtifact(entryName) {
  const parts = String(entryName || "").replaceAll("\\", "/").split("/");
  return parts.some(name => /(?:\.(?:tmp|swp|swo|orig|rej)|~)$/i.test(name) ||
    /^\.#[^/]+$/.test(name) || /^#[^/]+#$/.test(name) ||
    [".DS_Store", "Thumbs.db", ".rsync-tmp"].includes(name));
}
export function isPrivateRuntimeArtifact(entryName) {
  const path = String(entryName || "").replaceAll("\\", "/");
  return /(?:^|\/)\.env(?:$|\.(?!example$|sample$)[^/]+$)/i.test(path) ||
    /(?:\.sqlite3?|\.db)(?:-(?:wal|shm|journal))?$/i.test(path);
}
export function isForbiddenProjectArchiveEntry(entryName) {
  const normalized = String(entryName || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  return isEditorArtifact(normalized) || isPrivateRuntimeArtifact(normalized) || /^(?:(?:e2e|launcher)(?:\/|$)|api\/(?:tests|logs|state)(?:\/|$))/i.test(normalized);
}
