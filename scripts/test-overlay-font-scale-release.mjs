// Removed overlays must release their font-scale registration; otherwise every
// dropped overlay scope (and its text DOM) stays referenced until the next
// font-scale change. Offline DOM fixture; no browser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Style {
  setProperty(name,value){this[name]=String(value)}
  getPropertyValue(name){return this[name] || ''}
}
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.className='';this.style=new Style();
    this.children=[];this.parentElement=null;this.dataset={}}
  get isConnected(){return this===document.documentElement || !!this.parentElement?.isConnected}
  get nextSibling(){const list=this.parentElement?.children||[];return list[list.indexOf(this)+1]||null}
  appendChild(child){child.remove();this.children.push(child);child.parentElement=this;return child}
  insertBefore(child,reference){child.remove();const index=this.children.indexOf(reference);
    this.children.splice(index<0?this.children.length:index,0,child);child.parentElement=this;return child}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(el=>el!==this);this.parentElement=null}}
  getBoundingClientRect(){return {left:0,top:0,width:600,height:860,right:600,bottom:860,x:0,y:0}}
  getAttribute(name){return this[name] || null}
}
const document={documentElement:new Element('html'),createElement:tag=>new Element(tag),addEventListener(){},visibilityState:'visible'};
document.body=new Element('body');document.documentElement.appendChild(document.body);
const scaleListeners=[];
const chrome={storage:{local:{get:(_key,callback)=>callback({fontScale:1})},
  onChanged:{addListener:fn=>scaleListeners.push(fn)}},runtime:{onMessage:{addListener(){}}}};
const window={__TP:null,innerWidth:1280,innerHeight:900,addEventListener(){}};
const TP=window.__TP={bail:false,log:{debug(){},info(){}},overlayBackground:{release(){}},
  onNextFrame:fn=>setTimeout(fn,0),getBestImgUrl:img=>img.src,normUrl:value=>value,imageIdentity:value=>value,
  findTargetImage:()=>null,computeScale:()=>({nw:600,nh:860,sx:1,sy:1,offX:0,offY:0})};
const context=vm.createContext({window,document,chrome,location:{hostname:'example.test'},
  getComputedStyle:el=>({position:el.style.position || 'static',overflowX:'visible',overflowY:'visible'}),
  MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}disconnect(){}},URL,setTimeout});
for (const file of ['font-scale.js','mount.js'])
  vm.runInContext(readFileSync(new URL(`../src/content/overlay/${file}`,import.meta.url),'utf8'),context);

const setScale=value=>{for (const fn of scaleListeners) fn({fontScale:{newValue:value}},'local')};
const overlay=key=>{
  const img=new Element('img');img.src=key;document.body.appendChild(img);
  return TP.overlayMount.upsertHtmlOverlay(key,img,600,860,'html');
};
// Keeps a removed host attached so only the registration decides whether its
// scope is still updated (a detached scope would be pruned either way).
const reattach=rec=>document.body.appendChild(rec.host);

const kept=overlay('https://example.test/kept.png');
const dropped=overlay('https://example.test/dropped.png');
assert.equal(dropped.scope.style.getPropertyValue('--tp-font-scale'),'1');
TP.overlayMount.dropHtmlOverlay('https://example.test/dropped.png');
reattach(dropped);
setScale(1.5);
assert.equal(kept.scope.style.getPropertyValue('--tp-font-scale'),'1.5','live overlay follows the scale');
assert.equal(dropped.scope.style.getPropertyValue('--tp-font-scale'),'1','dropped overlay is no longer registered');
console.log('PASS dropHtmlOverlay releases the font-scale registration');

const before=overlay('https://example.test/route-a.png');
TP.overlayMount.destroyAllHtmlOverlays();
reattach(before);reattach(kept);
setScale(0.75);
assert.equal(before.scope.style.getPropertyValue('--tp-font-scale'),'1.5');
assert.equal(kept.scope.style.getPropertyValue('--tp-font-scale'),'1.5');
console.log('PASS destroyAllHtmlOverlays releases every font-scale registration');
