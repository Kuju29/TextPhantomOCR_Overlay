// Small DOM facade for the real UI-language controller, including observer
// delivery. It checks text/attribute mutations and requests, not browser pixels.
export function uiLanguageDomFixture({pathname='/popup/popup.html'}={}){
 const mutations=[],states=[],writes=[],observers=new Set();let queued=false;
 const enqueue=row=>{mutations.push(row);if(!queued){queued=true;queueMicrotask(()=>{queued=false;const rows=mutations.splice(0);for(const observer of observers)observer.callback(rows);});}};
 class Text {
  constructor(value){this.nodeType=3;this._data=String(value);this.ownerDocument=doc;this.parentElement=null;}
  get data(){return this._data;}set data(value){this._data=String(value);writes.push(this._data);enqueue({type:'characterData',target:this});}
  get textContent(){return this.data;}set textContent(value){this.data=value;}
  get isConnected(){return Boolean(this.parentElement?.isConnected);}
 }
 class Element {
  constructor(tag='div'){this.nodeType=1;this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.parentElement=null;this.children=[];this.attributes=new Map();this.handlers=new Map();this.hidden=false;this.value='';this.className='';this.dataset=new Proxy({}, {set:(target,key,value)=>{target[key]=String(value);if(key==='state')states.push(String(value));return true;}});}
  get isConnected(){return this===doc.body||this===doc.documentElement||Boolean(this.parentElement?.isConnected);}
  get textContent(){return this.children.map(node=>node.textContent).join('');}set textContent(value){this.replaceChildren(new Text(value));}
  get title(){return this.getAttribute('title');}set title(value){this.setAttribute('title',value);}
  setAttribute(key,value){this.attributes.set(key,String(value));if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=String(value);enqueue({type:'attributes',attributeName:key,target:this});}
  getAttribute(key){if(key.startsWith('data-'))return this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]??null;return this.attributes.get(key)??null;}
  hasAttribute(key){return this.getAttribute(key)!==null;}
  matches(selector){if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('[')){const [,key,value]=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)||[];return key&&this.hasAttribute(key)&&(value===undefined||this.getAttribute(key)===value);}return this.tagName.toLowerCase()===selector;}
  closest(selector){for(let node=this;node;node=node.parentElement)if(selector.split(',').some(part=>node.matches(part)))return node;return null;}
  querySelectorAll(selector){const rows=this.children.flatMap(node=>node.nodeType===1?[node,...node.querySelectorAll('*')]:[]);return selector==='*'?rows:rows.filter(node=>node.matches(selector));}
  append(...nodes){for(let node of nodes){if(typeof node==='string')node=new Text(node);if(node.nodeType===11){this.append(...node.children);continue;}if(node.parentElement){const values=node.parentElement.children;const at=values.indexOf(node);if(at>=0)values.splice(at,1);}node.parentElement=this;this.children.push(node);enqueue({type:'childList',target:this,addedNodes:[node]});}}
  replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentElement){const values=this.parentElement.children;values.splice(values.indexOf(this),1);}this.parentElement=null;}
  addEventListener(type,fn){this.handlers.set(type,fn);}dispatchEvent(event){this.handlers.get(event.type)?.(event);return true;}
 }
 const doc={location:{pathname},createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag),createTextNode:value=>new Text(value),createDocumentFragment:()=>{const node=new Element();node.nodeType=11;return node;},createTreeWalker(root){const nodes=[];const visit=node=>{for(const child of node.children||[])if(child.nodeType===3)nodes.push(child);else visit(child);};visit(root);let at=0;return{nextNode:()=>nodes[at++]||null};}};
 doc.documentElement=new Element('html');doc.body=new Element('body');doc.documentElement.append(doc.body);
 const host=new Element('header');doc.body.append(host);
 class Observer{constructor(callback){this.callback=callback;}observe(){observers.add(this);}disconnect(){observers.delete(this);}}
 const globals={document:globalThis.document,MutationObserver:globalThis.MutationObserver,CustomEvent:globalThis.CustomEvent};
 globalThis.document=doc;globalThis.MutationObserver=Observer;globalThis.CustomEvent=class{constructor(type,options){this.type=type;Object.assign(this,options);}};
 return{root:doc.body,host,doc,states,writes,element(text,tag='p',attrs={}){const node=doc.createElement(tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);node.textContent=text;doc.body.append(node);return node;},async settle(turns=30){for(let i=0;i<turns;i++)await new Promise(resolve=>setImmediate(resolve));},restore(){Object.assign(globalThis,globals);observers.clear();}};
}
