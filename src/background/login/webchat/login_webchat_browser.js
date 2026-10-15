/** Owned normal-tab Login and per-run conversations. No cookie export. */
import {getTab} from '../../../shared/browser-api.js';
import {getLoginSession,setLoginSession} from '../../../shared/login-session.js';
export const WEBCHAT_CONNECTIONS = 'loginWebchatConnectionsV1';
export const WEBCHAT_TURNS = 'loginWebchatTurnsV1';
export const WEBCHAT_PROVIDERS = {
  login_chatgpt:{origin:'https://chatgpt.com',url:'https://chatgpt.com/'},
  login_claude:{origin:'https://claude.ai',url:'https://claude.ai/new'},
  login_gemini:{origin:'https://gemini.google.com',url:'https://gemini.google.com/app'},
  login_deepseek:{origin:'https://chat.deepseek.com',url:'https://chat.deepseek.com/'},
};
let writes=Promise.resolve();
export function updateWebchatState(key,change) {
  const result=writes.then(async()=>{const values=await getLoginSession([key]);const next=await change(values[key] || {});await setLoginSession({[key]:next});return next;});
  writes=result.catch(()=>{});return result;
}
export function sendWebchatTab(tabId,message,documentId='') {
  return new Promise((resolve,reject)=>chrome.tabs.sendMessage(tabId,{type:'TP_LOGIN_WEBCHAT_DOM',...message},{frameId:0,...(documentId?{documentId}:{})},value=>{
    const error=chrome.runtime.lastError;
    if(error)reject(Object.assign(new Error('The provider tab is unavailable. Reconnect.'),{code:'login_tab_disconnected'}));
    else if(!value?.ok)reject(Object.assign(new Error(value?.message || 'Website chat is not ready.'),{code:value?.code || 'login_browser_unavailable',stage:value?.stage}));else resolve(value);
  }));
}
export async function injectWebchatTab(tabId,provider) {
  const spec=WEBCHAT_PROVIDERS[provider],tab=await getTab(tabId);
  if(!spec || !tab?.url || new URL(tab.url).origin !== spec.origin)throw Object.assign(new Error('Complete sign-in on the provider website.'),{code:'login_origin_invalid'});
  const results=await new Promise((resolve,reject)=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:[
    'content/login/webchat/login_provider_'+provider.slice(6)+'.js','content/login/webchat/login_webchat_dom.js'
  ]},value=>{const error=chrome.runtime.lastError;if(error)reject(Object.assign(new Error('Cannot connect to the provider tab.'),{code:'login_tab_injection_failed'}));else resolve(value);}));
  const current=await getTab(tabId);
  if(!current?.url || new URL(current.url).origin !== spec.origin)throw Object.assign(new Error('The provider tab changed during connection.'),{code:'login_origin_invalid'});
  return results?.[0]?.documentId || '';
}
