/**
 *
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

/**
 * Extensions the browser decodes as images.
 *
 * Only consulted when the OS handed back an EMPTY MIME type, which Windows
 * does for formats it has no registry entry for (.webp / .avif / .jxl are the
 * usual ones). A file that reports a NON-image MIME is never accepted on the
 * strength of its name, and a file with neither a MIME nor a known image
 * extension is dropped rather than guessed at.
 */
const IMAGE_EXTENSIONS = new Set([
  "apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jfif", "jpe", "jpeg",
  "jpg", "jxl", "pjp", "pjpeg", "png", "svg", "tif", "tiff", "webp",
]);

/**
 * True when a filename has an extension we intentionally treat as an image.
 *
 * Directory handles expose the child name before a File object is requested,
 * so this check lets us avoid opening non-image files at all.
 */
export function hasImageExtension(name) {
  const value = trim(name).toLowerCase();
  const dot = value.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(value.slice(dot + 1));
}

/**
 * True when a picked `File` is an image file.
 *
 * The picker is told `accept="image/*"`, but that is a hint the user can
 * override in the OS dialog, and a folder pick is not filtered by it at all —
 * so "images only" is decided here, for both pickers.
 * @param {File} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  const mime = trim(file?.type).toLowerCase();
  if (mime) return mime.startsWith("image/");
  return hasImageExtension(file?.name);
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

/**
 * Build a page record from a picked `File`.
 *
 * `relativePath` is supplied by the directory picker, whose files carry no
 * `webkitRelativePath` of their own — it is what the sidebar shows under each
 * page name, so the two pickers produce the same-looking list.
 */
export function toLocalPageRecord(file, index = 0, relativePath = "") {
  return {
    id: crypto.randomUUID(),
    name: trim(file?.name) || `image-${index + 1}`,
    relativePath: trim(relativePath) || trim(file?.webkitRelativePath || ""),
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
    if (!isImageFile(file)) return false;
    if (topLevelOnly && !isTopLevelRelativePath(file?.webkitRelativePath)) return false;
    return true;
  });
}

/**
 * Read only image files that sit DIRECTLY inside a FileSystemDirectoryHandle.
 *
 * This is the preferred folder path because non-image children are rejected by
 * name before `getFile()` is called. Subdirectories are counted but never
 * traversed. In Chromium browsers that expose `showDirectoryPicker()`, this
 * avoids the recursive FileList produced by `<input webkitdirectory>`.
 *
 * @param {FileSystemDirectoryHandle|object} directoryHandle
 * @returns {Promise<{files: File[], folderName: string, relativePaths: string[],
 *   scanned: number, skipped: number, subfolders: number}>}
 */
export async function imagesFromDirectoryHandle(directoryHandle) {
  const files = [];
  const relativePaths = [];
  const folderName = trim(directoryHandle?.name);
  let scanned = 0;
  let skipped = 0;
  let subfolders = 0;

  if (!directoryHandle || typeof directoryHandle.values !== "function") {
    throw new TypeError("directory_handle_unavailable");
  }

  for await (const child of directoryHandle.values()) {
    if (child?.kind === "directory") {
      subfolders++;
      continue;
    }
    if (child?.kind !== "file") continue;

    scanned++;
    // Crucial: do not call getFile() for non-images. The filename is enough to
    // reject them, so their contents are never opened by TextPhantom.
    if (!hasImageExtension(child.name)) {
      skipped++;
      continue;
    }

    const file = await child.getFile();
    if (!isImageFile(file)) {
      skipped++;
      continue;
    }
    files.push(file);
    relativePaths.push(folderName ? `${folderName}/${file.name}` : file.name);
  }

  return { files, folderName, relativePaths, scanned, skipped, subfolders };
}

/**
 * Open the browser's native directory picker when the File System Access API is
 * available. The picker must be called from a user gesture.
 *
 * Brave currently disables this API, so callers should fall back to the hidden
 * `webkitdirectory` input there. The result distinguishes unsupported from a
 * normal user cancellation so cancellation never opens a second picker.
 *
 * @returns {Promise<{supported: boolean, cancelled: boolean, result?: object, error?: Error}>}
 */
