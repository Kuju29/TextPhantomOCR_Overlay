// One random install id for the whole browser profile (Paid accounts are linked
// by browser, never by IP). 128 random bits as hex, created once
// and kept in chrome.storage.local. It is not derived from hardware or browser
// attributes. It is sent only to the configured TextPhantom API as X-TP-Install;
// the operator's service keeps only a keyed commitment of it.
import { getStorage, setStorage } from '../shared/storage.js';
import { recordDiagnostic } from '../shared/diagnostics.js';

export const INSTALL_KEY = 'tpInstallIdV1';
export const INSTALL_HEADER = 'X-TP-Install';
const VALID = /^[a-f0-9]{32}$/;
const loads = new WeakMap();

function randomId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Existing users keep the id they already sent at sign-in: the oldest saved
// popup id (paidDeviceIds, one per API) or the support chat id (paidDeviceId).
export function legacyInstallId(values = {}) {
  const list = Array.isArray(values.paidDeviceIds) ? values.paidDeviceIds : [];
  const first = list.find((item) => item && VALID.test(String(item.id || '')));
  if (first) return first.id;
  const single = String(values.paidDeviceId || '').replaceAll('-', '').toLowerCase();
  return VALID.test(single) ? single : '';
}

async function load(read, write) {
  const values = (await read([INSTALL_KEY, 'paidDeviceIds', 'paidDeviceId'])) || {};
  const saved = String(values[INSTALL_KEY] || '');
  if (VALID.test(saved)) return saved;
  const value = legacyInstallId(values) || randomId();
  await write({ [INSTALL_KEY]: value });
  // Another extension page may have stored one at the same moment: the stored value wins.
  const stored = String(((await read([INSTALL_KEY])) || {})[INSTALL_KEY] || '');
  return VALID.test(stored) ? stored : value;
}

// Request clients use create:false: they never write storage, they send the saved
// id (or the legacy id it will be migrated from). The popup and support sign-in create it.
async function peek(read) {
  const values = (await read([INSTALL_KEY, 'paidDeviceIds', 'paidDeviceId'])) || {};
  const saved = String(values[INSTALL_KEY] || '');
  return VALID.test(saved) ? saved : legacyInstallId(values);
}

export function installId({ read = getStorage, write = setStorage, create = true } = {}) {
  if (!create) return peek(read);
  let pending = loads.get(read);
  if (!pending) {
    pending = load(read, write);
    loads.set(read, pending);
    pending.catch(() => loads.delete(read));
  }
  return pending;
}

// Headers for a Paid/Center request through the TextPhantom API. The id is an
// anti-abuse link, never authentication: if storage is unavailable the request
// still goes out without it, and that is recorded (without the value).
export async function installHeaders(options) {
  try {
    const value = await installId(options);
    if (VALID.test(value)) return { [INSTALL_HEADER]: value };
    if (options?.create !== false) recordDiagnostic('paid.install_id.unavailable', { reason: 'invalid' });
  } catch (error) {
    recordDiagnostic('paid.install_id.unavailable', {
      reason: 'storage',
      error_type: error?.name || 'Error',
    });
  }
  return {};
}
