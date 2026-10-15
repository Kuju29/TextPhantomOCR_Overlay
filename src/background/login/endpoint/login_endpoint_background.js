/** Browser opens for Login only. Translation uses ordinary API fetch, never this module. */
import {readLoginState,setLoginSession,getLoginSession,writeLoginState} from '../../../shared/login-session.js';
import {LOGIN_PENDING_AUTH,LOGIN_OUTCOME,loginAuthScope} from '../../../shared/login-auth.js';
import {createTab,getTab,queryTabs} from '../../../shared/browser-api.js';
import {getApiBase} from '../../api.js';
import {recordDiagnostic} from '../../../shared/diagnostics.js';
import {ENDPOINT_PROVIDERS,captureEndpointLogin} from './login_endpoint_capture.js';
import {RELAY_PROVIDERS,acquireBrowserRelay} from './login_browser_relay.js';
import {OFFICIAL_REDIRECT,beginOfficialSignIn,readCallback,finishOfficialSignIn,officialAccount,officialAccessToken,forgetOfficial} from './login_chatgpt_official.js';
import {forgetWebchats} from './login_chatgpt_web.js';
import {setAutoConnect} from '../login-ready-gate.js';
import {allowLoginTabs} from '../login-tab-guard.js';
const ALARM='textphantom-login-endpoint';let busy=false,timer=null,rerun=false;
// The safety alarm exists only while a sign-in flow is pending (it covers a
// suspended worker's lost 1.5 s timer); none while idle. Inline on purpose: this
// worker's dependency list is fixed.
let alarmArmed=null;
const flowAlarm={arm(){if(alarmArmed===true)return;alarmArmed=true;try{chrome.alarms?.create?.(ALARM,{periodInMinutes:0.5});}catch{}},
  disarm(){if(alarmArmed===false)return;alarmArmed=false;try{chrome.alarms?.clear?.(ALARM,()=>{void chrome.runtime?.lastError;});}catch{}}};
const importingFlows=new Set();
const failureMessages={
  login_organization_required:'Select the intended organization on the Claude website, then reconnect from the extension.',
  login_reconnect_required:'Update the extension and API together, then sign in again to verify the provider account and workspace.',
  login_chatgpt_auth_sdk_unavailable:'ChatGPT sign-in could not be read from this page version. Reload the provider tab and reconnect. If this continues, send the Login diagnostic reference to support.',
  login_account_changed:'The provider account or workspace changed during sign-in. Select the intended account, then reconnect from the extension.',
  login_endpoint_native_preparation_required:'ChatGPT requires browser preparation for this account. Python-only translation could not be enabled. No translation request was sent; OAuth/client-ID registration is not required.',
  login_endpoint_native_preparation_unavailable:'The ChatGPT endpoint did not accept Python-only request preparation. No translation request was sent. Reconnect or choose another supported provider.',
  login_endpoint_challenge_required:'The provider requires browser verification for this API connection. Endpoint translation is currently unavailable. Choose another supported provider or use its official API mode.',
  login_browser_relay_unavailable:'TextPhantom could not use a claude.ai tab in this browser. Keep the browser open with the extension enabled, sign in to claude.ai, then connect again.',
  login_provider_access_denied:'The provider denied access to this endpoint session. Check the provider account and reconnect before translating.',
  login_session_expired:'The provider session expired. Sign in to the provider again.',
  login_tab_closed:'The sign-in tab closed before the connection was verified. Connect again.',
  login_endpoint_response_invalid:'The provider returned an unknown endpoint response. This connection could not be confirmed. Send the Login diagnostic reference to support.',
  login_provider_temporarily_unavailable:'The provider\'s server is temporarily unavailable. This is not a problem with TextPhantom or your account. Connect again later.',
  login_setup_required:'This API needs an approved official provider Login registration. Contact the app administrator.',
  login_chatgpt_official_registration_incomplete:'ChatGPT did not finish registering TextPhantom. Connect again.',
  login_chatgpt_official_token_failed:'ChatGPT sign-in could not be completed. Connect again.',
  login_chatgpt_official_token_invalid:'ChatGPT sign-in could not be verified. Connect again.',
  login_chatgpt_official_grant_invalid:'The ChatGPT sign-in code expired. Connect again.',
  login_chatgpt_official_callback_invalid:'The ChatGPT sign-in reply did not match this connection. Connect again.',
  login_tab_busy:'The ChatGPT tab is still answering. Try again shortly.',
  login_quota_exceeded:'ChatGPT says the usage limit of this account is reached. Try again later.',
};

