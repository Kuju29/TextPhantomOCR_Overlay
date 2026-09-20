import assert from 'node:assert/strict';
import { createLocalConnectionController, LOCAL_CAPABILITY_SNAPSHOTS_KEY as KEY } from '../src/popup/controllers/local-connection-controller.js';
const draft = (baseUrl = 'http://localhost:9999') => JSON.stringify({version:1,protocol:'openai',baseUrl,modelsPath:'/v1/models',chatPath:'/v1/chat/completions'});
const element = (value='') => ({value, handlers:{}, addEventListener(type, fn){this.handlers[type]=fn;}});
const defer = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
let passed=0;
function fixture({readGate=null,fail=false,provider='customlocal'}={}) {
  const els={
    aiProvider:element(provider),aiBaseUrl:element('http://localhost:1234'),
    aiLocalAdapter:element(draft()),aiEndpointWrap:{},aiModelWrap:{},
    aiModel:element('model-a'),aiThinking:element('off'),apiUrl:element('http://127.0.0.1:7860'),
    aiLocalStatus:{textContent:''},aiLocalTest:Object.assign(element(),{disabled:false}),
  };
  const state={localConnectSeq:0,aiMetaSeq:0,providerTransitionRevision:1,
    localAiCapability:{old:true},localConnectInFlight:null,desiredAiModel:'model-a'};
  const data={[KEY]:{'customlocal|http://localhost:1234':{old:true},'customlocal|http://localhost:9999':{stale:true},'ollama|http://localhost:11434':{keep:true}}};
  const writes=[],messages=[],discoveries=[];let clears=0;
  const ctl=createLocalConnectionController({els,state,profile:{selectModel:()=>{}},
    getStorage:async()=>{if(readGate)await readGate.promise;return structuredClone(data);},
    persist:async patch=>{if(fail)throw new Error('storage unavailable');writes.push(structuredClone(patch));Object.assign(data,structuredClone(patch));},
    sendMessage:async message=>{discoveries.push(structuredClone(message));return {ok:true,models:['model-a'],
      selectedModelVerification:{status:'passed',model:'model-a'},capability:{source:'fixture'}};},
    normalizeUrl:value=>value,setModelOptions:(models,{keepValue='',selectFirst=false}={})=>{
      els.aiModel.value=keepValue || (selectFirst ? String(models[0] || '') : els.aiModel.value);
    },
    setFieldMessage:(_el,type,text)=>messages.push({type,text}),renderPrompt:async()=>{},scheduleSave:()=>{},
    clearResolveTimer:()=>{},clearCapacity:()=>{clears++;},renderCapacity:()=>{},persistCapacity:async()=>{},toggleUi:()=>{},
    traceLocalConnection:()=>{},
  });ctl.bind();
  return {els,state,data,writes,messages,discoveries,save:()=>els.aiLocalAdapter.handlers.blur(),get clears(){return clears;}};
}
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
await test('valid JSON blur saves once, then automatically connects, loads and verifies models',async()=>{
 const f=fixture();await f.save();assert.ok(f.writes.length>=3);assert.equal(f.data.aiBaseUrl,'http://localhost:9999');assert.equal(f.data.localAiAdapter.protocol,'openai');assert.equal(f.data.aiLocalCapabilityHint,null);
 assert.ok(Object.keys(f.data[KEY]).includes('ollama|http://localhost:11434'));
 assert.ok(Object.keys(f.data[KEY]).includes('customlocal|http://localhost:9999'));
 assert.equal(f.els.aiBaseUrl.value,f.data.aiBaseUrl);assert.ok(f.clears>=2);assert.equal(f.discoveries.length,1);
 assert.equal(f.discoveries[0].type,'TP_LOCAL_AI_DISCOVER');assert.equal(f.discoveries[0].thinking,'off');
 assert.equal(f.state.aiModelBlocked,false);assert.match(f.els.aiLocalStatus.textContent,/Ready/);
 const reopened=JSON.parse(JSON.stringify(f.data));assert.equal(reopened.localAiAdapter.baseUrl,f.els.aiBaseUrl.value);
});
await test('invalid JSON keeps saved endpoint and capability unchanged',async()=>{const f=fixture();f.els.aiLocalAdapter.value='{';await f.save();assert.equal(f.writes.length,0);assert.equal(f.els.aiBaseUrl.value,'http://localhost:1234');assert.deepEqual(f.state.localAiCapability,{old:true});assert.equal(f.clears,0);assert.match(f.messages[0].text,/Not saved/);});
await test('unsupported adapter fields do not update settings',async()=>{const f=fixture();f.els.aiLocalAdapter.value=JSON.stringify({...JSON.parse(draft()),invented:true});await f.save();assert.equal(f.writes.length,0);assert.match(f.messages.at(-1).text,/Unsupported field/);});
await test('storage failure does not publish draft as effective URL',async()=>{const f=fixture({fail:true});await f.save();assert.equal(f.els.aiBaseUrl.value,'http://localhost:1234');assert.equal(f.clears,0);assert.equal(f.messages.at(-1).type,'error');assert.equal(f.data.localAiAdapter,undefined);assert.equal(f.discoveries.length,0);});
await test('non-custom provider never writes adapter configuration',async()=>{const f=fixture({provider:'ollama'});await f.save();assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);});
await test('provider transition during storage read cancels stale save',async()=>{const gate=defer(),f=fixture({readGate:gate});const p=f.save();await Promise.resolve();f.els.aiProvider.value='ollama';f.state.providerTransitionRevision++;gate.resolve();await p;assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);});
await test('endpoint edit during read is not overwritten',async()=>{const gate=defer(),f=fixture({readGate:gate});const p=f.save();await Promise.resolve();f.els.aiBaseUrl.value='http://localhost:5678';gate.resolve();await p;assert.equal(f.writes.length,0);assert.equal(f.els.aiBaseUrl.value,'http://localhost:5678');});
await test('newer draft owns queued save, not old asynchronous callback',async()=>{const gate=defer(),f=fixture({readGate:gate});const a=f.save();await Promise.resolve();f.els.aiLocalAdapter.value=draft('http://localhost:7777');const b=f.save();gate.resolve();await Promise.all([a,b]);assert.ok(f.writes.length>=3);assert.equal(f.data.aiBaseUrl,'http://localhost:7777');assert.equal(f.discoveries.length,1);assert.equal(f.discoveries[0].adapter.baseUrl,'http://localhost:7777');});
await test('successful save invalidates an in-flight result before its automatic reconnect',async()=>{const f=fixture();f.state.localConnectSeq=4;f.state.localConnectInFlight={seq:4,identity:'customlocal|http://localhost:1234'};await f.save();assert.equal(f.state.localConnectSeq,6);assert.equal(f.state.localConnectInFlight,null);assert.equal(f.discoveries.length,1);});
console.log(`${passed} custom adapter save tests passed; no real storage/network.`);
