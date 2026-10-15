/** Login completion continues with the popup closed. Browser session metadata is RAM-only. */
import {readLoginState,setLoginSession,getLoginSession} from '../../../shared/login-session.js';
import {LOGIN_PENDING_AUTH,LOGIN_OUTCOME,loginAuthScope} from '../../../shared/login-auth.js';
import {createTab} from '../../../shared/browser-api.js';
import {getApiBase} from '../../api.js';
import {recordDiagnostic} from '../../../shared/diagnostics.js';
import {WEBCHAT_PROVIDERS,WEBCHAT_CONNECTIONS,WEBCHAT_TURNS,updateWebchatState,injectWebchatTab,sendWebchatTab} from './login_webchat_browser.js';
const ALARM='textphantom-login-webchat';let busy=false,timer=null;
// The safety alarm exists only while a sign-in flow is pending (it covers a
// suspended worker's lost 1.5 s timer); none while idle. Inline on purpose: this
// worker's dependency list is fixed.
let alarmArmed=null;
const flowAlarm={arm(){if(alarmArmed===true)return;alarmArmed=true;try{chrome.alarms?.create?.(ALARM,{periodInMinutes:0.5});}catch{}},
  disarm(){if(alarmArmed===false)return;alarmArmed=false;try{chrome.alarms?.clear?.(ALARM,()=>{void chrome.runtime?.lastError;});}catch{}}};
