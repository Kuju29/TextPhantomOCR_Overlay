/** Login-only read. Secrets are returned directly to the trusted worker, never a content message. */
import {getTab} from '../../../shared/browser-api.js';
import {hasDataConsent} from '../../../shared/data-consent.js';
export const ENDPOINT_PROVIDERS = {
  login_chatgpt:{origin:'https://chatgpt.com',url:'https://chatgpt.com/'},
  login_gemini:{origin:'https://gemini.google.com',url:'https://gemini.google.com/app'},
  login_claude:{origin:'https://claude.ai',url:'https://claude.ai/new'},
  login_deepseek:{origin:'https://chat.deepseek.com',url:'https://chat.deepseek.com/'},
};
const error=code=>Object.assign(new Error('Complete provider sign-in in its original tab and try again.'),{code});
function chromeCall(object,name,args){return new Promise((resolve,reject)=>object[name](...args,value=>{
  if(chrome.runtime.lastError)reject(error('login_capture_unavailable'));else resolve(value);
}));}
/** Runs in the chatgpt.com top frame (isolated world). Reads which account and
 * plan is signed in on the website itself; the session token is used only inside
 * this page and never returned. Only a hash of the user id and the plan word leave. */
export async function readChatGptPlan(provider,origin){
  if(provider !== 'login_chatgpt' || origin !== 'https://chatgpt.com' || location.origin !== origin || window !== window.top)return {ok:false,code:'login_origin_invalid'};
  try{
    const response=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(response.status === 401 || response.status === 403)return {ok:false,code:'login_required'};
    if(!response.ok || !/\bjson\b/i.test(response.headers.get('content-type') || ''))return {ok:false,code:'login_capture_unavailable'};
    const session=await response.json();
    const userId=session?.user?.id;
    if(typeof userId !== 'string' || !/^[A-Za-z0-9_|-]{1,128}$/.test(userId) || typeof session?.accessToken !== 'string')return {ok:false,code:'login_required'};
    const clean=value=>typeof value === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value)?value.toLowerCase():'';
    let plan=clean(session?.account?.planType) || clean(session?.account?.plan_type);
    if(!plan){
      const check=await fetch('/backend-api/accounts/check/v4-2023-04-27',{credentials:'include',cache:'no-store',redirect:'error',
        headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(10000)}).catch(()=>null);
      const data=check?.ok?await check.json().catch(()=>null):null;
      const rows=data?.accounts?Object.values(data.accounts):[];
      const own=rows.find(row=>row?.account?.account_id === session?.account?.id) || (rows.length === 1?rows[0]:null);
      plan=clean(own?.account?.plan_type);
    }
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('login_chatgpt\0'+userId));
    const account=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    return {ok:true,account,plan:plan || 'unknown'};
  }catch{return {ok:false,code:'login_capture_unavailable'};}
}
/** Passed to isolated scripting; never sends a prompt or accesses the chat DOM. */
export async function readProviderLogin(provider,origin){
  if(location.origin !== origin || window !== window.top)return {ok:false,code:'login_origin_invalid'};
  try {
    let identity='', credentials={},authUser='0';
    if(provider === 'login_gemini'){
      authUser=location.pathname.match(/^\/u\/([0-9]{1,2})\//)?.[1] || '0';
      const response=await fetch(authUser === '0'?'/app':'/u/'+authUser+'/app',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)return {ok:false,code:'login_required'};
      const html=await response.text(), match=html.match(/"oPEP7c"\s*:\s*("(?:[^"\\]|\\.)*")/);
      if(match)identity=String(JSON.parse(match[1])).trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+$/.test(identity))return {ok:false,code:'login_required'};
      credentials={auth_user:authUser};
    }else if(provider === 'login_claude'){
      const response=await fetch('/api/bootstrap',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)return {ok:false,code:'login_required'};
      const account=(await response.json())?.account;
      if(location.origin !== origin || window !== window.top)return {ok:false,code:'login_document_changed'};
      const cleanId=value=>typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
      const accountId=account?.uuid;
      // /api/bootstrap may omit lastActiveOrgId. Use it when present; otherwise
      // the website's own lastActiveOrg cookie, or the account's only chat
      // organization.
      const chatOrgs=(Array.isArray(account?.memberships)?account.memberships:[])
        .map(m=>m?.organization).filter(o=>cleanId(o?.uuid) && Array.isArray(o.capabilities) && o.capabilities.includes('chat')).map(o=>o.uuid);
      const cookieOrg=String(globalThis.document?.cookie || '').split('; ').find(x=>x.startsWith('lastActiveOrg='))?.slice('lastActiveOrg='.length);
      let organization=account?.lastActiveOrgId;
      if(!cleanId(organization))organization=cleanId(cookieOrg) && chatOrgs.includes(cookieOrg)?cookieOrg:chatOrgs.length === 1?chatOrgs[0]:'';
      if(!cleanId(accountId))return {ok:false,code:'login_required'};
      if(!cleanId(organization))return {ok:false,code:'login_organization_required'};
      // Copy the actual selected organization, never an inventory/default row.
      identity=accountId+'\0'+organization;credentials={organization};
    }else if(provider === 'login_deepseek'){
      const raw=localStorage.getItem('userToken');let token='';
      if(raw){try{const value=JSON.parse(raw);token=typeof value === 'string'?value:value?.value || value?.token || '';}catch{token=raw;}}
      if(typeof token !== 'string' || token.length < 8 || token.length > 8192)return {ok:false,code:'login_required'};
      const response=await fetch('/api/v0/users/current',{headers:{Authorization:'Bearer '+token},credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)return {ok:false,code:'login_required'};
      const data=await response.json();if(data?.code !== 0 || data?.data?.biz_code !== 0)return {ok:false,code:'login_required'};
      identity=String(data?.data?.biz_data?.id || '');credentials={token};
    }else return {ok:false,code:'login_provider_unavailable'};
    if(!identity || identity.length > 320)return {ok:false,code:'login_required'};
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
    return {ok:true,expected_identity:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join(''),credentials};
  }catch{return {ok:false,code:'login_capture_unavailable'};}
}
export async function captureEndpointLogin(tabId,provider){
  const spec=ENDPOINT_PROVIDERS[provider],before=await getTab(tabId);
  if(!spec || !before?.url || new URL(before.url).origin !== spec.origin)throw error('login_origin_invalid');
  // Claude and ChatGPT need no cookie read; their requests leave from this browser.
  const needsCookies=!['login_claude','login_chatgpt'].includes(provider);
  // 10494: no cookie (or token) is read or sent without the user's data consent.
  if(needsCookies && !await hasDataConsent())throw error('login_data_consent_required');
  if(needsCookies && !await chromeCall(chrome.permissions,'contains',[{permissions:['cookies']}]))throw error('login_cookie_permission_required');
  const results=await chromeCall(chrome.scripting,'executeScript',[{target:{tabId,frameIds:[0]},world:'ISOLATED',func:provider === 'login_chatgpt'?readChatGptPlan:readProviderLogin,args:[provider,spec.origin]}]);
  const result=results?.find(x=>x.frameId === 0),capture=result?.result;
  const after=await getTab(tabId);
  if(!after?.url || before.url !== after.url || new URL(after.url).origin !== spec.origin || !result?.documentId)throw error('login_document_changed');
  if(!capture?.ok){if(capture?.code === 'login_required')return null;throw error(capture?.code || 'login_capture_unavailable');}
  if(needsCookies)await readProviderCookies(tabId,provider,spec,result,capture);
  const final=await getTab(tabId);
  if(final?.url !== after.url)throw error('login_document_changed');
  const frame=await chromeCall(chrome.webNavigation,'getFrame',[{tabId,frameId:0}]);
  if(frame?.documentId !== result.documentId || frame?.url && new URL(frame.url).origin !== spec.origin)throw error('login_document_changed');
  return capture;
}
async function readProviderCookies(tabId,provider,spec,result,capture){
  if(!await hasDataConsent())throw error('login_data_consent_required');
  const stores=await chromeCall(chrome.cookies,'getAllCookieStores',[]),store=stores?.find(x=>x.tabIds?.includes(tabId));
  if(!store?.id)throw error('login_cookie_store_unavailable');
  let partitionKey;
  if(typeof chrome.cookies.getPartitionKey === 'function'){
    const partitionResult=await chromeCall(chrome.cookies,'getPartitionKey',[{tabId,frameId:0,documentId:result.documentId}]);
    partitionKey=partitionResult?.partitionKey;
    if(partitionKey?.topLevelSite){const site=new URL(partitionKey.topLevelSite).hostname,host=new URL(spec.origin).hostname;
      if(host !== site && !host.endsWith('.'+site))throw error('login_cookie_partition_invalid');}
  }
  async function cookie(name,required){
    const rows=await chromeCall(chrome.cookies,'getAll',[{url:spec.origin+'/',name,storeId:store.id}]);
    if(partitionKey){rows.push(...await chromeCall(chrome.cookies,'getAll',[{url:spec.origin+'/',name,storeId:store.id,partitionKey}]));}
    const host=new URL(spec.origin).hostname;
    const values=[...new Set(rows.filter(c=>c.name === name && c.storeId === store.id && c.secure === true &&
      (host === c.domain.replace(/^\./,'') || host.endsWith('.'+c.domain.replace(/^\./,''))) &&
      (!c.partitionKey || partitionKey && c.partitionKey.topLevelSite === partitionKey.topLevelSite && c.partitionKey.hasCrossSiteAncestor === partitionKey.hasCrossSiteAncestor)).map(c=>c.value))];
    if(values.length > 1 || required && values.length !== 1)throw error('login_cookie_unavailable');
    return values[0] || '';
  }
  if(provider === 'login_gemini'){
    capture.credentials.psid=await cookie('__Secure-1PSID',true);
    const value=await cookie('__Secure-1PSIDTS',false);if(value)capture.credentials.psidts=value;
  }else if(provider === 'login_deepseek'){const value=await cookie('ds_session_id',false);if(value)capture.credentials.session_id=value;}
}
