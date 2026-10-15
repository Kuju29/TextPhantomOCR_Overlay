import path from 'node:path';
import {fileURLToPath} from 'node:url';
const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pathIdentity=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
function configuredPrivateFile(entryName){
  const candidate=pathIdentity(path.resolve(projectRoot,entryName));
  return ['TP_MASTER_KEY_FILE','TP_CENTER_GATEWAY_KEY_FILE'].some(name=>{
    const configured=String(process.env[name]||'').trim();
    return configured&&candidate===pathIdentity(configured);
  });
}

export function isEditorArtifact(entryName) {
  const parts = String(entryName || "").replaceAll("\\", "/").split("/");
  return parts.some(name => /(?:\.(?:tmp|swp|swo|orig|rej)|~)$/i.test(name) ||
    /^\.#[^/]+$/.test(name) || /^#[^/]+#$/.test(name) ||
    [".DS_Store", "Thumbs.db", ".rsync-tmp"].includes(name));
}
export function isPrivateRuntimeArtifact(entryName) {
  const path = String(entryName || "").replaceAll("\\", "/");
  return configuredPrivateFile(path) || /(?:^|\/)\.env(?:$|\.(?!example$|sample$)[^/]+$)/i.test(path) ||
    /(?:^|\/)(?:\.login-state|\.login-bridge)(?:\/|$)/i.test(path) ||
    /(?:^|\/)(?:session\.key|sessions\.enc|client\.key|management\.key)$/i.test(path) ||
    /(?:^|\/)(?:master\.key|gateway\.key|bootstrap-token\.txt)$/i.test(path) ||
    /(?:^|\/)(?:id_rsa|id_ed25519)$/i.test(path) ||
    /\.(?:key|pem|p12|pfx)$/i.test(path) ||
    /(?:\.sqlite3?|\.db)(?:-(?:wal|shm|journal))?$/i.test(path);
}
export function isForbiddenProjectArchiveEntry(entryName) {
  const normalized = String(entryName || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  return isEditorArtifact(normalized) || isPrivateRuntimeArtifact(normalized) || /^(?:(?:e2e|launcher)(?:\/|$)|api\/(?:tests|logs|state|data)(?:\/|$))/i.test(normalized) ||
    /(?:^|\/)(?:node_modules|__pycache__)(?:\/|$)/i.test(normalized);
}