let probeFlow='',probeSignature='';
const random=()=>[...crypto.getRandomValues(new Uint8Array(24))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function context() {
  const values=await readLoginState([LOGIN_PENDING_AUTH,'paidApiBase','paidSessionToken']);
  const flow=values[LOGIN_PENDING_AUTH],base=String(values.paidApiBase || '').replace(/\/+$/,'');
  if(flow?.transport !== 'browser_webchat' || !WEBCHAT_PROVIDERS[flow.provider] || !/^lgf_[a-f0-9]{48}$/.test(flow.flow_id || '') || !values.paidSessionToken || base !== flow.apiBase || await getApiBase({warm:false}) !== base || flow.scope !== await loginAuthScope(base,values.paidSessionToken))return null;
  return {flow,base,token:values.paidSessionToken};
}
async function post(ctx,suffix,body) {
  const response=await fetch(ctx.base+'/login/providers/'+ctx.flow.provider+'/auth/'+suffix,{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/json','X-TP-Trace-ID':ctx.flow.traceId || ''},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data?.error?.message || 'Website Login verification failed.'),{code:data?.error?.code,status:response.status,stage:data?.error?.stage});return data;
}
async function same(ctx){const current=await context();return current?.flow.flow_id === ctx.flow.flow_id && current.flow.scope === ctx.flow.scope;}
async function fail(ctx,error) {
  if(!await same(ctx))return;
  recordDiagnostic('login.webchat.failed',{provider:ctx.flow.provider,error_code:error.code || 'login_browser_failed',stage:error.stage || 'browser_ready',trace_id:ctx.flow.traceId || ''},ctx.base);
  await setLoginSession({[LOGIN_PENDING_AUTH]:null,[LOGIN_OUTCOME]:{provider:ctx.flow.provider,scope:ctx.flow.scope,flow_id:ctx.flow.flow_id,status:'failed',expiresAt:Date.now()+300000,code:error.code || 'login_browser_failed',stage:error.stage || 'browser_ready',message:error.message,traceId:ctx.flow.traceId || ''}});
}
async function wakeWebchatLogin() {
  if(busy)return;busy=true;if(timer)clearTimeout(timer);timer=null;
  try {
    const ctx=await context();
    // The safety alarm exists only while a website sign-in is pending.
    if(ctx)flowAlarm.arm();else void flowAlarm.disarm();
    if(!ctx || !ctx.flow.tabId)return;
    if(ctx.flow.expiresAt <= Date.now()){await fail(ctx,Object.assign(new Error('Website sign-in expired. Start again.'),{code:'login_auth_expired'}));return;}
    try {
      const documentId=await injectWebchatTab(ctx.flow.tabId,ctx.flow.provider);
      const probe=await sendWebchatTab(ctx.flow.tabId,{action:'probe',provider:ctx.flow.provider},documentId);
      if(!await same(ctx))return;
      const evidence={stage:probe.stage,code:probe.code || '',composer_present:probe.composer_present === true,
        composer_enabled:probe.composer_enabled === true,challenge_present:probe.challenge_present === true,
        identity_present:probe.identity_present === true,...(Number.isInteger(probe.session_http_status)?{session_http_status:probe.session_http_status}:{})};
      const signature=JSON.stringify(evidence);
      if(probeFlow !== ctx.flow.flow_id || probeSignature !== signature){
        probeFlow=ctx.flow.flow_id;probeSignature=signature;
        // Safe client observations go through the Login API trace/stdout even
        // with TP_LOG_FILE off. Logging never blocks the connection itself.
        void post(ctx,'browser-progress',{flow_id:ctx.flow.flow_id,state:ctx.flow.state,...evidence}).catch(()=>{});
      }
      if(!probe.ready){
        await setLoginSession({[LOGIN_OUTCOME]:{scope:ctx.flow.scope,provider:ctx.flow.provider,flow_id:ctx.flow.flow_id,status:'processing',stage:probe.stage,code:probe.code || '',sessionHttpStatus:probe.session_http_status,expiresAt:ctx.flow.expiresAt,traceId:ctx.flow.traceId || ''}});
        timer=setTimeout(()=>void wakeWebchatLogin(),1500);return;
      }
      const data=await post(ctx,'browser-complete',{flow_id:ctx.flow.flow_id,state:ctx.flow.state,browser_instance:ctx.flow.browserInstance,model_label:probe.modelLabel});
      if(!await same(ctx))return;
      await updateWebchatState(WEBCHAT_CONNECTIONS,async rows=>await same(ctx)?({...Object.fromEntries(Object.entries(rows).filter(([,row])=>row.scope === ctx.flow.scope && row.apiBase === ctx.base && row.provider !== ctx.flow.provider)),[data.session.id]:{sessionId:data.session.id,provider:ctx.flow.provider,scope:ctx.flow.scope,apiBase:ctx.base,browserInstance:ctx.flow.browserInstance,tabId:ctx.flow.tabId,documentId,accountFingerprint:probe.accountFingerprint,modelLabel:probe.modelLabel,runs:{}}}):rows);
      if(!await same(ctx))return;
      await setLoginSession({[LOGIN_PENDING_AUTH]:null,loginSessionId:data.session.id,loginAccountId:data.session.account_id,
        [LOGIN_OUTCOME]:{...data,provider:ctx.flow.provider,scope:ctx.flow.scope,flow_id:ctx.flow.flow_id,status:'connected',expiresAt:Date.now()+300000,traceId:ctx.flow.traceId || ''}});
    }catch(error){
      if([400,401,403,404,410,422].includes(error.status) || ['login_tab_closed'].includes(error.code))await fail(ctx,error);
      else {
        if(await same(ctx)) {
          const code=error.code || (error.name === 'TimeoutError'?'login_status_timeout':'login_status_network');
          recordDiagnostic('login.webchat.connection_failed',{provider:ctx.flow.provider,error_code:code,stage:error.stage || 'status_network',trace_id:ctx.flow.traceId || '',http_status:error.status || null,retryable:true},ctx.base);
          await setLoginSession({[LOGIN_OUTCOME]:{scope:ctx.flow.scope,provider:ctx.flow.provider,flow_id:ctx.flow.flow_id,status:'processing',stage:error.stage || 'status_network',code,expiresAt:ctx.flow.expiresAt,traceId:ctx.flow.traceId || ''}});
        }
        timer=setTimeout(()=>void wakeWebchatLogin(),1500);
      }
    }
  }finally{busy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type === 'TP_LOGIN_WEBCHAT_STAGE') {
    if(sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0)return;
    void (async()=>{const rows=(await getLoginSession([WEBCHAT_TURNS]))[WEBCHAT_TURNS] || {};const row=rows[message.turnId];
      if(!row || row.tabId !== sender.tab.id || row.documentId && row.documentId !== sender.documentId || new URL(sender.url || '').origin !== WEBCHAT_PROVIDERS[row.provider]?.origin)return;
      if(!['submitted','reply_started','reply_finished'].includes(message.stage))return;
      await updateWebchatState(WEBCHAT_TURNS,latest=>latest[message.turnId]?{...latest,[message.turnId]:{...latest[message.turnId],stage:message.stage}}:latest);
      recordDiagnostic('login.webchat.stage',{provider:row.provider,stage:message.stage,run_id:row.runId,operation_id:row.operationId,trace_id:row.traceId || ''},row.apiBase);
      if(message.stage !== 'reply_finished') {
        const values=await readLoginState(['paidSessionToken','paidApiBase',WEBCHAT_CONNECTIONS]);
        const connection=values[WEBCHAT_CONNECTIONS]?.[row.sessionId];
        if(!connection || values.paidApiBase !== row.apiBase || connection.scope !== await loginAuthScope(row.apiBase,values.paidSessionToken))return;
        await fetch(row.apiBase+'/login/webchat/turn',{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),
          headers:{Authorization:'Bearer '+values.paidSessionToken,'Content-Type':'application/json','X-TP-Trace-ID':row.traceId || ''},
          body:JSON.stringify({session_id:row.sessionId,browser_instance:connection.browserInstance,turn_id:message.turnId,stage:message.stage})});
      }
    })().catch(()=>{});return;
  }
  if(message?.type !== 'TP_LOGIN_WEBCHAT_OPEN')return;
  if(sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || sender.tab && !sender.url.startsWith(chrome.runtime.getURL(''))){reply({ok:false,code:'trusted_ui_only'});return false;}
  (async()=>{const ctx=await context();if(!ctx || ctx.flow.flow_id !== message.flowId)throw Object.assign(new Error('Website sign-in changed. Start again.'),{code:'login_auth_expired'});
    const spec=WEBCHAT_PROVIDERS[ctx.flow.provider];if(ctx.flow.url !== spec.url)throw Object.assign(new Error('Invalid provider website URL.'),{code:'login_origin_invalid'});
    const tab=await createTab({url:spec.url,active:true});
    if(!await same(ctx))throw Object.assign(new Error('Sign-in was cancelled.'),{code:'login_cancelled'});
    await setLoginSession({[LOGIN_PENDING_AUTH]:{...ctx.flow,tabId:tab.id,browserInstance:random()}});void wakeWebchatLogin();return {ok:true};
  })().then(reply,error=>reply({ok:false,code:error.code || 'login_browser_failed',message:error.message}));return true;
});
chrome.tabs.onUpdated.addListener(()=>void wakeWebchatLogin());
chrome.tabs.onRemoved.addListener(tabId=>{
  void updateWebchatState(WEBCHAT_CONNECTIONS,rows=>Object.fromEntries(Object.entries(rows).map(([key,row])=>[key,{...row,runs:Object.fromEntries(Object.entries(row.runs || {}).filter(([,run])=>run.tabId !== tabId))}])));
  void (async()=>{const ctx=await context();if(ctx?.flow.tabId === tabId)await fail(ctx,Object.assign(new Error('The sign-in tab was closed.'),{code:'login_tab_closed'}));})();
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area === 'session' && changes[LOGIN_PENDING_AUTH]?.newValue?.transport === 'browser_webchat')void wakeWebchatLogin();
  const oldSession=area === 'session' && changes.loginSessionId?.oldValue;
  if(oldSession && oldSession !== changes.loginSessionId.newValue) {
    if(!changes.loginSessionId.newValue)void updateWebchatState(WEBCHAT_CONNECTIONS,rows=>Object.fromEntries(Object.entries(rows).filter(([id])=>id !== oldSession)));
    void (async()=>{const rows=(await getLoginSession([WEBCHAT_TURNS]))[WEBCHAT_TURNS] || {};
      await Promise.allSettled(Object.entries(rows).filter(([,row])=>row.sessionId === oldSession && row.stage !== 'done').map(([id,row])=>sendWebchatTab(row.tabId,{action:'cancel',turnId:id},row.documentId)));
    })();
  }
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name === ALARM)void wakeWebchatLogin();});
void wakeWebchatLogin(); // arms the alarm only when a flow is pending
