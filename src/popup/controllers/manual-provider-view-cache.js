/** Last bounded scoped presentation; never verification. */
import {getLoginSession,setLoginSession} from '../../shared/login-session.js';
import {getStorage,setStorage} from '../../shared/storage.js';
const MANUAL_PROVIDER_VIEW_CACHE_KEY='manualProviderViewCacheV1';
const MANUAL_PROVIDER_DISPLAY_CACHE_KEY='manualProviderDisplayCacheV1';
export const MANUAL_PROVIDER_VIEW_CACHE_TTL_MS=60000;
let writes=Promise.resolve();
const text=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
const rows=value=>Array.isArray(value)?value.slice(0,200):[];
const choices=value=>rows(value).map(row=>typeof row==='string'?{id:text(row)}:{id:text(row?.id),label:text(row?.label),eligibility:text(row?.eligibility,24)}).filter(row=>row.id);
const pick=(value,names)=>Object.fromEntries(names.filter(key=>typeof value?.[key]==='string').map(key=>[key,text(value[key])]));
function sanitize(value){
  if(value?.kind==='cloud')return {kind:'cloud',resolve:{...pick(value.resolve,['provider','provider_protocol','key_status','configuration_status','error','models_source','model_status','model','requested_model']),
    backend_supported:value.resolve?.backend_supported===true,models_verified:value.resolve?.models_verified===true,
    models:rows(value.resolve?.models).filter(row=>typeof row==='string').map(row=>text(row)),model_candidates:choices(value.resolve?.model_candidates)},
    models:choices(value.models)};
  if(value?.kind==='local')return {kind:'local',models:choices(value.models),status:text(value.status,700),field:text(value.field,700),fieldKind:['info','warn','error'].includes(value.fieldKind)?value.fieldKind:'info'};
  return null;
}
export async function manualProviderViewScope(identity){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
  return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
// Prefer the persistent safe record and migrate a still-open browser's old
// session display. Explicit null in local storage is an invalidation barrier.
const readDisplay=async keys=>{
  const saved=await getStorage([MANUAL_PROVIDER_DISPLAY_CACHE_KEY]);
  return Object.hasOwn(saved,MANUAL_PROVIDER_DISPLAY_CACHE_KEY)?{[MANUAL_PROVIDER_VIEW_CACHE_KEY]:saved[MANUAL_PROVIDER_DISPLAY_CACHE_KEY]}:getLoginSession(keys).catch(()=>({}));
};
const writeDisplay=patch=>Promise.all([setStorage({[MANUAL_PROVIDER_DISPLAY_CACHE_KEY]:patch[MANUAL_PROVIDER_VIEW_CACHE_KEY]}),setLoginSession(patch).catch(()=>{})]);
export function createManualProviderViewCache({read=readDisplay,write=writeDisplay,now=Date.now}={}){
  const queue=work=>{const result=writes.catch(()=>{}).then(work);writes=result.catch(()=>{});return writes;};
  return {
    async restore(scope,kind,{allowStale=true}={}){try{const row=(await read([MANUAL_PROVIDER_VIEW_CACHE_KEY]))[MANUAL_PROVIDER_VIEW_CACHE_KEY];
      if(row?.version!==1||row.scope!==scope||!Number.isFinite(row.updatedAt)||now()<row.updatedAt||(!allowStale&&now()-row.updatedAt>=MANUAL_PROVIDER_VIEW_CACHE_TTL_MS)||row.view?.kind!==kind)return null;
      return sanitize(row.view);
    }catch{return null;}},
    remember(scope,value,live=()=>true,secrets=[]){const view=sanitize(value);
      if(!/^[a-f0-9]{64}$/.test(scope)||!view||secrets.some(secret=>secret&&JSON.stringify(view).includes(secret)))return Promise.resolve();
      return queue(async()=>{if(await live())await write({[MANUAL_PROVIDER_VIEW_CACHE_KEY]:{version:1,scope,updatedAt:now(),view}});});
    },
    clear(scope=''){return queue(async()=>{const row=(await read([MANUAL_PROVIDER_VIEW_CACHE_KEY]))[MANUAL_PROVIDER_VIEW_CACHE_KEY];if(!scope||row?.scope===scope)await write({[MANUAL_PROVIDER_VIEW_CACHE_KEY]:null});});},
  };
}