export async function pickImageDirectory(options = {}) {
  if (typeof globalThis.showDirectoryPicker !== "function") {
    return { supported: false, cancelled: false };
  }

  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({
      id: trim(options.id) || "textphantom-local-images",
      mode: "read",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { supported: true, cancelled: true };
    }
    return { supported: true, cancelled: false, error };
  }

  try {
    return {
      supported: true,
      cancelled: false,
      result: await imagesFromDirectoryHandle(handle),
    };
  } catch (error) {
    return { supported: true, cancelled: false, error };
  }
}

/**
 * Take the dropped items' filesystem entries.
 *
 * MUST be called synchronously inside the `drop` handler: the item list is
 * emptied the moment the handler yields, so awaiting anything first leaves
 * nothing to read.
 *
 * @returns {Array<object>} FileSystemEntry objects, or [] where the browser has
 *   no entries API (then the caller uses `dataTransfer.files` instead).
 */
export function dropEntriesFrom(dataTransfer) {
  return [...(dataTransfer?.items || [])]
    .map((item) => (typeof item?.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
}

/** One directory listing may need many `readEntries` calls; ~100 entries arrive per call. */
const MAX_DIRECTORY_BATCHES = 400;

/**
 * Read one directory's entries.
 *
 * A loop rather than a recursive callback: a reader that answers synchronously
 * would grow the stack until it blew, and the bound means a reader that never
 * returns an empty batch ends the read instead of hanging the page. Hitting the
 * bound is reported, never passed off as a complete listing.
 *
 * @returns {Promise<{entries: object[], truncated: boolean}>}
 */
async function readDirectoryEntries(reader) {
  const all = [];
  for (let batchIndex = 0; batchIndex < MAX_DIRECTORY_BATCHES; batchIndex++) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch?.length) return { entries: all, truncated: false };
    all.push(...batch);
  }
  return { entries: all, truncated: true };
}

/** Promise wrapper around FileSystemFileEntry.file(). */
function entryToFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * The images inside dropped folders (and any images dropped alongside them).
 *
 * A dropped folder is a real directory entry: this reads only its top level and
 * never recurses into subfolders. Non-image child names are rejected before
 * their File objects are requested, so TextPhantom does not open their contents.
 * This is the strictest image-only path available in Brave without a native
 * File System Access directory picker.
 *
 * @param {Array<object>} entries from `dropEntriesFrom`
 * @returns {Promise<{files: File[], folderNames: string[], relativePaths: string[],
 *   scanned: number, skipped: number, subfolders: number, hadFolder: boolean}>}
 */
export async function imagesFromDroppedEntries(entries) {
  const files = [];
  const relativePaths = [];
  const folderNames = [];
  let scanned = 0;
  let subfolders = 0;
  let hadFolder = false;
  let truncated = false;

  for (const entry of entries || []) {
    if (entry.isFile) {
      scanned++;
      const file = await entryToFile(entry).catch(() => null);
      if (file && isImageFile(file)) {
        files.push(file);
        relativePaths.push("");
      }
      continue;
    }
    if (!entry.isDirectory) continue;

    hadFolder = true;
    const folder = trim(entry.name);
    folderNames.push(folder);
    const listing = await readDirectoryEntries(entry.createReader());
    if (listing.truncated) truncated = true;
    for (const child of listing.entries) {
      // Top level only. A subfolder is a different chapter, not more of this one.
      if (!child.isFile) {
        subfolders++;
        continue;
      }
      scanned++;
      if (!hasImageExtension(child.name)) continue;
      const file = await entryToFile(child).catch(() => null);
      if (!file || !isImageFile(file)) continue;
      files.push(file);
      relativePaths.push(folder ? `${folder}/${file.name}` : "");
    }
  }

  return {
    files,
    folderNames,
    relativePaths,
    scanned,
    skipped: scanned - files.length,
    subfolders,
    hadFolder,
    // True when a folder held more entries than one read pass could list. The
    // caller must say so: a short list presented as the whole folder is the
    // kind of quiet lie that sends someone hunting for a missing page.
    truncated,
  };
}

/** Page records for dropped images, in natural page order. */
export function pagesFromDrop(drop) {
  return sortLocalPages(
    (drop?.files || []).map((file, index) =>
      toLocalPageRecord(file, index, drop?.relativePaths?.[index] || ""),
    ),
  );
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
