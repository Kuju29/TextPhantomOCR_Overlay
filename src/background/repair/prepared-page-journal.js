// Immutable per-page source checkpoints for Conversation initial translation.
// Keeping each page under its own session-storage key avoids rewriting an
// ever-growing chapter/run object before every provider request. The repair
// barrier folds these durable page rows into the canonical run exactly once.
export const TRANSLATION_PREPARED_PAGE_PREFIX = 'tpTranslationPreparedPageV1:';
const enc = value => encodeURIComponent(String(value || ''));
export const translationPreparedPageKey = (runId, pageId) =>
  `${TRANSLATION_PREPARED_PAGE_PREFIX}${enc(runId)}:${enc(pageId)}`;
const clone = value => value == null ? value : structuredClone(value);

export function createPreparedPageJournal({area = () => globalThis.chrome?.storage?.session, now = Date.now} = {}) {
  const cache = new Map();
  const requireArea = () => {
    const storage = area();
    if (!storage) throw Object.assign(new Error('Translation prepared-page storage is unavailable'),
      {code:'session_storage_unavailable'});
    return storage;
  };
  async function record(runId, pageId, page) {
    const key = translationPreparedPageKey(runId, pageId);
    const previous = cache.get(key) || null;
    if (previous) {
      if (String(previous.generationId || '') !== String(page?.generationId || ''))
        throw Object.assign(new Error('Conversation prepared page conflicts with durable source checkpoint'),
          {code:'prepared_page_conflict'});
      return clone(previous);
    }
    // A run owns each page ID once. Do not pay a storage read before the first
    // immutable write; after a worker restart recovery consumes the existing
    // key instead of re-dispatching the page.
    const safe = clone(page);
    cache.set(key, safe);
    try {
      await requireArea().set({[key]:{version:1,runId:String(runId),pageId:String(pageId),createdAt:now(),page:safe}});
    } catch (error) {
      cache.delete(key);
      throw error;
    }
    return clone(safe);
  }
  async function get(runId, pageId) {
    const key = translationPreparedPageKey(runId, pageId);
    if (cache.has(key)) return clone(cache.get(key));
    const value = (await requireArea().get(key))?.[key]?.page || null;
    if (value) cache.set(key,value);
    return clone(value);
  }
  async function listRun(runId) {
    const prefix = `${TRANSLATION_PREPARED_PAGE_PREFIX}${enc(runId)}:`;
    const all = await requireArea().get(null);
    const rows = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(prefix) || !value?.page) continue;
      cache.set(key,value.page);
      rows.push({runId:String(runId),pageId:String(value.pageId || value.page.pageId || ''),page:clone(value.page)});
    }
    return rows;
  }
  async function remove(runId, pageId) {
    const key = translationPreparedPageKey(runId,pageId);
    cache.delete(key);
    await requireArea().remove?.(key);
  }
  async function clearRun(runId) {
    const prefix = `${TRANSLATION_PREPARED_PAGE_PREFIX}${enc(runId)}:`;
    const all = await requireArea().get(null);
    const keys = Object.keys(all || {}).filter(key => key.startsWith(prefix));
    for (const key of keys) cache.delete(key);
    if (keys.length) await requireArea().remove?.(keys);
  }
  return {record,get,listRun,remove,clearRun};
}

export const conversationPreparedPages = createPreparedPageJournal();
