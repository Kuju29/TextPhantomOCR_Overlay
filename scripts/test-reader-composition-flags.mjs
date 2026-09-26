import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {imageRequestUrl} from '../src/background/image-composition.js';

const requestListeners=new Map();
const document={
  addEventListener(name,callback){if(!requestListeners.has(name))requestListeners.set(name,new Set());requestListeners.get(name).add(callback);},
  removeEventListener(name,callback){requestListeners.get(name)?.delete(callback);},
  dispatchEvent(event){for(const callback of requestListeners.get(event.type)||[])callback(event);},
  querySelector(){return scope;},querySelectorAll(){return [];},
};
class Node{};
class Element extends Node{};
const source='https://cdn.example.test/i5/one.webp?8';
const slot=new Element();
slot.__reactProps$reader={page:{url:source,scramble:true},pages:{baseUrl:'',items:[{url:source,s:1}]}};
slot.getAttribute=name=>name==='data-page'?'1':null;
slot.closest=()=>null;
slot.contains=node=>node===slot;
const attrs=new Map();
const scope=new Element();
scope.isConnected=true;
scope.querySelectorAll=()=>[slot];
scope.closest=()=>null;scope.contains=node=>node===slot;
scope.setAttribute=(name,value)=>attrs.set(name,value);
scope.getAttribute=name=>attrs.get(name);
scope.removeAttribute=name=>attrs.delete(name);
const TP={bail:false,scanDiag:null};
const location={hostname:'comix.to',href:'https://comix.to/chapter/same',pathname:'/chapter/same'};
const vm={window:{__TP:TP},document,location,crypto:webcrypto,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},Node,Element,URL,Set,Map,WeakSet,setTimeout,clearTimeout,console};
const script=name=>readFileSync(new URL(`../src/content/reader/${name}`,import.meta.url),'utf8');
runInNewContext(script('page-sources.js'),vm);
runInNewContext(script('sources.js'),vm);
const plan={ids:['1'],attr:'data-page',root:scope,slots:new Map([['1',slot]])};
const result=await TP.readerSources(plan,()=>source,{document,pageWorld:true,knownSources:new Map([['1',source]])});
assert.equal(result.urls.get('1'),source);
assert.equal(result.compositionHints.get('1'),'scrambled');
assert.equal(result.profile,'reader-page-data');
// An accepted inline manifest can have every source URL yet omit per-page s.
// Use matching component hints for a lazy page without waiting for its canvas.
const second='https://cdn.example.test/i5/two.webp?8';
const lazy=new Element();
lazy.__reactProps$reader={page:{url:second,s:1}};
lazy.getAttribute=name=>name==='data-page'?'2':null;
lazy.closest=()=>null;lazy.contains=node=>node===lazy;
scope.querySelectorAll=()=>[slot,lazy];
const inlineDoc={querySelectorAll:()=>[{textContent:JSON.stringify({pages:[
  {url:source},{url:second},
]})}]};
const lazyPlan={...plan,ids:['1','2'],slots:new Map([['1',slot],['2',lazy]])};
const lazyOptions={document:inlineDoc,pageWorld:true,knownSources:new Map([['1',source]])};
const merged=await TP.readerSources(lazyPlan,node=>node===slot?source:'',lazyOptions);
assert.equal(merged.profile,'reader-manifest');
assert.equal(merged.urls.get('2'),second);
assert.equal(merged.compositionHints.get('2'),'scrambled');
assert.equal(imageRequestUrl(merged.urls.get('2'),location.href,merged.compositionHints.get('2')),
  second+'&v3','the lazy page requests the composed CDN variant before mounting');
lazy.__reactProps$reader={page:{url:second,s:0}};
const plain=await TP.readerSources(lazyPlan,node=>node===slot?source:'',lazyOptions);
assert.equal(plain.compositionHints.get('2'),'plain');
assert.equal(imageRequestUrl(plain.urls.get('2'),location.href,plain.compositionHints.get('2')),second,
  'an ordinary page retains its original image request');
lazy.__reactProps$reader={page:{url:'https://cdn.example.test/i5/unrelated.webp?8',s:1}};
const unrelated=await TP.readerSources(lazyPlan,node=>node===slot?source:'',lazyOptions);
assert.equal(unrelated.urls.get('2'),second);
assert.equal(unrelated.compositionHints.has('2'),false,
  'a component hint for a different source cannot mark the manifest page');
console.log('reader discovery: validated React chapter manifest retains s=1 on original page identity');
