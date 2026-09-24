import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const popup=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
assert.match(popup,/<input type="checkbox" id="translate-all-button-toggle"/);
const code=await readFile(new URL('../src/content/translate-all-button.js',import.meta.url),'utf8');
const messages=[];let onStorageChange,host;
function node(tag){return {tag,children:[],isConnected:false,
 append(...items){for(const item of items){item.isConnected=true;this.children.push(item)}},
 addEventListener(type,fn){this[`on${type}`]=fn},removeEventListener(type){delete this[`on${type}`]},
 setAttribute(key,value){this[key]=value},contains(item){return this===item || this.children.some(n=>n.contains(item))},
 remove(){this.isConnected=false},attachShadow(){return this.shadow=node('shadow')}}}
const doc=node('document');doc.documentElement={append(n){host=n;n.isConnected=true}};doc.createElement=node;
const context={window:{__TP:{bail:false,showToast(){}}},document:doc,chrome:{runtime:{lastError:null,sendMessage(msg,fn){messages.push(msg);fn({ok:true})}},storage:{local:{get(_key,fn){fn({translateAllButtonEnabled:false})}},onChanged:{addListener(fn){onStorageChange=fn}}}}};
context.window.top=context.window;runInNewContext(code,context);
assert.equal(host,undefined);
onStorageChange({translateAllButtonEnabled:{newValue:true}},'local');
const drawer=host.shadow.children[1],[handle,button]=drawer.children;
assert.match(host.shadow.children[0].textContent,/top:50%;right:0/);
assert.equal(drawer['data-open'],'false');assert.equal(button.tabIndex,-1);
drawer.onpointerenter({pointerType:'mouse'});assert.equal(drawer['data-open'],'true');
drawer.onpointerleave({pointerType:'mouse'});assert.equal(drawer['data-open'],'false');
const event={preventDefault(){},stopPropagation(){}};
handle.onclick(event);assert.equal(drawer['data-open'],'true');assert.equal(messages.length,0);
button.onclick(event);assert.equal(messages[0].type,'TP_RUN_TRANSLATE_ALL');assert.equal(button.disabled,false);
doc.onpointerdown({composedPath:()=>[]});assert.equal(drawer['data-open'],'false');
onStorageChange({translateAllButtonEnabled:{newValue:false}},'local');
assert.equal(host.isConnected,false);assert.equal(doc.onpointerdown,undefined);
console.log('PASS edge drawer: default hidden, mouse reveal, touch handle, dispatch, outside close, cleanup');
