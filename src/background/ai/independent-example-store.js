import {getStorage, setStorage} from '../../shared/storage.js';
import {boundedIndependentPairs,suitableIndependentExample} from '../../shared/ai/independent/examples.js';
import {normalizeLanguageCode} from '../../generated/language-code-aliases.js';

const KEY = 'aiIndependentExamplesV1';
const MAX_SCOPES = 24;
const MAX_AGE_MS = 30 * 86400000;
const HUMAN_LANGUAGES = new Set(['en','ja','th']);
// Most series keys are URL/title heuristics; a generic reader title can look
// series-specific while identifying every story on the site. Only the MangaDex
// chapter→manga UUID lookup is verified. Otherwise use the exact document URL.
function verifiedSeriesKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return /^mangadex\.org\/title\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(key) ? key : '';
}

function storageError(cause) {
  const error = new Error('Independent example storage is unavailable');
  error.code = 'independent_examples_storage_unavailable';
  error.cause = cause;
  error.requestDispatched = false;
  return error;
}

export function createIndependentExampleStore({read=getStorage,write=setStorage,now=Date.now}={}) {
  let pending = Promise.resolve();
  const failedWriteScopes = new Set();
  const serialized = task => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  async function readScopes() {
    let storage;
    try { storage = await read(KEY); } catch (error) { throw storageError(error); }
    if (!storage || typeof storage !== 'object') throw storageError(new Error('no storage response'));
    const value = storage[KEY];
    if (!value) return {};
    if (value.version !== 1 || !value.scopes || typeof value.scopes !== 'object')
      throw storageError(new Error('unsupported example store version'));
    return value.scopes;
  }
  return {
    async scope(ai, context, sourceLang, targetLang) {
      // A document URL or title is not an account boundary. Background-created
      // tab session + translation batch bind accepted dialogue to this run;
      // without both, keep only current-request human examples.
      const owner = String(context?.tp_tab_session || '').trim();
      const batch = String(context?.batch_id || '').trim();
      if (!owner) return {key:'',scopeStatus:'owner_unverified'};
      if (!batch) return {key:'',scopeStatus:'batch_unverified'};
      const series = verifiedSeriesKey(context?.series_key);
      const rawUrl = String(context?.page_url || ai?.conversation?.documentId || '').trim();
      let document = rawUrl;
      // Hash routes can identify the chapter or even the story. Preserve the
      // fragment so two stories on one SPA origin never share examples.
      try { document = new URL(rawUrl).href; } catch {}
      const identity = series || document;
      if (!identity) return {key:'',scopeStatus:'unscoped'};
      // No credentials or story names in storage keys or compact diagnostics.
      const data = JSON.stringify(['private_batch_v2',owner,batch,identity,ai?.provider,ai?.model,ai?.base_url,
        ai?.prompt,sourceLang,targetLang]);
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)));
      return {key:[...bytes].map(b=>b.toString(16).padStart(2,'0')).join(''),
        scopeStatus:series?'verified_series':'document'};
    },
    async select(scope, targetLang, enabled=true) {
      if (!enabled) return {source:'none',pairs:[],acceptedPairs:0,rejectedPairs:0,
        scopeStatus:scope?.scopeStatus || 'unscoped',storageStatus:'disabled'};
      return serialized(async () => {
        const scopes = scope?.key ? await readScopes() : {};
        const valid = scopes[scope?.key];
        const pairs = valid && now()-Number(valid.updatedAt) <= MAX_AGE_MS
          ? boundedIndependentPairs(valid.pairs).filter(pair => suitableIndependentExample(pair.tgt,targetLang)) : [];
        const human = HUMAN_LANGUAGES.has(normalizeLanguageCode(targetLang).split('-')[0]);
        return {source:pairs.length?'story':human?'human':'none',pairs,
          targetLang:String(targetLang || ''),
          acceptedPairs:pairs.length,rejectedPairs:0,
          scopeStatus:scope?.scopeStatus || 'unscoped',
          storageStatus:!scope?.key?'unscoped':failedWriteScopes.has(scope.key)?'write_failed':'ready'};
      });
    },
    async append(scope, rows) {
      if (!scope?.key || !Array.isArray(rows) || !rows.length) return {accepted:0};
      return serialized(async () => {
        const scopes = await readScopes();
        const current = scopes[scope.key];
        const previous = current && now()-Number(current.updatedAt) <= MAX_AGE_MS
          ? current.pairs : [];
        const pairs = boundedIndependentPairs([...(previous || []),...rows]);
        if (!pairs.length) return {accepted:0};
        const active = Object.entries(scopes).filter(([key,value]) =>
          key !== scope.key && now()-Number(value?.updatedAt) <= MAX_AGE_MS)
          .sort((a,b)=>Number(b[1].updatedAt)-Number(a[1].updatedAt))
          .slice(0,MAX_SCOPES-1);
        const saved = {version:1,scopes:Object.fromEntries([...active,
          [scope.key,{updatedAt:now(),pairs}]])};
        try { await write({[KEY]:saved}); }
        catch (error) { failedWriteScopes.add(scope.key); throw storageError(error); }
        failedWriteScopes.delete(scope.key);
        return {accepted:pairs.length};
      });
    },
  };
}

export const independentExampleStore = createIndependentExampleStore();

// Learn only one-to-one rows that passed the existing target-script check and
// the durable progress checkpoint. Omitted, repeated and ambiguous IDs cannot
// teach an Independent request even when the page has other valid rows.
export function verifiedIndependentPairs(sourceUnits, answer, defects, targetLang = "") {
  const byId = new Map(sourceUnits.map(row=>[String(row.id),String(row.text || '')]));
  const counts = new Map();
  for (const row of answer?.translations || []) {
    const id = String(row?.id || '');
    counts.set(id,(counts.get(id)||0)+1);
  }
  const rejected = new Set([...(defects?.missing || []),...(defects?.wrongLanguage || []),
    ...(answer?.meta?.alignmentUncertainIds || [])].map(String));
  const rows = (answer?.translations || []).filter(row=>{
    const id = String(row?.id || '');
    return byId.has(id) && counts.get(id) === 1 && !rejected.has(id) &&
      suitableIndependentExample(row.text,targetLang);
  }).map(row=>({src:byId.get(String(row.id)),tgt:String(row.text || '')}));
  return boundedIndependentPairs(rows);
}
