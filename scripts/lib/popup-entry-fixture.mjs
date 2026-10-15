import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {webcrypto} from 'node:crypto';

// The production popup entry and every imported controller run unchanged in
// separate page realms. This DOM facade asserts text/control state, not pixels.
export async function popupEntryFixture({local={},session={},fetchReply,now=Date.now,apiSnapshot,manualTimers=false,runtimeReply,onStorageWrite,cryptoProvider=webcrypto}={}){
  const fields=new Map(),paints=[],events=new Map(),listeners=new Set(),timers=new Set(),errors=[];
  const root=path.resolve(fileURLToPath(new URL('../../src/',import.meta.url)));
  class Element {
    constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.style={};this.dataset={};this.attrs={};this.handlers=new Map();this._value='';this._text='';this.disabled=false;this.checked=false;this.hidden=false;this.open=false;this.isConnected=true;this.ownerDocument=document;this.classList={add(){},remove(){},contains:()=>false,toggle:()=>false};}
    get options(){return this.children.flatMap(x=>x.tagName==='OPTION'?[x]:x.options||[]);}
    get selectedOptions(){return this.options.filter(x=>x.value===this.value);}
    get value(){return this._value;}
    set value(value){this._value=String(value??'');}
    get textContent(){return this._text+this.children.map(x=>x.textContent||'').join('');}
    set textContent(value){this._text=String(value??'');this.children=[];if(this.id)paints.push({id:this.id,text:this._text});}
    set innerHTML(value){this.textContent=value||'';}
    get innerHTML(){return this.textContent;}
    append(...nodes){for(const node of nodes){if(node?.tagName==='#FRAGMENT')this.append(...node.children);else if(node){this.children.push(node);node.parentElement=this;}}}
    appendChild(node){this.append(node);return node;}
    insertBefore(node,before){const index=this.children.indexOf(before);if(index<0)this.append(node);else this.children.splice(index,0,node);return node;}
    prepend(...nodes){this.children.unshift(...nodes);}
    replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);if(this.id)paints.push({id:this.id,text:this.textContent});}
    setAttribute(key,value){this.attrs[key]=String(value);}
    getAttribute(key){return this.attrs[key]??null;}
    removeAttribute(key){delete this.attrs[key];}
    addEventListener(name,fn){const rows=this.handlers.get(name)||new Set();rows.add(fn);this.handlers.set(name,rows);}
    removeEventListener(name,fn){this.handlers.get(name)?.delete(fn);}
    dispatchEvent(event){event.target=this;for(const fn of this.handlers.get(event.type)||[])void fn(event);return true;}
    click(){this.dispatchEvent({type:'click',preventDefault(){}});}
    focus(){}
    querySelector(selector){if(selector==='summary'){let result=this.children.find(x=>x.tagName==='SUMMARY');if(!result){result=new Element('summary');this.append(result);}return result;}if(selector.startsWith('.'))return this.querySelectorAll('*').find(x=>String(x.attrs?.class||x.className||'').split(/\s+/).includes(selector.slice(1)))||null;return null;}
    querySelectorAll(selector){const rows=this.children.flatMap(x=>x.tagName?[x,...(x.querySelectorAll?.('*')||[])]:[]);return selector==='[data-tp-ui-value]'?rows.filter(x=>x.dataset.tpUiValue):selector==='*'?rows:[];}
    closest(){return null;}
    remove(){this.isConnected=false;}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const documentEvents=new Map();
  const document={visibilityState:'visible',getElementById:id=>fields.get(id)||null,querySelector:()=>null,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag),createDocumentFragment:()=>new Element('#fragment'),createTextNode:text=>({textContent:String(text)}),addEventListener(name,fn){const values=documentEvents.get(name)||new Set();values.add(fn);documentEvents.set(name,values);},removeEventListener(name,fn){documentEvents.get(name)?.delete(fn);}};
  document.documentElement=new Element('html');document.body=new Element('body');
  const html=await readFile(path.join(root,'popup/popup.html'),'utf8');
  for(const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
    const node=new Element(match[1],match[3]);node.value=/\bvalue="([^"]*)"/.exec(match[2])?.[1]||'';fields.set(node.id,node);
  }
  const read=(area,keys)=>keys==null?structuredClone(area):Array.isArray(keys)?Object.fromEntries(keys.filter(k=>k in area).map(k=>[k,structuredClone(area[k])])):Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,k in area?structuredClone(area[k]):v]));
  const area=(values,name)=>({get:(keys,fn)=>fn(read(values,keys)),set:(patch,fn)=>{onStorageWrite?.(patch,name,new Error().stack);const changes={};for(const [k,v]of Object.entries(patch))if(JSON.stringify(v)!==JSON.stringify(values[k]))changes[k]={oldValue:values[k],newValue:v};Object.assign(values,structuredClone(patch));fn?.();queueMicrotask(()=>{for(const listener of listeners)listener(changes,name);});},remove:(keys,fn)=>{for(const k of [].concat(keys))delete values[k];fn?.();}});
  const calls=[];
  const chrome={runtime:{lastError:null,getManifest:()=>({version:'2026.10.4.42'}),getURL:value=>'chrome-extension://fixture/'+value,sendMessage:(msg,callback)=>{const response=msg.type==='GET_API_STATUS'?(apiSnapshot===undefined?{ok:true,fresh:true,base:local.customApiUrl}:typeof apiSnapshot==='function'?apiSnapshot():apiSnapshot):msg.type==='TP_GET_TRANSLATION_SESSIONS'?{runs:[]}:msg.type==='TP_FLUSH_USAGE_RECEIPTS'?{ok:true}:runtimeReply?.(msg)??null;Promise.resolve(response).then(value=>callback?.(value));}},storage:{local:area(local,'local'),session:area(session,'session'),onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},permissions:{request:(_request,fn)=>fn(true)},tabs:{query:(_q,fn)=>fn([])},extension:{getViews:()=>[window]}};
  const virtualTimers=new Map();
  const virtualTimer=(fn,ms,repeating)=>{const id={unref(){}};virtualTimers.set(id,{fn,at:now()+ms,ms,repeating});return id;};
  const setTimer=(fn,ms)=>{if(manualTimers)return virtualTimer(fn,ms,false);const id=setTimeout(fn,ms);id.unref?.();timers.add(id);return id;};
  const setRepeating=(fn,ms)=>{if(manualTimers)return virtualTimer(fn,ms,true);const id=setInterval(fn,ms);id.unref?.();timers.add(id);return id;};
  const clearTimer=id=>manualTimers?virtualTimers.delete(id):clearTimeout(id);
  const window={addEventListener:(name,fn)=>{const set=events.get(name)||new Set();set.add(fn);events.set(name,set);},removeEventListener:(name,fn)=>events.get(name)?.delete(fn),close(){},location:{protocol:'chrome-extension:',href:'chrome-extension://fixture/popup/popup.html'}};
  class Clock extends Date {static now(){return now();}}
  const context=vm.createContext({window,document,chrome,location:window.location,Node:Element,console:{log(){},warn(){},error:(...args)=>errors.push(args.join(' ')),info(){},debug(){}},URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,AbortSignal,Response,Headers,Request,structuredClone,crypto:cryptoProvider,Date:Clock,Intl,queueMicrotask,setTimeout:setTimer,clearTimeout:clearTimer,setInterval:setRepeating,clearInterval:clearTimer,Event:class{constructor(type,opts={}){this.type=type;Object.assign(this,opts);}preventDefault(){}},navigator:{onLine:true},performance,fetch:async(url,opts={})=>{calls.push({url:String(url),method:opts.method||'GET',body:opts.body});return fetchReply(String(url),opts);}});
  const modules=new Map();
  async function get(file){if(modules.has(file))return modules.get(file);const relative=path.relative(root,file).replaceAll('\\','/');const baseline=relative==='popup/controllers/api-health-controller.js'?process.env.TP_API_HEALTH_BASELINE:relative==='popup/controllers/login-service-controller.js'?process.env.TP_LOGIN_CONTROLLER_BASELINE:relative==='popup/controllers/paid-service-controller.js'?process.env.TP_PAID_CONTROLLER_BASELINE:null;const source=await readFile(baseline||file,'utf8');const module=new vm.SourceTextModule(source,{context,identifier:file,initializeImportMeta:meta=>{meta.url='file:///'+file.replaceAll('\\','/');}});modules.set(file,module);return module;}
  const entry=await get(path.join(root,'popup/popup.js'));
  await entry.link((specifier,module)=>get(path.resolve(path.dirname(module.identifier),specifier)));
  await entry.evaluate();
  return {fields,paints,calls,errors,local,session,modules,writeLocal:patch=>chrome.storage.local.set(patch),writeSession:patch=>chrome.storage.session.set(patch),setVisibility(value){document.visibilityState=value;for(const fn of documentEvents.get('visibilitychange')||[])fn({type:'visibilitychange'});},runDueTimers(){for(let count=0;count<1000;count++){const next=[...virtualTimers].filter(([,row])=>row.at<=now()).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return;if(next[1].repeating)next[1].at=now()+next[1].ms;else virtualTimers.delete(next[0]);next[1].fn();}throw new Error('Too many due fixture timers');},async settle(turns=50){for(let i=0;i<turns;i++)await new Promise(resolve=>setImmediate(resolve));},close(){for(const fn of events.get('pagehide')||[])fn({type:'pagehide'});for(const timer of timers)clearTimeout(timer);virtualTimers.clear();listeners.clear();}};
}
