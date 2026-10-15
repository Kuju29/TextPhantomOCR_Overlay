// 10490 E2E finding: on a page whose <img> is a direct child of <body> (body
// margin 0, a heading whose top margin collapses through body), the translated
// overlay sat 21 px below the image, and after scrolling it drifted by the
// scroll distance. ensureOverlayHostMountedNearImage makes <body> the
// positioned parent, but getOverlayBoxFromParent returned viewport
// coordinates for body/html. Offline DOM fixture; no browser.
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
  constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.className='';this.style=new Style();this.children=[];
    this.parentElement=null;this.dataset={};this.rect={left:0,top:0,width:0,height:0};this.clientLeft=0;this.clientTop=0;
    this.scrollLeft=0;this.scrollTop=0}
  get isConnected(){return this===document.documentElement || !!this.parentElement?.isConnected}
  get nextSibling(){const list=this.parentElement?.children||[];return list[list.indexOf(this)+1]||null}
  appendChild(child){child.remove();this.children.push(child);child.parentElement=this;return child}
  insertBefore(child,reference){child.remove();const index=this.children.indexOf(reference);this.children.splice(index<0?this.children.length:index,0,child);child.parentElement=this;return child}
  removeChild(child){child.remove();return child}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(el=>el!==this);this.parentElement=null}}
  get firstChild(){return this.children[0] || null}
  getBoundingClientRect(){const r=this.rect;return {...r,right:r.left+r.width,bottom:r.top+r.height,x:r.left,y:r.top}}
  getAttribute(name){return this[name] || null}
}
const document={documentElement:new Element('html'),createElement:tag=>new Element(tag),addEventListener(){},visibilityState:'visible'};
document.body=new Element('body');document.documentElement.appendChild(document.body);
const window={__TP:null,innerWidth:1280,innerHeight:900,addEventListener(){}};
const TP=window.__TP={bail:false,log:{debug(){}},overlayBackground:{release(){}},overlayFontScale:{register(){},unregister(){}},
  onNextFrame:fn=>setTimeout(fn,0),getBestImgUrl:img=>img.src,normUrl:value=>value,imageIdentity:value=>value,
  findTargetImage:()=>null,computeScale:()=>({nw:600,nh:860,sx:1,sy:1,offX:0,offY:0})};
const positions=new Map();
const context=vm.createContext({window,document,location:{hostname:'example.test'},
  getComputedStyle:el=>({position:positions.get(el) || el.style.position || 'static',overflowX:'visible',overflowY:'visible'}),
  MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}disconnect(){}},URL,setTimeout});
vm.runInContext(readFileSync(new URL('../src/content/overlay/mount.js',import.meta.url),'utf8'),context);
const nextFrame=()=>new Promise(resolve=>setTimeout(resolve,15));

// <body style="margin:0"><h1>…</h1><img …></body>: the h1 top margin (21.44 px)
// collapses through body, so body's box starts 21.44 px down the page.
const H1_MARGIN=21.4375, IMG_DOC_TOP=86.875;
let scrollY=0;
const img=new Element('img');img.src='https://example.test/m1.png';document.body.appendChild(img);
const layout=()=>{
  document.documentElement.rect={left:0,top:-scrollY,width:1280,height:3000};
  document.body.rect={left:0,top:H1_MARGIN-scrollY,width:1280,height:2900};
  img.rect={left:340,top:IMG_DOC_TOP-scrollY,width:600,height:860};
};
layout();
const key='https://example.test/m1.png';
const record=TP.overlayMount.upsertHtmlOverlay(key,img,600,860,'html');
record.img=img;
for (const y of [0, 59, 1500]) {
  scrollY=y; layout();
  TP.overlayMount.scheduleHtmlOverlayUpdate(key); await nextFrame();
  assert.equal(record.host.parentElement, document.body, 'overlay host is mounted next to the image');
  assert.equal(document.body.style.position, 'relative', 'body became the positioned parent');
  // Absolute box inside <body>'s padding box -> viewport position.
  const viewportTop=document.body.rect.top+document.body.clientTop+parseFloat(record.host.style.top);
  const viewportLeft=document.body.rect.left+document.body.clientLeft+parseFloat(record.host.style.left);
  assert.equal(viewportTop, img.rect.top, `scroll ${y}: overlay top sits on the image (was off by body offset)`);
  assert.equal(viewportLeft, img.rect.left, `scroll ${y}: overlay left sits on the image`);
}
console.log('PASS overlay on an <img> directly in <body> stays on the image with collapsed margins and scrolling');

// A fixed portal (Kagane/X) keeps viewport coordinates.
const box=TP.overlayMount.getOverlayBoxFromParent(img, document.documentElement, true);
assert.equal(box.top, img.rect.top);
assert.equal(box.left, img.rect.left);
// A wrapper element keeps the existing formula (offset + its own scroll).
const wrap=new Element('div');wrap.rect={left:100,top:50,width:800,height:900};wrap.scrollTop=30;
const inner=TP.overlayMount.getOverlayBoxFromParent({getBoundingClientRect:()=>({left:140,top:70,width:10,height:10})}, wrap);
assert.deepEqual([inner.left, inner.top], [40, 50]);
console.log('PASS fixed portals keep viewport coordinates; ordinary parents unchanged');