// ---- ChatGPT: choose Sign in with ChatGPT (paid plans) or the website tab (free) ----
const hexDigest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function chatgptCapture(mode,account,plan,reason=''){
  return {expected_identity:await hexDigest('chatgpt-'+mode+'\0'+account),credentials:{mode,account,plan},chatgptMode:mode,chatgptReason:reason};
}
/** After the website shows a signed-in account: decide the route, or start consent (returns null). */
async function chatgptDecide(ctx,capture){
  if(!/^[a-f0-9]{64}$/.test(capture?.account || ''))throw {code:'login_capture_unavailable'};
  const plan=/^[a-z0-9_.-]{1,40}$/.test(capture.plan || '')?capture.plan:'unknown';
  // Which route was chosen and why (plan word only; no ids or tokens).
  const decided=(mode,reason)=>{recordDiagnostic('login.chatgpt.route',{plan,mode,reason,trace_id:ctx.flow.traceId || ''},ctx.base);};
  if(plan === 'free' || plan === 'unknown'){decided('website','plan_'+plan);return chatgptCapture('website',capture.account,plan,'plan_'+plan);}
  const account=await officialAccount(capture.account);
  if(account && await officialAccessToken()){decided('official','token_kept');return chatgptCapture('official',account,plan);}
  decided('official','consent');
  // The sign-in may have used the person's own chatgpt.com tab; the consent
  // page (which TextPhantom closes after reading its answer) gets a tab of its own.
  const consentTab=await createTab({url:'about:blank',active:true});
  const pending=await beginOfficialSignIn(consentTab.id);
  if(!await same(ctx)){chrome.tabs.remove(consentTab.id,()=>void chrome.runtime.lastError);return null;}
  await setLoginSession({[LOGIN_PENDING_AUTH]:{...ctx.flow,tabId:consentTab.id,official:{...pending,plan,websiteAccount:capture.account}},
    [LOGIN_OUTCOME]:{scope:ctx.flow.scope,provider:ctx.flow.provider,flow_id:ctx.flow.flow_id,status:'processing',stage:'chatgpt_official_consent',expiresAt:ctx.flow.expiresAt,traceId:ctx.flow.traceId || ''}});
  recordDiagnostic('login.chatgpt.official_consent',{plan,trace_id:ctx.flow.traceId || ''},ctx.base);
  return null;
}
async function chatgptWebsiteFallback(ctx,official,reason){
  recordDiagnostic('login.chatgpt.website_fallback',{reason,plan:official.plan,trace_id:ctx.flow.traceId || ''},ctx.base);
  // Leave the consent page; the website route uses its own background tabs.
  chrome.tabs.update(ctx.flow.tabId,{url:'https://chatgpt.com/'},()=>void chrome.runtime.lastError);
  return chatgptCapture('website',official.websiteAccount,official.plan,reason);
}
/** Consent in progress: finish it, notice a refusal, or keep waiting (null). */
async function chatgptContinue(ctx){
  const official=ctx.flow.official;
  if(official.callbackUrl){
    const callback=readCallback(official.callbackUrl,official);
    if(callback.error === 'official_denied' || callback.error === 'official_unavailable')return chatgptWebsiteFallback(ctx,official,callback.error);
    if(callback.error)throw {code:'login_chatgpt_'+callback.error};
    try{const {account}=await finishOfficialSignIn(callback,official);return chatgptCapture('official',account,official.plan);}
    catch(error){throw {code:'login_chatgpt_'+(/^official_[a-z_]+$/.test(error.code || '')?error.code:'official_token_failed')};}
  }
  if(Date.now()-official.startedAt > 10*60000)throw {code:'login_auth_expired'};
  const tab=await getTab(ctx.flow.tabId).catch(()=>null);
  if(tab?.url && new URL(tab.url).origin === 'https://auth.openai.com' && tab.status === 'complete'){
    // Free/unsupported accounts get "This account can't access this app" (probe 0.7).
    const [result]=await chrome.scripting.executeScript({target:{tabId:ctx.flow.tabId,frameIds:[0]},func:()=>document.title}).catch(()=>[]);
    if(/can.?t access this app/i.test(String(result?.result || '')))return chatgptWebsiteFallback(ctx,official,'official_unavailable');
  }
  return null;
}
chrome.webNavigation?.onBeforeNavigate?.addListener(details=>{void (async()=>{
  if(details.frameId !== 0 || !String(details.url).startsWith(OFFICIAL_REDIRECT))return;
  const flow=(await readLoginState([LOGIN_PENDING_AUTH]))[LOGIN_PENDING_AUTH];
  if(flow?.transport !== 'web_endpoint' || flow.provider !== 'login_chatgpt' || !flow.official || flow.tabId !== details.tabId || flow.official.callbackUrl)return;
  // Keep the redirect (code + state) before closing the consent tab.
  await setLoginSession({[LOGIN_PENDING_AUTH]:{...flow,official:{...flow.official,callbackUrl:details.url}}});
  chrome.tabs.remove(details.tabId,()=>void chrome.runtime.lastError);
})();},{url:[{schemes:['http'],hostEquals:'127.0.0.1',ports:[1455]}]});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type !== 'TP_LOGIN_CHATGPT_FORGET')return;
  if(sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== chrome.runtime.getURL('popup/popup.html')){reply({ok:false});return false;}
  Promise.all([forgetOfficial(),forgetWebchats()]).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
});
const random=()=>[...crypto.getRandomValues(new Uint8Array(24))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function context(){
  const values=await readLoginState([LOGIN_PENDING_AUTH,'paidApiBase','paidSessionToken','loginProvider','loginModel']);
  const flow=values[LOGIN_PENDING_AUTH],base=String(values.paidApiBase || '').replace(/\/+$/,'');
  if(flow?.transport !== 'web_endpoint' || !ENDPOINT_PROVIDERS[flow.provider] || values.loginProvider !== flow.provider || !/^lgf_[a-f0-9]{48}$/.test(flow.flow_id || '') || !values.paidSessionToken || base !== flow.apiBase || await getApiBase({warm:false}) !== base || flow.scope !== await loginAuthScope(base,values.paidSessionToken))return null;
  const url=new URL(base);if(url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return null;
  return {flow,base,token:values.paidSessionToken,model:String(values.loginModel || '')};
}
async function same(ctx){const current=await context();return current?.flow.flow_id === ctx.flow.flow_id && current.flow.scope === ctx.flow.scope && current.flow.provider === ctx.flow.provider && current.flow.tabId === ctx.flow.tabId && current.flow.browserInstance === ctx.flow.browserInstance;}
async function post(ctx,suffix,body){
  const response=await fetch(ctx.base+'/login/providers/'+ctx.flow.provider+'/auth/'+suffix,{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(suffix === 'cancel'?5000:suffix === 'endpoint-import' && RELAY_PROVIDERS[ctx.flow.provider]?120000:45000),
    headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/json','X-TP-Trace-ID':ctx.flow.traceId || ''},body:JSON.stringify(body)});
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('The selected API did not return a Login response.'),{code:'login_endpoint_api_invalid'});}
  if(!response.ok)throw Object.assign(new Error(data?.error?.message || 'Endpoint Login failed.'),{code:data?.error?.code,status:response.status,stage:data?.error?.stage,upstreamStatus:data?.error?.upstream_status});
  return data;
}
async function fail(ctx,error){
  // Revoke the original authorized flow even if the popup changed scope.
  // The original API/owner/state remain pinned in ctx; never touch its replacement.
  if(error.code === 'login_tab_closed'){
    // A delayed tab event must never revoke an already-published connection.
    if(!await same(ctx))return;
    const result=await post(ctx,'cancel',{flow_id:ctx.flow.flow_id,reason:'tab_closed'}).catch(()=>null);
    if(result?.status === 'connected'){
      try{await commitConnection(ctx,result);return;}
      catch(commitError){error=commitError;}
    }
  }
  // An explicit abort, replaced owner, or invalid import still revokes its result.
  await post(ctx,'cancel',{flow_id:ctx.flow.flow_id}).catch(()=>{});
  if(!await same(ctx))return;
  const code=/^login_[a-z_]{1,80}$/.test(error.code || '')?error.code:'login_endpoint_failed';
  // These come from TextPhantom's own API and say what to fix in the website tab.
  const apiMessage=['login_provider_not_ready','login_endpoint_timeout'].includes(code) && typeof error.message === 'string' && /^[\x20-\x7e]{10,300}$/.test(error.message)?error.message:'';
  const safeMessage=apiMessage || failureMessages[code] || (error.status?'The selected API rejected this provider connection.':'The provider session could not be verified on the selected API.');
  recordDiagnostic('login.endpoint.failed',{provider:ctx.flow.provider,error_code:code,stage:error.stage || 'endpoint_validation',trace_id:ctx.flow.traceId || '',http_status:error.status || null,upstream_status:error.upstreamStatus || null},ctx.base);
  await setLoginSession({[LOGIN_PENDING_AUTH]:null,[LOGIN_OUTCOME]:{provider:ctx.flow.provider,scope:ctx.flow.scope,flow_id:ctx.flow.flow_id,status:'failed',expiresAt:Date.now()+300000,code,stage:error.stage || 'endpoint_validation',message:safeMessage,traceId:ctx.flow.traceId || '',upstreamStatus:error.upstreamStatus || null}});
}
async function commitConnection(ctx,data){
  // The API decides whether a provider is authentication-only.
  const authOnly=data?.authentication_only===true,models=data?.models;
  if(data?.status !== 'connected' || data?.session?.transport !== 'web_endpoint' || data.session.provider !== ctx.flow.provider ||
    !/^lgs_[a-f0-9]{48}$/.test(data.session.id || '') || !/^[a-f0-9]{32}$/.test(data.session.account_id || '') ||
    data.endpoint_validation !== 'identity_verified' || !Array.isArray(models) || models.length>100 ||
    (authOnly ? models.length!==0 : models.length===0) || models.some(row=>typeof row?.id!=='string' || !row.id.trim() || row.id.length>200) ||
    new Set(models.map(row=>row.id)).size!==models.length)throw {code:'login_endpoint_api_invalid'};
  const latest=await context();
  if(!latest || !await same(ctx)){await post(ctx,'cancel',{flow_id:ctx.flow.flow_id}).catch(()=>{});return;}
  if(ctx.flow.expiresAt<=Date.now()){await fail(ctx,{code:'login_auth_expired'});return;}
  const selected=models.some(row=>row.id===latest.model)?latest.model:models[0]?.id || '';
  // Commit the ordinary selection before the connected receipt. Page actions
  // must be ready without a popup; the popup must never supply missing state.
  await writeLoginState({loginModel:selected});
  if(!await same(ctx)){await post(ctx,'cancel',{flow_id:ctx.flow.flow_id}).catch(()=>{});return;}
  if(ctx.flow.expiresAt<=Date.now()){await fail(ctx,{code:'login_auth_expired'});return;}
  // Store only the opaque session handle. Never persist capture or an API response wholesale.
  const connections = (await getLoginSession(["loginConnectionsV2"])).loginConnectionsV2 || {};
  if(!await same(ctx)){await post(ctx,"cancel",{flow_id:ctx.flow.flow_id}).catch(()=>{});return;}
  connections[ctx.flow.scope+":"+ctx.flow.provider] = {session:{id:data.session.id,provider:ctx.flow.provider,account_id:data.session.account_id,transport:"web_endpoint"},model:selected,verifiedAt:Date.now()};
  const bounded = Object.fromEntries(Object.entries(connections).sort((a,b)=>(b[1]?.verifiedAt||0)-(a[1]?.verifiedAt||0)).slice(0,32));
  await setLoginSession({loginConnectionsV2:bounded,[LOGIN_PENDING_AUTH]:null,loginSessionId:data.session.id,loginAccountId:data.session.account_id,
    [LOGIN_OUTCOME]:{status:'connected',session:{id:data.session.id,provider:ctx.flow.provider,account_id:data.session.account_id,transport:'web_endpoint'},models:data.models,
      endpoint_validation:'identity_verified',generation_validation:'not_tested',provider:ctx.flow.provider,scope:ctx.flow.scope,flow_id:ctx.flow.flow_id,expiresAt:Date.now()+300000,traceId:ctx.flow.traceId || '',
      ...(ctx.chatgptMode?{chatgpt_mode:ctx.chatgptMode,chatgpt_reason:ctx.chatgptReason || ''}:{})}});
}
export async function wakeEndpointLogin(){
  // Storage/navigation may finish while startup or capture is awaiting IO.
  // Preserve that wake so the newest original flow is checked immediately.
  if(busy){rerun=true;return;}busy=true;if(timer)clearTimeout(timer);timer=null;
  let capture,importingFlowId;
  try{
    const ctx=await context();
    // The safety alarm exists only while a provider sign-in is pending.
    if(ctx)flowAlarm.arm();else void flowAlarm.disarm();
    if(!ctx || !ctx.flow.tabId)return;
    if(ctx.flow.expiresAt <= Date.now()){await fail(ctx,{code:'login_auth_expired'});return;}
    try{
      if(ctx.flow.provider === 'login_chatgpt' && ctx.flow.official){
        capture=await chatgptContinue(ctx);
        if(!capture){timer=setTimeout(()=>void wakeEndpointLogin(),1500);return;}
        if(!await same(ctx))return;
      }else{
      const tab=await getTab(ctx.flow.tabId);
      // Login may temporarily navigate to the official identity provider.
      // Wait for the original tab to return; never inject or read other origins.
      if(!tab?.url || new URL(tab.url).origin !== ENDPOINT_PROVIDERS[ctx.flow.provider].origin || tab.status === 'loading'){
        timer=setTimeout(()=>void wakeEndpointLogin(),1500);return;
      }
      try{capture=await captureEndpointLogin(ctx.flow.tabId,ctx.flow.provider);}
      catch(error){
        // A normal sign-in can replace the original first-party document while
        // the identity read is in flight. Re-read its fresh document; never
        // weaken capture validation or retry a submitted provider request.
        if(error.code === 'login_document_changed' && await same(ctx)){
          if(ctx.flow.expiresAt <= Date.now())await fail(ctx,{code:'login_auth_expired'});
          else timer=setTimeout(()=>void wakeEndpointLogin(),1500);
          return;
        }
        throw error;
      }
      if(!await same(ctx))return;
      if(ctx.flow.expiresAt <= Date.now()){await fail(ctx,{code:'login_auth_expired'});return;}
      if(!capture){timer=setTimeout(()=>void wakeEndpointLogin(),1500);return;}
      if(ctx.flow.provider === 'login_chatgpt'){
        capture=await chatgptDecide(ctx,capture);
        if(!capture)return;
      }
      }
      importingFlowId=ctx.flow.flow_id;importingFlows.add(importingFlowId);
      await setLoginSession({[LOGIN_OUTCOME]:{scope:ctx.flow.scope,provider:ctx.flow.provider,flow_id:ctx.flow.flow_id,status:'processing',stage:'endpoint_validation',expiresAt:ctx.flow.expiresAt,traceId:ctx.flow.traceId || ''}});
      // The API verifies Claude through this browser's own claude.ai tab.
      const releaseRelay=RELAY_PROVIDERS[ctx.flow.provider]?acquireBrowserRelay(ctx.base,ctx.token):()=>{};
      let data;
      try{data=await post(ctx,'endpoint-import',{flow_id:ctx.flow.flow_id,state:ctx.flow.state,browser_instance:ctx.flow.browserInstance,expected_identity:capture.expected_identity,credentials:capture.credentials});}
      finally{releaseRelay();}
      if(!await same(ctx)){
        await post(ctx,'cancel',{flow_id:ctx.flow.flow_id}).catch(()=>{});
        return;
      }
      if(capture.chatgptMode){ctx.chatgptMode=capture.chatgptMode;ctx.chatgptReason=capture.chatgptReason;}
      await commitConnection(ctx,data);
    }catch(error){await fail(ctx,error);}
  }finally{if(importingFlowId)importingFlows.delete(importingFlowId);if(capture?.credentials)for(const key of Object.keys(capture.credentials))delete capture.credentials[key];busy=false;
    if(rerun){rerun=false;queueMicrotask(()=>void wakeEndpointLogin());}}
}
/** Sign-in uses a tab of the website that is already open (the
 * person is often signed in there already); a tab is opened only when none is. */
async function providerTab(spec,{focus}){
  const open=(await queryTabs({url:spec.origin+'/*'}).catch(()=>[])).filter(tab=>{try{return new URL(tab.url).origin === spec.origin;}catch{return false;}})
    .sort((a,b)=>(b.lastAccessed || 0)-(a.lastAccessed || 0));
  const found=open.find(tab=>!tab.discarded) || open[0];
  if(found){
    // Connect pressed in the popup shows the tab; a translation does not switch tabs.
    if(focus)chrome.tabs.update(found.id,{active:true},()=>void chrome.runtime.lastError);
    return found;
  }
  return createTab({url:spec.url,active:focus});
}
async function openFlowTab(flowId,{focus=true}={}){
  const ctx=await context();if(!ctx || ctx.flow.flow_id !== flowId)throw {code:'login_auth_expired'};
  const spec=ENDPOINT_PROVIDERS[ctx.flow.provider];if(ctx.flow.url !== spec.url)throw {code:'login_origin_invalid'};
  const tab=await providerTab(spec,{focus});if(!await same(ctx))throw {code:'login_cancelled'};
  await setLoginSession({[LOGIN_PENDING_AUTH]:{...ctx.flow,tabId:tab.id,browserInstance:random()}});
  void wakeEndpointLogin();return {ok:true};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type !== 'TP_LOGIN_ENDPOINT_OPEN')return;
  if(sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== chrome.runtime.getURL('popup/popup.html')){reply({ok:false,code:'trusted_ui_only'});return false;}
  allowLoginTabs();  // .84: Connect pressed = the person wants the tab
  openFlowTab(message.flowId).then(reply,error=>reply({ok:false,code:error.code || 'login_endpoint_failed',message:'Could not start provider sign-in.'}));return true;
});

