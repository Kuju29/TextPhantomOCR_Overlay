import assert from 'node:assert/strict';
import {createUiLanguageController,UI_LANGUAGE_KEY} from '../src/shared/ui-language.js';
import {UI_CACHE_KEY,UI_CACHE_VERSION,boundedUiCache} from '../src/shared/ui-language-policy.js';
import {UI_TEXT} from '../src/shared/ui-text.js';
import {uiTemplate} from '../src/shared/ui-template.js';
import {uiLanguageDomFixture} from './lib/ui-language-dom-fixture.mjs';
const checks=[];const test=async(name,fn)=>{await fn();checks.push(name);};
const translate=url=>new URL(url).searchParams.get('q').split('\n').map(line=>'แปล '+line).join('\n');
const result=url=>new Response(JSON.stringify([[[translate(url)]]]),{status:200});
const store={};const storage={get:async()=>structuredClone(store),set:async patch=>Object.assign(store,structuredClone(patch))};
await test('DOM mutation does not abort or repeat in-flight translation of the unchanged source/language',async()=>{
 const dom=uiLanguageDomFixture(),label=dom.element('AI settings');let calls=[],pending=[];
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:(url,opts)=>{calls.push({url,signal:opts.signal});return new Promise((resolve,reject)=>{pending.push(()=>resolve(result(url)));opts.signal.addEventListener('abort',()=>reject(new Error('aborted')));});}});
 await controller.ready;const selecting=controller.select('th');await dom.settle();
 const initial=calls.length;assert(initial>0);dom.element('AI settings','button');await dom.settle();
 assert.equal(calls.length,initial,'New DOM copy of the same label must join the current translation, not dispatch it again.');
 assert(calls.every(call=>!call.signal.aborted),'Current-language requests must not be canceled by ordinary UI redraws.');
 for(const release of pending.splice(0))release();await selecting;await dom.settle();assert.match(label.textContent,/^แปล /);controller.dispose();dom.restore();
});
await test('Same-language cached selection and refresh never restore original copy or paint loading',async()=>{
 const dom=uiLanguageDomFixture();const label=dom.element('AI settings');let calls=0;
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:url=>{calls++;return Promise.resolve(result(url));}});await controller.ready;const before=calls,paint=dom.states.length,text=dom.writes.length;
 await controller.select('th');await controller.refresh();await dom.settle();assert.equal(calls,before);assert(!dom.states.slice(paint).includes('loading'));assert(!dom.writes.slice(text).includes('AI settings'));assert.match(label.textContent,/^แปล /);controller.dispose();dom.restore();
});
await test('A cached phrase is shared across popup/account contexts and fresh dynamic copies',async()=>{
 const dom=uiLanguageDomFixture({pathname:'/paid/account.html'}),label=dom.element('AI settings','button');let calls=0;
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:()=>{calls++;throw new Error('No networking for cached copy');}});await controller.ready;await dom.settle();assert.equal(calls,0);assert.match(label.textContent,/^แปล /);
 dom.element('AI settings','label');await dom.settle();assert.equal(calls,0);assert(!dom.states.includes('loading'));controller.dispose();dom.restore();
});
await test('Legacy page-context cache migrates without requesting or replacing its unchanged translation',async()=>{
 const values=store[UI_CACHE_KEY].entries;const entry=values.find(([key])=>key.endsWith('\0AI settings'));assert(entry);entry[0]='th\0popup:main:button\0AI settings';
 const dom=uiLanguageDomFixture({pathname:'/paid/account.html'});const label=dom.element('AI settings','button');let calls=0;
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:()=>{calls++;throw new Error('Offline');}});await controller.ready;assert.equal(calls,0);assert.match(label.textContent,/^แปล /);controller.dispose();dom.restore();
});
await test('A new source waits behind active work and requests only the new phrase once',async()=>{
 const dom=uiLanguageDomFixture();const label=dom.element('AI translation');const values={},pending=[],calls=[];
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage:{get:async()=>values,set:async patch=>Object.assign(values,patch)},fetcher:(url,opts)=>{calls.push({url,signal:opts.signal});return new Promise(resolve=>pending.push(()=>resolve(result(url))));}});await controller.ready;
 const selected=controller.select('th');await dom.settle();const first=pending.splice(0);label.textContent='Target language';await dom.settle();assert.equal(calls.length,first.length);assert(calls.every(call=>!call.signal.aborted));for(const release of first)release();await dom.settle();assert.equal(pending.length,1);assert.equal(new URL(calls.at(-1).url).searchParams.get('q'),'Target language');pending.shift()();await selected;assert.match(label.textContent,/^แปล Target language/);controller.dispose();dom.restore();
});
await test('Selected-language cache retains all authored phrases independently of other languages',async()=>{
 const phrases=[...UI_TEXT].slice(0,800);const entries=[];for(const language of ['th','ja','ko','de'])for(const source of phrases)entries.push([language+'\0interface:main:text\0'+source,'แปล '+source]);
 const kept=boundedUiCache(entries);assert.equal(kept.filter(([key])=>key.startsWith('th\0')).length,phrases.length,'Other languages must not evict unchanged Thai phrases.');
 assert(kept.length<=20*1500);const one=boundedUiCache(Array.from({length:3000},(_,i)=>['th\0interface:main:text\0'+i,'x'.repeat(500)]));assert(one.length<=1500);assert(one.reduce((sum,[k,v])=>sum+Buffer.byteLength(k)+Buffer.byteLength(v),0)<=200000);
});
await test('Private values stay local while a newly authored source is translated once and persists',async()=>{
 const dom=uiLanguageDomFixture();const label=dom.element('Target language');dom.element('PRIVATE_USER_MESSAGE');dom.element('AI settings','p',{'data-tp-ui-private':''});const template=uiTemplate('{credits} TP added to your account.',{credits:'PRIVATE_VALUE'});dom.root.append(template);const calls=[];
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:url=>{calls.push(url);return Promise.resolve(result(url));}});await controller.ready;await dom.settle();assert.match(label.textContent,/^แปล /);assert(!calls.some(url=>decodeURIComponent(url).includes('PRIVATE')));assert(template.textContent.includes('PRIVATE_VALUE'));assert.equal(store[UI_CACHE_KEY].version,UI_CACHE_VERSION);assert(!JSON.stringify(store[UI_CACHE_KEY]).includes('PRIVATE'));controller.dispose();dom.restore();
 const next=uiLanguageDomFixture();const reopened=next.element('Target language');let invoked=0;const again=createUiLanguageController({root:next.root,host:next.host,storage,fetcher:()=>{invoked++;throw new Error('Offline');}});await again.ready;assert.equal(invoked,0);assert.match(reopened.textContent,/^แปล /);again.dispose();next.restore();
});
await test('Changing language invalidates only its active requests and never applies their late translations',async()=>{
 const dom=uiLanguageDomFixture();dom.element('Text output');const pending=[];
 const controller=createUiLanguageController({root:dom.root,host:dom.host,storage,fetcher:(url,opts)=>new Promise(resolve=>pending.push({url,signal:opts.signal,release:()=>resolve(result(url))}))});
 const ready=controller.ready;await dom.settle();for(const item of pending.splice(0))item.release();await ready;
 const ja=controller.select('ja');await dom.settle();const old=pending.splice(0);assert(old.length);await controller.select('');assert(old.every(item=>item.signal.aborted));for(const item of old)item.release();await ja;assert.equal(dom.root.querySelectorAll('*').find(node=>node.tagName==='P').textContent,'Text output');assert.equal(store[UI_LANGUAGE_KEY],'');controller.dispose();dom.restore();
});
console.log(JSON.stringify({passed:true,count:checks.length,checks,scope:'Production UI-language controller and policies with text/attribute/observer DOM facade; deterministic Google adapter, no live provider or browser pixels'}));
