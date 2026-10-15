// Change signals. The service answers account/support requests with an
// opaque token per topic (header X-TP-Changes: v1;b=…;support=…;account=…;prices=…).
// A token changes only when that topic really changed for this account. The
// extension remembers the last tokens per signed-in account and fetches a topic
// only when its token moved -- no fixed timers. Listeners react to the storage
// record (CHANGE_KEY.changed) so every extension page sees the same signal.
import { getStorage, setStorage } from './storage.js';

export const CHANGE_HEADER = 'X-TP-Changes';
export const CHANGE_KEY = 'tpChangeTokensV1';
const CHANGE_TOPICS = Object.freeze(['support', 'account', 'prices']);
const SHAPE = /^v1(?:;[a-z]{1,16}=[a-f0-9]{6,32}){1,12}$/;

export function parseChanges(value) {
  const text = String(value || '');
  if (text.length > 400 || !SHAPE.test(text)) return null;
  const tokens = {};
  for (const part of text.split(';').slice(1)) {
    const [name, token] = part.split('=');
    tokens[name] = token;
  }
  return tokens.b ? tokens : null;
}

async function changeScope(base, token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(base) + '\n' + String(token)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

let writes = Promise.resolve();
/**
 * Record tokens seen on a response. Returns the topics that changed since the
 * previous response of the same account ([] on the first observation).
 */
export function noteChanges(base, token, value, { read = getStorage, write = setStorage, now = Date.now } = {}) {
  const tokens = parseChanges(value);
  if (!tokens || !base || !token) return Promise.resolve([]);
  const task = writes.then(async () => {
    const scope = await changeScope(base, token);
    const saved = (await read([CHANGE_KEY]))[CHANGE_KEY];
    if (!saved || saved.scope !== scope || !saved.tokens) {
      await write({ [CHANGE_KEY]: { scope, tokens, changed: [], seq: 0, at: now() } });
      return [];
    }
    const restarted = saved.tokens.b !== tokens.b;
    const changed = CHANGE_TOPICS.filter(topic => tokens[topic] && (restarted || saved.tokens[topic] !== tokens[topic]));
    if (!changed.length && !restarted) return [];
    await write({ [CHANGE_KEY]: { scope, tokens, changed, seq: (saved.seq || 0) + 1, at: now() } });
    return changed;
  });
  writes = task.catch(() => []);
  return task;
}

/** Topics named by a storage change of CHANGE_KEY (empty unless a real move). */
export function changedTopics(changes) {
  const next = changes?.[CHANGE_KEY]?.newValue;
  const previous = changes?.[CHANGE_KEY]?.oldValue;
  if (!next || !Array.isArray(next.changed) || (previous && previous.seq === next.seq && previous.scope === next.scope)) return [];
  return next.changed.filter(topic => CHANGE_TOPICS.includes(topic));
}

/** Called by diagnosticFetch for every /paid/* response that carries tokens. */
export function noteResponseChanges(url, authorization, value) {
  try {
    const href = String(url || '');
    const at = href.indexOf('/paid/');
    const token = String(authorization || '').replace(/^Bearer\s+/i, '');
    if (at <= 0 || !token || !value) return;
    void noteChanges(href.slice(0, at), token, value).catch(() => {});
  } catch { /* a signal is only a hint */ }
}
