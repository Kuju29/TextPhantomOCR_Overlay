import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.listeners=new Map();this.style={};this.dataset={};this.isConnected=true;}
 addEventListener(t,f){this.listeners.set(t,f)} removeEventListener(t){this.listeners.delete(t)}
 appendChild(el){this.children.push(el);el.parentElement=this} append(el){this.appendChild(el)}
 contains(el){return this===el || this.children.some(c=>c.contains(el))} closest(){return null}
 setAttribute(k,v){this[k]=v} remove(){this.isConnected=false;this.parentElement.children=this.parentElement.children.filter(c=>c!==this)}
 getBoundingClientRect(){return {left:0,top:0,right:600,bottom:900,width:600,height:900}}
}
const document=new El('document');document.documentElement=new El('html');document.head=new El('head');document.readyState='complete';
document.createElement=tag=>new El(tag);
const a=new El('img'),b=new El('img');document.images=[a,b];let hit=null,storage;
document.elementFromPoint=()=>hit;
const window=new El('window');window.innerWidth=1200;window.innerHeight=1000;
window.__TP={bail:false,imageSkipReason:()=>'',getSettings:async()=>({mode:'lens_text'}),log:{info(){}}};
const context={window,document,console,setTimeout,clearTimeout,requestAnimationFrame:f=>f(),
 MutationObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({visibility:'visible',opacity:'1',overflow:'visible'}),
 chrome:{runtime:{lastError:null},storage:{local:{get:(_k,cb)=>cb({imgButtonsEnabled:true})},onChanged:{addListener:f=>storage=f}}}};
vm.runInNewContext(readFileSync(new URL('../src/content/image-buttons.js',import.meta.url),'utf8'),context);
await new Promise(resolve=>setTimeout(resolve,0));
const layer=document.documentElement.children.find(el=>el.id==='tp-img-btn-layer');
const [ba,bb]=layer.children;assert.equal(ba.style.display,'none');assert.equal(bb.style.display,'none');
const move=(target,type='mouse')=>{hit=target;document.listeners.get('pointermove')({target,clientX:10,clientY:10,pointerType:type,type:'pointermove'})};
move(a);assert.equal(ba.style.display,'');assert.equal(bb.style.display,'none');
move(ba);assert.equal(ba.style.display,'','moving onto overlay button must not hide it');
move(b);assert.equal(ba.style.display,'none');assert.equal(bb.style.display,'');
hit=document;window.listeners.get('scroll')();assert.equal(bb.style.display,'none','scrolling hovered image away must hide its button');
move(a);document.documentElement.listeners.get('pointerleave')();assert.equal(ba.style.display,'none');
storage({imgButtonsEnabled:{newValue:false}},'local');assert.equal(layer.isConnected,false);assert(!document.listeners.has('pointermove'));
console.log('PASS image buttons: hidden initially; one hovered image; button remains clickable; scroll-away/leave hides; disable cleans listeners');
