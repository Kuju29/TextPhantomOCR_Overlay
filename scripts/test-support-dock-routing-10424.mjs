import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const fixtures=new Map(),calls=[];let injecting=0,maxInjecting=0;
globalThis.chrome={runtime:{lastError:null,getManifest:()=>({version:'2026.10.4.24'})},tabs:{
 get(id,cb){const f=fixtures.get(id);cb({id,url:f.url||'https://ordinary.example/page'});},
 sendMessage(id,body,options,cb){calls.push({id,body,options});const f=fixtures.get(id);
  if(body.type==='TP_SUPPORT_PING'){if(f.missing){chrome.runtime.lastError={message:'Receiving end does not exist'};cb();chrome.runtime.lastError=null;}else cb({ready:true,version:f.version||'2026.10.4.24'});}
  else if(f.dropOpen){chrome.runtime.lastError={message:'Document changed'};cb();chrome.runtime.lastError=null;}else cb({ok:!f.admin});},
 create(){throw Error('Tab fallback forbidden');},update(){throw Error('Tab fallback forbidden');}},
 scripting:{executeScript(options,cb){calls.push({inject:options});const f=fixtures.get(options.target.tabId);
  if(f.denied){chrome.runtime.lastError={message:'Cannot access page'};cb();chrome.runtime.lastError=null;return;}
  maxInjecting=Math.max(maxInjecting,++injecting);setTimeout(()=>{injecting--;f.missing=false;f.version='2026.10.4.24';cb([{frameId:0,documentId:'document-'+options.target.tabId}]);},10);}}};
const {openSupportDock}=await import('../src/background/support-dock.js');
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});}
await test('Healthy current top receiver opens in place without injection',async()=>{fixtures.set(1,{});calls.length=0;assert.equal((await openSupportDock(1)).ok,true);assert.equal(calls.length,2);assert.deepEqual(calls[0].options,{frameId:0});assert.equal(calls[1].body.type,'TP_SUPPORT_OPEN');});
await test('Missing receiver injects only the packaged top dock and pins document',async()=>{fixtures.set(2,{missing:true});calls.length=0;assert.equal((await openSupportDock(2)).ok,true);assert.deepEqual(calls.find(x=>x.inject).inject,{target:{tabId:2,frameIds:[0]},files:['content/support-dock.js']});assert.deepEqual(calls.at(-1).options,{documentId:'document-2'});});
await test('Old version is replaced instead of accepted',async()=>{fixtures.set(3,{version:'2026.10.4.23'});calls.length=0;assert.equal((await openSupportDock(3)).ok,true);assert.equal(calls.filter(x=>x.inject).length,1);});
await test('Concurrent Contacts serialize and reinject once',async()=>{fixtures.set(4,{missing:true});calls.length=0;assert((await Promise.all([openSupportDock(4),openSupportDock(4),openSupportDock(4)])).every(x=>x.ok));assert.equal(calls.filter(x=>x.inject).length,1);assert.equal(maxInjecting,1);});
await test('A reply notice repairs to a minimized notification only',async()=>{fixtures.set(5,{missing:true});calls.length=0;assert.equal((await openSupportDock(5,'minimized')).ok,true);assert.equal(calls.at(-1).body.type,'TP_SUPPORT_NOTICE');assert(!calls.some(x=>x.body?.type==='TP_SUPPORT_OPEN'));});
await test('Internal pages cannot inject or create a fallback tab',async()=>{fixtures.set(6,{url:'chrome://extensions'});calls.length=0;assert.equal((await openSupportDock(6)).code,'SUPPORT_PAGE_UNAVAILABLE');assert.equal(calls.length,0);});
await test('Permission denial is handled without a new tab',async()=>{fixtures.set(7,{missing:true,denied:true});assert.equal((await openSupportDock(7)).code,'SUPPORT_DOCK_UNAVAILABLE');});
await test('Later retry recovers after a failed attempt',async()=>{fixtures.get(7).denied=false;assert.equal((await openSupportDock(7)).ok,true);});
await test('Navigation cannot redirect a pinned OPEN to another document',async()=>{fixtures.set(8,{missing:true,dropOpen:true});calls.length=0;assert.equal((await openSupportDock(8)).code,'SUPPORT_DOCK_UNAVAILABLE');assert.deepEqual(calls.at(-1).options,{documentId:'document-8'});});
await test('Admin surface refusal stays in the original tab',async()=>{fixtures.set(9,{admin:true});assert.equal((await openSupportDock(9)).ok,false);});
await test('Popup has authored status and no create/update-tab fallback',async()=>{const s=readFileSync(new URL('../src/support/popup-entry.js',import.meta.url),'utf8');assert(!/createTab|tabs\.create|tabs\.update|support\/chat\.html/.test(s));assert(s.includes('TP_SUPPORT_SHOW'));assert(s.includes('contact-admin-status'));const {UI_TEXT}=await import('../src/shared/ui-text.js');for(const t of ['Open a regular website to contact admin.','Chat could not open. Try again on this page.'])assert(UI_TEXT.has(t));});
console.log(JSON.stringify({checks:results.length,passed:results.length,scope:'Production routing with simulated Chrome API; not installed-extension evidence',results},null,2));
