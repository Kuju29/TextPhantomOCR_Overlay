// Private extension-origin storage. Blob bytes never enter chrome.storage or page messages.
let database;
export async function supportDraftScope(identity, email) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity.base + '\0' + String(email).trim().toLowerCase()));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function open() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('textphantom-support-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'scope' });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
const empty = scope => ({ scope, revision: 0, text: '', files: [], pending: null });
const fail = (code, message) => Object.assign(new Error(message), { code });
export async function readDraft(scope) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').get(scope);
    request.onsuccess = () => resolve(request.result || empty(scope)); request.onerror = () => reject(request.error);
  });
}
async function changeDraft(scope, update) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite'), store = transaction.objectStore('drafts');
    let result, error;
    const request = store.get(scope);
    request.onsuccess = () => {
      try {
        result = request.result || empty(scope);
        update(result);
        result.revision++; store.put(result);
      } catch (value) { error = value; transaction.abort(); }
    };
    transaction.oncomplete = () => {
      chrome.storage.local.set({ supportDraftChanged: { scope, revision: result.revision, nonce: crypto.randomUUID() } }, () => void chrome.runtime.lastError);
      resolve(result);
    };
    transaction.onabort = transaction.onerror = () => reject(error || transaction.error || fail('DRAFT_SAVE_FAILED', 'Draft could not be saved.'));
  });
}
export function setDraftText(scope, text) {
  return changeDraft(scope, record => {
    if (record.pending) throw fail('DRAFT_PENDING', 'Retry Send to confirm the previous message.');
    record.text = String(text).slice(0, 5000);
  });
}
export function addDraftFile(scope, file, command) {
  return changeDraft(scope, record => {
    if (record.pending) throw fail('DRAFT_PENDING', 'Retry Send to confirm the previous message.');
    if (record.files.length >= 6 || record.files.reduce((sum, x) => sum + x.file.size, file.size) > 40 * 1048576)
      throw fail('ATTACHMENTS_TOO_LARGE', 'Up to 6 files, 40 MB total.');
    record.files.push({ command, file, meta: null, uploadedAt: 0 });
  });
}
export function updateDraftFile(scope, command, meta) {
  return changeDraft(scope, record => {
    const item = record.files.find(x => x.command === command);
    if (item) { item.meta = meta; item.uploadedAt = Date.now(); }
  });
}
export function removeDraftFile(scope, command) {
  return changeDraft(scope, record => {
    if (record.pending) throw fail('DRAFT_PENDING', 'Retry Send to confirm the previous message.');
    record.files = record.files.filter(x => x.command !== command);
  });
}
export function claimDraft(scope, revision, owner) {
  return changeDraft(scope, record => {
    if (record.pending) {
      if (record.pending.until > Date.now() && record.pending.owner !== owner)
        throw fail('DRAFT_BUSY', 'This message is being sent in another tab.');
    } else {
      if (record.revision !== revision) throw fail('DRAFT_CHANGED', 'Draft changed in another tab. Review it before sending.');
      if (record.files.some(x => !x.meta)) throw fail('UPLOAD_PENDING', 'Retry the attachment before sending.');
      if (!record.text.trim() && !record.files.length) throw fail('EMPTY_MESSAGE', 'Enter a message or attach a file.');
      record.pending = { body: { command_id: crypto.randomUUID(), text: record.text.trim(), attachments: record.files.map(x => x.meta.id) } };
    }
    record.pending.owner = owner; record.pending.until = Date.now() + 25000;
  });
}
export function settleDraft(scope, command, owner, success) {
  return changeDraft(scope, record => {
    if (record.pending?.body.command_id !== command) return;
    if (success) { record.text = ''; record.files = []; record.pending = null; }
    else if (record.pending.owner === owner) record.pending.until = 0;
  });
}
export function recoverDraftFiles(scope, command) {
  return changeDraft(scope, record => {
    if (record.pending?.body.command_id !== command) return;
    record.pending = null;
    for (const item of record.files) { item.meta = null; item.command = crypto.randomUUID(); item.uploadedAt = 0; }
  });
}
