import {getLoginSession,setLoginSession} from '../../shared/login-session.js';
import {getStorage,setStorage} from '../../shared/storage.js';
export const API_DISPLAY_CACHE_KEY='popupApiDisplayV1';
const safeBase=value=>{
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash?String(value):'';}
  catch{return '';}
};
// Only the previous reachability display persists across browser sessions. No
// authority, capabilities, credentials or negative result is restored from it.
const readDisplay=async keys=>({...await getLoginSession(keys).catch(()=>({})),...await getStorage(keys)});
const writeDisplay=patch=>Promise.all([setStorage(patch),setLoginSession(patch).catch(()=>{})]);
export function createApiDisplayCache({read=readDisplay,write=writeDisplay,now=Date.now}={}){
 let tail=Promise.resolve();
 const enqueue=work=>{tail=tail.catch(()=>{}).then(work).catch(()=>{});return tail;};
 return{
  async restore(base){
   if(!safeBase(base))return null;
   try{const value=(await read([API_DISPLAY_CACHE_KEY]))?.[API_DISPLAY_CACHE_KEY];return value?.version===1&&value.base===base&&value.online===true&&Number.isFinite(value.checkedAt)&&value.checkedAt>0&&value.checkedAt<=now()?{base,checkedAt:value.checkedAt}:null;}
   catch{return null;}
  },
  remember(base,checkedAt=now(),live=()=>true){
   if(!safeBase(base)||!Number.isFinite(checkedAt)||checkedAt<=0||checkedAt>now())return Promise.resolve();
   return enqueue(async()=>{if(live())await write({[API_DISPLAY_CACHE_KEY]:{version:1,base,online:true,checkedAt}});});
  },
  clear(base,live=()=>true){return enqueue(async()=>{const value=(await read([API_DISPLAY_CACHE_KEY]))?.[API_DISPLAY_CACHE_KEY];if(live()&&(!base||value?.base===base))await write({[API_DISPLAY_CACHE_KEY]:null});});},
 };
}
