import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';
const src=fs.readFileSync(path.resolve(import.meta.dirname,'../src/content/download/preferences.js'),'utf8');
function fixture({seed={},delayRead=false,failWrite=false}={}){
 const window={__TP:{}};window.top=window;const stored={...seed},listeners=[],writes=[];let getCallback;
 const chrome={runtime:{lastError:null},storage:{onChanged:{addListener(fn){listeners.push(fn);}},local:{
 get(_keys,cb){if(delayRead)getCallback=()=>cb({...seed});else cb({...stored});},
 set(patch,cb){writes.push(patch);queueMicrotask(()=>{if(failWrite){chrome.runtime.lastError={message:'storage unavailable'};cb();chrome.runtime.lastError=null;return;}Object.assign(stored,patch);for(const fn of listeners)fn(Object.fromEntries(Object.entries(patch).map(([k,newValue])=>[k,{newValue}])),'local');cb();});}
 }}};
 vm.runInNewContext(src,{window,chrome,Set,Promise,Number,Object,Error});
 return {prefs:window.__TP.downloads.preferences,stored,writes,finishRead:()=>getCallback?.(),change(patch){for(const fn of listeners)fn(Object.fromEntries(Object.entries(patch).map(([k,newValue])=>[k,{newValue}])),'local');}};
}
let checks=0;const ok=(label,value)=>{assert.ok(value,label);checks++;console.log('PASS',label);};
const x=fixture();await x.prefs.ready;
ok('default keeps existing image formats',x.prefs.snapshot().format==='auto');
ok('default quality and tab',x.prefs.snapshot().quality===92&&x.prefs.snapshot().kind==='translated');
await x.prefs.set({format:'webp',quality:76,kind:'original',individual:true});
ok('persistent extension keys only',Object.keys(x.stored).sort().join(',')==='downloadImageFormat,downloadImageQuality,downloadIndividualExpanded,downloadSelectedTab');
const reopened=fixture({seed:x.stored});await reopened.prefs.ready;
ok('rehydrates all four settings',JSON.stringify(reopened.prefs.snapshot())===JSON.stringify(x.prefs.snapshot()));
const race=fixture({seed:{downloadImageFormat:'png'},delayRead:true});await race.prefs.set({format:'jpeg'});race.finishRead();await race.prefs.ready;
ok('late startup get cannot undo user change',race.prefs.snapshot().format==='jpeg');
const a=x.prefs.set({format:'png'}),b=x.prefs.set({format:'webp'}),c=x.prefs.set({format:'jpeg'});await Promise.all([a,b,c]);
ok('quick changes persist last choice',x.stored.downloadImageFormat==='jpeg'&&x.prefs.snapshot().format==='jpeg');
x.change({downloadImageQuality:50});ok('other-tab setting event applied',x.prefs.snapshot().quality===50);
x.change({downloadImageFormat:undefined,downloadImageQuality:undefined,downloadSelectedTab:undefined,downloadIndividualExpanded:undefined});
ok('reset/removal restores defaults',JSON.stringify(x.prefs.snapshot())===JSON.stringify({format:'auto',quality:92,kind:'translated',individual:false}));
const invalid=fixture({seed:{downloadImageFormat:'exe',downloadImageQuality:'bad',downloadSelectedTab:'other',downloadIndividualExpanded:'true'}});await invalid.prefs.ready;
ok('invalid storage values normalized',JSON.stringify(invalid.prefs.snapshot())===JSON.stringify({format:'auto',quality:92,kind:'translated',individual:false}));
const failed=fixture({failWrite:true});await assert.rejects(failed.prefs.set({format:'webp'}),/storage unavailable/);checks++;
ok('unknown settings never overwrite translation config',!(await x.prefs.set({aiModel:'changed'})).aiModel&&!('aiModel' in x.stored));
console.log('PASS',checks,'storage API fixture checks (not a native browser installation)');
