// Observes rejected session writes without changing their retry or failure path.
// Only key families and sizes leave this module; never log checkpoint values.
import { createLogger } from '../shared/logger.js';

const log = createLogger('SW.session');
const lastByFamily = new Map();
const families = [
  ['prepared_page', 'tpTranslationPreparedPageV1:'],
  ['dispatch_receipt', 'tpTranslationDispatchV1:'],
  ['translation_run', 'tpTranslationRunV1:'],
  ['pending_jobs', 'tpPendingJobsV2'],
  ['batch_progress', 'tpBatchProgressV1'],
  ['tab_sessions', 'tpTabSessionsV1'],
  ['settings_epoch', 'tpTranslationSettingsEpochV1'],
];
const familyOf = key => families.find(([,prefix])=>String(key).startsWith(prefix))?.[0] || 'other';

export function noteSessionStorageFailure(family, error) {
  if (!/session storage quota bytes exceeded|QUOTA_BYTES exceeded/i.test(String(error?.message || error || ''))) return;
  const now=Date.now();
  if (now-(lastByFamily.get(family) || 0)<5000) return;
  lastByFamily.set(family,now);
  // A rejected write remains rejected. Measurement must never make a failed
  // checkpoint appear successful or delay the provider/placement path.
  void (async()=>{
    const area=globalThis.chrome?.storage?.session;
    const detail={family,reason:'quota',quotaBytes:Number(area?.QUOTA_BYTES) || null,
      usedBytes:null,groups:[]};
    try {detail.usedBytes=await area?.getBytesInUse?.(null) ?? null;} catch {}
    try {
      const keys=await area?.getKeys?.();
      if (Array.isArray(keys) && typeof area?.getBytesInUse==='function') {
        const groups=new Map();
        for (const key of keys) {
          const name=familyOf(key), list=groups.get(name) || [];
          list.push(key);groups.set(name,list);
        }
        detail.groups=await Promise.all([...groups].map(async ([name,list])=>{
          try{return {family:name,keys:list.length,bytes:await area.getBytesInUse(list)};}
          catch{return {family:name,keys:list.length,bytes:null};}
        }));
      }
    } catch {}
    log.warn('session storage write rejected',detail);
  })().catch(()=>{try{log.warn('session storage write rejected',{family,reason:'quota',measurement:'unavailable'});}catch{}});
}
