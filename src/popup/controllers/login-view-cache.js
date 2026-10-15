/** Last scoped display. Opaque session handles stay in browser session memory;
 * displayOnly snapshots persist public model/provider copy with no handles.
 * Neither cache authorizes Login. */
export const LOGIN_VIEW_CACHE_KEY='loginProviderViewCacheV1';
const LOGIN_DISPLAY_CACHE_KEY='loginProviderDisplayCacheV1';
export const LOGIN_VIEW_CACHE_TTL_MS=60000;
// No Login provider is authentication-only.
const AUTHENTICATION_ONLY={};
export const authenticationOnlyStatus=value=>AUTHENTICATION_ONLY[value]
  ? 'Signed in to '+AUTHENTICATION_ONLY[value]+'. Translation is not supported yet and is under improvement.' : '';
const provider=value=>/^login_(chatgpt|claude|gemini|deepseek)$/.test(value);
const string=(value,max=256)=>typeof value==='string'?value.slice(0,max):'';
function session(value,id){
  return value?.provider===id && /^lgs_[a-f0-9]{48}$/.test(value.id) && /^[a-f0-9]{32}$/.test(value.account_id)
    ? {id:value.id,provider:id,account_id:value.account_id,transport:string(value.transport,32)} : null;
}
function sanitize(value,displayOnly=false){
  if(!provider(value?.provider)||!Array.isArray(value.list)||!Array.isArray(value.models))return null;
  const models=value.models.slice(0,100).filter(row=>typeof row?.id==='string').map(row=>({id:string(row.id,200),name:string(row.name,200),
    // A model the website refused (or its picker disables for this plan)
    // stays disabled, with its plan badge, when the popup reopens.
    ...(row?.availability?.usable===false?{availability:{usable:false,
      ...(row.availability.reason==='plan_required'?{reason:'plan_required'}:{}),
      ...(typeof row.availability.badge==='string'?{badge:string(row.availability.badge,40)}:{}),
      ...(typeof row.availability.required_plan==='string'?{required_plan:string(row.availability.required_plan,32)}:{})}}:{})}));
  const signedIn=Boolean(session(value.session,value.provider))||value.signedIn===true;
  return {provider:value.provider,selected:models.some(row=>row.id===value.selected)?value.selected:'',
    session:displayOnly?null:session(value.session,value.provider),...(displayOnly?{signedIn}:{}),models,
    list:value.list.slice(0,4).filter(row=>provider(row?.id)).map(row=>({id:row.id,name:string(row.name,100),
      available:row.available===true,supported:row.supported===true,reason:string(row.reason,80),session:displayOnly?null:session(row.session,row.id),
      ...(typeof row.sign_in_available==='boolean'?{sign_in_available:row.sign_in_available}:{}),
      // A shared API's cookie-session Login stays labelled "Own API only".
      ...(row.disabled_reason==='shared_deployment_cookie_session'?{disabled_reason:row.disabled_reason}:{}),
      ...(typeof row.translation_supported==='boolean'?{translation_supported:row.translation_supported}:{}),
      ...(['under_improvement','supported','unavailable'].includes(row.support_status)?{support_status:row.support_status}:{})})),
    // Persistent presentation excludes arbitrary server errors/account references.
    status:displayOnly?(signedIn?(authenticationOnlyStatus(value.provider)||'Your provider account quota applies. TP credits are not used.'):'Use your own AI account'):string(value.status,900),
    kind:displayOnly?'info':['info','warning','error'].includes(value.kind)?value.kind:'info'};
}
export function createLoginViewCache({read,write,now=Date.now,displayOnly=false}){
  const key=displayOnly?LOGIN_DISPLAY_CACHE_KEY:LOGIN_VIEW_CACHE_KEY;
  let writes=Promise.resolve();
  const enqueue=operation=>{const result=writes.catch(()=>{}).then(operation);writes=result.catch(()=>{});return writes;};
  return {
    async restore(scope,selectedProvider,selectedModel,{allowStale=true}={}){
      try{const row=(await read([key]))[key];
        if(row?.version!==1||row.scope!==scope||row.provider!==selectedProvider||row.selected!==selectedModel||
          !Number.isFinite(row.updatedAt)||now()<row.updatedAt||(!allowStale&&now()-row.updatedAt>=LOGIN_VIEW_CACHE_TTL_MS))return null;
        return sanitize(row,displayOnly);
      }catch{return null;}
    },
    remember(scope,value,live=()=>true){
      const data=sanitize(value,displayOnly);
      if(!/^[a-f0-9]{64}$/.test(scope)||!data)return Promise.resolve();
      return enqueue(async()=>{if(await live())await write({[key]:{version:1,scope,updatedAt:now(),...data}});});
    },
    clear(scope=''){return enqueue(async()=>{const row=(await read([key]))[key];
      if(!scope||row?.scope===scope)await write({[key]:null});});},
  };
}
