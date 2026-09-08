import assert from 'node:assert/strict';
import { createLocalConnectionController, LOCAL_CAPABILITY_SNAPSHOTS_KEY as KEY } from '../src/popup/controllers/local-connection-controller.js';
const draft = (baseUrl = 'http://localhost:9999') => JSON.stringify({version:1,protocol:'openai',baseUrl,modelsPath:'/v1/models',chatPath:'/v1/chat/completions'});
const element = (value='') => ({value, handlers:{}, addEventListener(type, fn){this.handlers[type]=fn;}});
const defer = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
let passed=0;
function fixture({readGate=null,fail=false,provider='customlocal'}={}) {
  const els={aiProvider:element(provider),aiBaseUrl:element('http://localhost:1234'),aiLocalAdapter:element(draft()),aiEndpointWrap:{}};
  const state={localConnectSeq:0,aiMetaSeq:0,providerTransitionRevision:1,localAiCapability:{old:true}};
  const data={[KEY]:{'customlocal|http://localhost:1234':{old:true},'customlocal|http://localhost:9999':{stale:true},'ollama|http://localhost:11434':{keep:true}}};
  const writes=[],messages=[];let clears=0;
  const ctl=createLocalConnectionController({els,state,profile:{},
    getStorage:async()=>{if(readGate)await readGate.promise;return structuredClone(data);},
    persist:async patch=>{if(fail)throw new Error('storage unavailable');writes.push(structuredClone(patch));Object.assign(data,structuredClone(patch));},
    setFieldMessage:(_el,type,text)=>messages.push({type,text}),clearCapacity:()=>{clears++;},toggleUi:()=>{},
  });ctl.bind();
  return {els,state,data,writes,messages,save:()=>els.aiLocalAdapter.handlers.blur(),get clears(){return clears;}};
}
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
await test('valid JSON blur commits configuration and exact snapshot invalidation atomically',async()=>{
 const f=fixture();await f.save();assert.equal(f.writes.length,1);assert.equal(f.data.aiBaseUrl,'http://localhost:9999');assert.equal(f.data.localAiAdapter.protocol,'openai');assert.equal(f.data.aiLocalCapabilityHint,null);
 assert.deepEqual(Object.keys(f.data[KEY]),['ollama|http://localhost:11434']);assert.equal(f.els.aiBaseUrl.value,f.data.aiBaseUrl);assert.equal(f.clears,1);assert.equal(f.messages.at(-1).type,'info');
 const reopened=JSON.parse(JSON.stringify(f.data));assert.equal(reopened.localAiAdapter.baseUrl,f.els.aiBaseUrl.value);
});
await test('invalid JSON keeps saved endpoint and capability unchanged',async()=>{const f=fixture();f.els.aiLocalAdapter.value='{';await f.save();assert.equal(f.writes.length,0);assert.equal(f.els.aiBaseUrl.value,'http://localhost:1234');assert.deepEqual(f.state.localAiCapability,{old:true});assert.equal(f.clears,0);assert.match(f.messages[0].text,/Not saved/);});
await test('unsupported adapter fields do not update settings',async()=>{const f=fixture();f.els.aiLocalAdapter.value=JSON.stringify({...JSON.parse(draft()),invented:true});await f.save();assert.equal(f.writes.length,0);assert.match(f.messages.at(-1).text,/Unsupported field/);});
await test('storage failure does not publish draft as effective URL',async()=>{const f=fixture({fail:true});await f.save();assert.equal(f.els.aiBaseUrl.value,'http://localhost:1234');assert.equal(f.clears,0);assert.equal(f.messages.at(-1).type,'error');assert.equal(f.data.localAiAdapter,undefined);});
await test('non-custom provider never writes adapter configuration',async()=>{const f=fixture({provider:'ollama'});await f.save();assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);});
await test('provider transition during storage read cancels stale save',async()=>{const gate=defer(),f=fixture({readGate:gate});const p=f.save();await Promise.resolve();f.els.aiProvider.value='ollama';f.state.providerTransitionRevision++;gate.resolve();await p;assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);});
await test('endpoint edit during read is not overwritten',async()=>{const gate=defer(),f=fixture({readGate:gate});const p=f.save();await Promise.resolve();f.els.aiBaseUrl.value='http://localhost:5678';gate.resolve();await p;assert.equal(f.writes.length,0);assert.equal(f.els.aiBaseUrl.value,'http://localhost:5678');});
await test('newer draft owns queued save, not old asynchronous callback',async()=>{const gate=defer(),f=fixture({readGate:gate});const a=f.save();await Promise.resolve();f.els.aiLocalAdapter.value=draft('http://localhost:7777');const b=f.save();gate.resolve();await Promise.all([a,b]);assert.equal(f.writes.length,1);assert.equal(f.data.aiBaseUrl,'http://localhost:7777');});
await test('successful save invalidates an in-flight connection result',async()=>{const f=fixture();f.state.localConnectSeq=4;f.state.localConnectInFlight={seq:4,identity:'customlocal|http://localhost:1234'};await f.save();assert.equal(f.state.localConnectSeq,5);assert.equal(f.state.localConnectInFlight,null);});
console.log(`${passed} custom adapter save tests passed; no real storage/network.`);
