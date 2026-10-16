/** Read-only actual extension DOM controller probe. No live UI/payment/account/API calls.
 * --require-clarity adds proposed10455 UI acceptance; expected to fail until production fix.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const at=process.argv.indexOf('--extension');
assert.ok(at>=0,'--extension path required');
const root=resolve(process.argv[at+1]);
const modulePath=resolve(root,'src/popup/controllers/paid-model-pricing.js');
const requireClarity=process.argv.includes('--require-clarity');
class Element {
  constructor(tag='span') { this.tagName=tag; this.children=[]; this.attributes={}; this.dataset={}; this.events={}; this.text=''; this.disabled=false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text=''; this.children=[...nodes]; }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  getAttribute(name) { return this.attributes[name]??null; }
  addEventListener(type,fn) { this.events[type]=fn; }
  dispatchEvent(event) { this.events[event.type]?.(event); }
  querySelector(selector) { return selector==='summary'?this.summary:null; }
  get textContent() { return this.text+this.children.map(n=>n.textContent??String(n)).join(''); }
  set textContent(value) { this.text=String(value); this.children=[]; }
  focus() {}
}
globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:String(text)})};
const {paidModelRates,createPaidModelPricing}=await import(pathToFileURL(modulePath));
const catalogue={status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'25.2639',output_tp:'109.4769'};
const paired={status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'168.426',output_tp:'673.704',basis:'paired_endpoint_metadata',tariff_basis:'conditional_ceiling'};
const els={};
for(const key of ['aiPaidModelPicker','aiPaidModel','aiPaidModelName','aiPaidModelOptions','aiPaidModelInput','aiPaidModelOutput','aiPaidModelPriceStatus'])els[key]=new Element();
els.aiPaidModelPicker.summary=new Element('summary');
const controller=createPaidModelPricing(els);
const model={id:'qwen/qwen3.7-flash',name:'Qwen fixture',pricing:paired,catalogue_pricing:catalogue,
 route_price_sync:{status:'current'},price_sync:{status:'current'}};
const checks=[],failures=[],observations=[];
function check(name,fn){try{fn();checks.push(name)}catch(error){failures.push({name,message:error.message})}}
function observe(label){observations.push({label,input:els.aiPaidModelInput.textContent,output:els.aiPaidModelOutput.textContent,
 status:els.aiPaidModelPriceStatus.textContent,options:els.aiPaidModelOptions.children.map(n=>({text:n.textContent,title:n.title??n.getAttribute('title'),aria_label:n.getAttribute('aria-label'),disabled:n.disabled}))});}
controller.render([model],model.id,true);observe('current conditional ceiling');
// Intended (TP-IMPROVEMENT-LOG table, ราคา UI): the popup shows whole TP; a conditional ceiling rounds up, other rates round half up.
check('Paired current ceiling rounds up to whole TP 169/674',()=>assert.deepEqual(paidModelRates(model),{input:'169',output:'674'}));
check('Selected amount shows the whole-TP controller ceiling 169/674',()=>{assert.equal(els.aiPaidModelInput.textContent,'≤ 169 TP');assert.equal(els.aiPaidModelOutput.textContent,'≤ 674 TP')});
check('UI states final charge derives from reported usage',()=>assert.match(els.aiPaidModelPriceStatus.textContent,/reported usage/i));
check('Current rates do not disable account selector',()=>assert.equal(els.aiPaidModelPicker.summary.attributes['aria-disabled'],'false'));
if(requireClarity){
 check('Conditional selected rates explicitly say ceiling',()=>assert.match(els.aiPaidModelPriceStatus.textContent,/ceiling/i));
 check('Valid catalogue is separately labeled and shown25/109',()=>{const text=els.aiPaidModelPriceStatus.textContent;assert.match(text,/Catalogue comparison/i);assert.match(text,/25/);assert.match(text,/109/)});
 check('Dropdown rates have accessible basis label',()=>{const option=els.aiPaidModelOptions.children[0];assert.match(option.textContent+' '+(option.title??'')+' '+(option.getAttribute('aria-label')??''),/ceiling/i)});
}
const pending={...model,route_price_sync:{status:'refreshing'}};
controller.render([pending],model.id,true);observe('route refreshing cataloguefallback');
check('Route unavailable chooses catalogue 25/109 instead of ceiling',()=>assert.deepEqual(paidModelRates(pending),{input:'25',output:'109'}));
check('Cataloguefallback keeps route-checking warning',()=>assert.match(els.aiPaidModelPriceStatus.textContent,/catalogue|comparison/i));
const failed={...pending,route_price_sync:{status:'unavailable',error_code:'PAID_ROUTE_UNAVAILABLE'}};
controller.render([failed],model.id,true);observe('route unavailable cataloguefallback');
check('Unavailable route keeps explicit warning',()=>assert.match(els.aiPaidModelPriceStatus.textContent,/unavailable|could not/i));
controller.render([model],model.id,false,true);observe('saved data unverified');
check('Unverified saved model cannot be selected as ready',()=>assert.equal(els.aiPaidModelOptions.children[0].disabled,true));
check('Small positive quote never displays free',()=>assert.deepEqual(paidModelRates({pricing:{...catalogue,input_tp:'0.001',output_tp:'0.1'}}),{input:'<1',output:'<1'}));
check('Published ceiling rounds upward without binary float loss',()=>assert.deepEqual(paidModelRates({pricing:{...paired,input_tp:'1.00000000000000000001',output_tp:'2.1234'}}),{input:'2',output:'3'}));
check('Whole-number ceiling is not rounded past itself',()=>assert.deepEqual(paidModelRates({pricing:{...paired,input_tp:'2.000',output_tp:'3'}}),{input:'2',output:'3'}));
check('Tiny positive rate remains visibly positive',()=>assert.deepEqual(paidModelRates({pricing:{...paired,input_tp:'0.00001',output_tp:'0.00002'}}),{input:'<1',output:'<1'}));
check('Invalid numericquote rejected',()=>assert.equal(paidModelRates({pricing:{...catalogue,input_tp:'Infinity'}}),null));
console.log(JSON.stringify({passed:failures.length===0,count:checks.length+failures.length,passed_count:checks.length,
 checks,failures,observations,source_file:modulePath,source_sha256:createHash('sha256').update(await readFile(modulePath)).digest('hex'),
 require_clarity:requireClarity,scope:'Production popup controller with synthetic receipt-compatible comparison rates; facade checks text/control behavior only, no browser geometry/live payment or actual52 log.'},null,2));
if(failures.length)process.exitCode=1;
