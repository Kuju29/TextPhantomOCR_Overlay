const DB_NAME = "textphantom_local_gallery";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const IMAGE_PREFIX = "image/";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexeddb_open_failed"));
  });
  return dbPromise;
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("indexeddb_tx_aborted"));
    tx.onerror = () => reject(tx.error || new Error("indexeddb_tx_failed"));
  });
}

function trimString(v) {
  return String(v || "").trim();
}

export function naturalCompare(a, b) {
  return new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  }).compare(String(a || ""), String(b || ""));
}

export function sortLocalPages(pages) {
  return [...(Array.isArray(pages) ? pages : [])].sort((a, b) => {
    const pa = trimString(a?.relativePath || a?.name || a?.id);
    const pb = trimString(b?.relativePath || b?.name || b?.id);
    const byPath = naturalCompare(pa, pb);
    if (byPath) return byPath;
    return naturalCompare(a?.id, b?.id);
  });
}

export function toLocalPageRecord(file, index = 0) {
  const name = trimString(file?.name) || `image-${index + 1}`;
  const type = trimString(file?.type) || "application/octet-stream";
  const relativePath = trimString(file?.webkitRelativePath || "");
  return {
    id: crypto.randomUUID(),
    name,
    relativePath,
    type,
    size: Number(file?.size) || 0,
    lastModified: Number(file?.lastModified) || 0,
    blob: file,
  };
}

export function filterImageFiles(files) {
  return [...(files || [])].filter((file) => {
    const type = trimString(file?.type).toLowerCase();
    return type.startsWith(IMAGE_PREFIX);
  });
}

export async function saveLocalSession(session) {
  const db = await openDb();
  const record = {
    id: trimString(session?.id) || crypto.randomUUID(),
    createdAt: Number(session?.createdAt) || Date.now(),
    title: trimString(session?.title),
    pages: Array.isArray(session?.pages) ? [...session.pages] : [],
  };
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(record);
  await txComplete(tx);
  return record;
}

export async function loadLocalSession(id) {
  const key = trimString(id);
  if (!key) return null;
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("indexeddb_get_failed"));
  });
}

export async function deleteLocalSession(id) {
  const key = trimString(id);
  if (!key) return;
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(key);
  await txComplete(tx);
}
