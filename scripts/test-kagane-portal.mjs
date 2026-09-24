// Reproduces Kagane removing the entire image component while an existing
// reader raster is on screen. Offline DOM fixture; no browser or image bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Style {
  constructor(){this.priorities=new Map()}
  field(name){return name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())}
  setProperty(name,value,priority=''){this[this.field(name)]=String(value);this.priorities.set(name,priority)}
  getPropertyValue(name){return this[this.field(name)] || ''}
  getPropertyPriority(name){return this.priorities.get(name) || ''}
}
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.className='';this.style=new Style();this.children=[];this.parentElement=null;this.dataset={};this.rect={left:0,top:0,width:0,height:0,right:0,bottom:0}}
  get isConnected(){return this===document.documentElement || !!this.parentElement?.isConnected}
  appendChild(child){child.remove();this.children.push(child);child.parentElement=this;return child}
  insertBefore(child,reference){child.remove();const index=this.children.indexOf(reference);this.children.splice(index<0?this.children.length:index,0,child);child.parentElement=this;return child}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(el=>el!==this);this.parentElement=null}}
  get firstChild(){return this.children[0] || null}
  getBoundingClientRect(){return this.rect}
  getAttribute(name){return this[name] || null}
}
const document={documentElement:new Element('html'),createElement:tag=>new Element(tag),addEventListener(){},visibilityState:'visible'};
document.body=new Element('body');document.documentElement.appendChild(document.body);
const window={__TP:null,innerWidth:800,innerHeight:650,addEventListener(){}};
let image=null;
const key='tp-reader:kagane:series:chapter:24';
const TP=window.__TP={bail:false,log:{debug(){}},overlayBackground:{release(){}},overlayFontScale:{register(){}},
 onNextFrame:fn=>setTimeout(fn,0),readerImageForKey:query=>query===key?image:null,
 readerOriginalFor:()=> 'https://kstatic.to/original.jxl',getBestImgUrl:img=>img.src,
 normUrl:value=>value,imageIdentity:value=>value,
 computeScale:()=>({nw:1939,nh:2723,sx:0.20165,sy:0.20165,offX:0,offY:0})};
const context=vm.createContext({window,document,location:{hostname:'kagane.to'},
 getComputedStyle:el=>({position:'relative',overflowX:el.clip?'hidden':'visible',overflowY:el.clip?'hidden':'visible'}),
 MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}disconnect(){}},URL,setTimeout});
vm.runInContext(readFileSync(new URL('../src/content/overlay/mount.js',import.meta.url),'utf8'),context);
const main=new Element('main');document.body.appendChild(main);
function mount(left,top){
 const component=new Element('div');component.rect={left,top,width:391,height:549,right:left+391,bottom:top+549};
 main.appendChild(component);
 image=new Element('img');image.src=`blob:https://kagane.to/${left}-${top}`;
 image.rect={...component.rect};component.appendChild(image);
 return component;
}
const nextFrame=()=>new Promise(resolve=>setTimeout(resolve,15));
const first=mount(40,60);
const record=TP.overlayMount.upsertHtmlOverlay(key,image,1939,2723,'raster');
record.cleanImg=document.createElement('img');record.cleanImg.src='blob:https://kagane.to/translated';
record.cleanImg.style.display='block';record.rasterSource=record.cleanImg.src;
record.host.insertBefore(record.cleanImg,record.host.firstChild);
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.equal(record.host.parentElement,document.documentElement);
assert.equal(record.host.style.position,'fixed');
assert.equal(record.host.style.left,'40px');
assert.equal(record.host.style.display,'block');
assert.equal(TP.overlayMount.hasRasterOverlay(key,image),true);
first.remove();image=null;
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.equal(record.host.isConnected,true,'publisher component removal cannot remove translation');
assert.equal(record.host.style.display,'none');
const second=mount(72,85);
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.equal(record.host.style.display,'block');
assert.equal(record.host.style.left,'72px');
assert.equal(record.host.style.top,'85px');
assert.equal(TP.overlayMount.hasRasterOverlay(key,image),true);
second.clip=true;second.rect={left:90,top:100,width:350,height:520,right:440,bottom:620};
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.match(record.host.style.clipPath,/inset\(15px 23px 14px 18px\)/);
// An aborted run leaves the already visible layer on its original image,
// but never carries it onto a changed source or a new job on the same image.
TP.overlayMount.retireReaderOverlays([{key,source:'https://kstatic.to/original.jxl'}]);
TP.readerImageForKey=()=>null;
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.equal(record.host.style.display,'block','cancellation keeps the visible translation');
image.src='blob:https://kagane.to/different-page';
TP.overlayMount.scheduleHtmlOverlayUpdate(key);await nextFrame();
assert.equal(record.host.isConnected,false,'changed image cannot show a stale translation');
const fresh=TP.overlayMount.upsertHtmlOverlay('tp-reader:new-run:24',image,1939,2723,'html');
assert.equal(record.host.isConnected,false,'a new translation releases the old layer on that image');
assert.equal(fresh.img,image);
console.log('PASS Kagane portal: raster survives React subtree removal, follows remounted IMG, respects clipping');