/**
 * Translating with a website Login (Claude, ChatGPT, Gemini,
 * DeepSeek) that is not connected yet connects it by itself — the same steps as
 * pressing Connect: start a flow on the selected API, use the open website tab
 * (or open one), read who is signed in there, verify on the API. The person only
 * has to sign in on the website if they are not signed in already.
 * Returns {started:true} or {started:false, reason}. Never asks for permissions
 * (that needs a click in the popup) and never types or submits anything.
 */
export async function autoConnectLogin(){
  const values=await readLoginState([LOGIN_PENDING_AUTH,'paidApiBase','paidSessionToken','loginProvider']);
  const provider=String(values.loginProvider || ''),spec=ENDPOINT_PROVIDERS[provider];
  if(!spec)return {started:false,reason:'not_website_login'};
  const pending=values[LOGIN_PENDING_AUTH];
  if(pending?.provider === provider && /^lgf_[a-f0-9]{48}$/.test(pending.flow_id || '') && (pending.expiresAt || 0)>Date.now())return {started:true,reason:'already_connecting'};
  const base=String(values.paidApiBase || '').replace(/\/+$/,''),token=String(values.paidSessionToken || '');
  if(!base || !token || await getApiBase({warm:false}) !== base)return {started:false,reason:'paid_sign_in_required'};
  const granted=await new Promise(resolve=>{try{chrome.permissions.contains({permissions:['cookies']},value=>resolve(!chrome.runtime.lastError && value === true));}catch{resolve(false);}});
  if(!granted)return {started:false,reason:'permission_required'};
  let data;
  try{
    const response=await fetch(base+'/login/providers/'+provider+'/auth/start',{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}'});
    data=await response.json().catch(()=>null);
    if(!response.ok)return {started:false,reason:/^login_[a-z_]{1,60}$/.test(data?.error?.code || '')?data.error.code:'login_start_failed'};
  }catch{return {started:false,reason:'login_start_failed'};}
  if(data?.transport !== 'web_endpoint' || !/^lgf_[a-f0-9]{48}$/.test(data.flow_id || '') || data.url !== spec.url)return {started:false,reason:'login_start_invalid'};
  const flow={...data,provider,apiBase:base,scope:await loginAuthScope(base,token),traceId:data.trace_id || '',expiresAt:Date.now()+300000,auto:true};
  await setLoginSession({[LOGIN_PENDING_AUTH]:flow,[LOGIN_OUTCOME]:null});
  recordDiagnostic('login.endpoint.auto_connect',{provider,trace_id:flow.traceId},base);
  try{await openFlowTab(flow.flow_id,{focus:false});}
  catch(error){return {started:false,reason:error.code || 'login_open_failed'};}
  return {started:true,reason:'started'};
}
setAutoConnect(autoConnectLogin);
chrome.tabs.onUpdated.addListener(()=>void wakeEndpointLogin());
chrome.tabs.onRemoved.addListener(tabId=>{void (async()=>{const ctx=await context();if(ctx?.flow.tabId === tabId){
  // Credentials already captured from the original document no longer depend
  // on this tab. Let the bounded verification and local commit finish.
  if(importingFlows.has(ctx.flow.flow_id)){recordDiagnostic('login.endpoint.tab_closed',{provider:ctx.flow.provider,stage:'endpoint_validation',outcome:'verification_continues',trace_id:ctx.flow.traceId || ''},ctx.base);return;}
  // TextPhantom closes the ChatGPT consent tab itself after reading the redirect.
  const latest=(await readLoginState([LOGIN_PENDING_AUTH]))[LOGIN_PENDING_AUTH];
  if(latest?.flow_id === ctx.flow.flow_id && latest.official?.callbackUrl){void wakeEndpointLogin();return;}
  await fail(ctx,{code:'login_tab_closed'});
}})();});
chrome.storage.onChanged.addListener((changes,area)=>{if(area === 'session' && changes[LOGIN_PENDING_AUTH]?.newValue?.transport === 'web_endpoint')void wakeEndpointLogin();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name === ALARM)void wakeEndpointLogin();});
void wakeEndpointLogin(); // arms the alarm only when a flow is pending
