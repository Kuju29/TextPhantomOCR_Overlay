/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * IndexedDB-backed store for the local image viewer.
 *
 * The popup can open local images / a folder; those files are saved as a
 * "session" here and the viewer tab loads them back by id. Blobs are stored
 * directly (IndexedDB handles them natively).
 */

const DB_NAME = "textphantom_local_gallery";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

let dbPromise = null;

/** Open (or upgrade) the database, memoised. */
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

/** Resolve once a transaction has fully committed. */
function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("indexeddb_tx_aborted"));
    tx.onerror = () => reject(tx.error || new Error("indexeddb_tx_failed"));
  });
}

const trim = (v) => String(v || "").trim();

/**
 * True when a `webkitRelativePath` points DIRECTLY inside the picked folder.
 * "" (plain multi-file picker) counts as top-level; "Folder/img.jpg" is
 * top-level; "Folder/sub/img.jpg" is not. Splits on / and \ to be safe.
 */
export function isTopLevelRelativePath(relativePath) {
  const rel = trim(relativePath);
  if (!rel) return true;
  return rel.split(/[\\/]+/).filter(Boolean).length <= 2;
}

/** Locale-aware natural comparison (handles "page2" < "page10"). */
export function naturalCompare(a, b) {
  return new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare(
    String(a || ""),
    String(b || ""),
  );
}

/** Sort pages by relative path / name (natural order). */
export function sortLocalPages(pages) {
  return [...(Array.isArray(pages) ? pages : [])].sort((a, b) => {
    const byPath = naturalCompare(
      trim(a?.relativePath || a?.name || a?.id),
      trim(b?.relativePath || b?.name || b?.id),
    );
    return byPath || naturalCompare(a?.id, b?.id);
  });
}

/** Build a page record from a picked `File`. */
export function toLocalPageRecord(file, index = 0) {
  return {
    id: crypto.randomUUID(),
    name: trim(file?.name) || `image-${index + 1}`,
    relativePath: trim(file?.webkitRelativePath || ""),
    type: trim(file?.type) || "application/octet-stream",
    size: Number(file?.size) || 0,
    lastModified: Number(file?.lastModified) || 0,
    blob: file,
  };
}

/**
 * Keep only image files from a FileList.
 *
 * `topLevelOnly` (folder picker): keep only files sitting DIRECTLY in the
 * selected folder. A `webkitdirectory` FileList recursively includes every
 * subfolder's files, whose `webkitRelativePath` has extra "/" segments
 * ("Folder/sub/img.jpg" vs "Folder/img.jpg"), so depth > 1 is filtered out.
 */
export function filterImageFiles(files, { topLevelOnly = false } = {}) {
  return [...(files || [])].filter((file) => {
    if (!trim(file?.type).toLowerCase().startsWith("image/")) return false;
    if (topLevelOnly && !isTopLevelRelativePath(file?.webkitRelativePath)) return false;
    return true;
  });
}

/** Persist (create or replace) a viewer session. */
export async function saveLocalSession(session) {
  const db = await openDb();
  const record = {
    id: trim(session?.id) || crypto.randomUUID(),
    createdAt: Number(session?.createdAt) || Date.now(),
    title: trim(session?.title),
    pages: Array.isArray(session?.pages) ? [...session.pages] : [],
  };
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(record);
  await txComplete(tx);
  return record;
}

/** Load a viewer session by id (null when missing). */
export async function loadLocalSession(id) {
  const key = trim(id);
  if (!key) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("indexeddb_get_failed"));
  });
}

/** Delete a viewer session by id. */
export async function deleteLocalSession(id) {
  const key = trim(id);
  if (!key) return;
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).delete(key);
  await txComplete(tx);
}
