"""Production popup change events + native selects, with isolated storage/catalogue.
No live requests, credentials, provider generation, or installed-extension claims.
"""
from pathlib import Path
import argparse,json,re
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--out',type=Path,default=Path('/tmp/tp-model-browser'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
report={'scope':'Real Chromium, production event/profile controllers, native selects; mocked account catalogue/storage; no live generation','checks':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/*',lambda route:route.abort())
 page.set_content('<!doctype html><meta charset="utf-8"><body></body>')
 cache={}
 def module(name):
  if name in cache:return cache[name]
  f=(a.root/name).resolve();source=f.read_text()
  def replace(m):return m[1]+json.dumps(module((f.parent/m[3]).resolve().relative_to(a.root).as_posix()))
  source=re.sub(r'(\b(?:from\s*|import\s*))([\'"])(\.[^\'"]+)\2',replace,source)
  cache[name]=page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))",source)
  return cache[name]
 urls=[module(path) for path in ['src/popup/controllers/popup-event-controller.js','src/popup/controllers/ai-profile-controller.js','src/shared/ai/providers/cloud-registry.js','src/shared/ai/providers/local-registry.js']]
 result=page.evaluate('''async urls=>{
 window.chrome={storage:{onChanged:{addListener:()=>{}},local:{get:async()=>({}),set:async()=>{}}},runtime:{sendMessage:async()=>{},getURL:x=>x}};
 const {bindPopupEvents}=await import(urls[0]);
 const {createAiProfileController}=await import(urls[1]);
 const {cloudProviderCatalog}=await import(urls[2]);
 const {localProviderCatalog}=await import(urls[3]);
 const specs=[...cloudProviderCatalog(),...localProviderCatalog(),{id:'customlocal',baseUrl:'http://localhost:8089/v1'}];
 const checks=[];const check=(name,condition,actual)=>{checks.push({name,passed:!!condition,actual});if(!condition)throw Error(name+': '+JSON.stringify(actual));};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async predicate=>{for(let n=0;n<200;n++){if(predicate())return;await sleep(5);}throw Error('event did not complete');};
 for(const spec of specs){
  const local=!cloudProviderCatalog().some(x=>x.id===spec.id); const root=document.createElement('section');document.body.append(root);
  const cache={};const els=new Proxy(cache,{get:(obj,key)=>{if(!(key in obj)){const tag=['aiProvider','aiModel','aiThinking','aiMemoryMode','aiTranslationMode','lang','sources','mode'].includes(key)?'select':key==='aiPrompt'?'textarea':'input';obj[key]=document.createElement(tag);obj[key].id=spec.id+'-'+key;root.append(obj[key]);}return obj[key];}});
  const options=(el,values,value)=>{el.replaceChildren(...values.map(v=>new Option(v,v)));el.value=value;};
  options(els.aiProvider,[spec.id],spec.id);options(els.aiModel,['model-a','model-b','model-c'],'model-a');options(els.aiThinking,['minimum','default','off'],'minimum');
  options(els.lang,['th'],'th');options(els.mode,['lens_text'],'lens_text');options(els.sources,['ai'],'ai');options(els.aiMemoryMode,['off','terms','full'],'off');options(els.aiTranslationMode,['independent','conversation'],local?'independent':'conversation');
  els.aiBaseUrl.value=spec.baseUrl;els.aiKey.value='fixture-not-a-real-key';els.apiUrl.value='http://api.fixture';els.aiStyleExamples.checked=true;
  const state={desiredAiModel:'model-a',desiredLang:'th',activeAiProvider:spec.id,aiPromptByLang:{},aiPromptDirtyByLang:{},aiMetaSeq:0,aiProbeSeq:0,providerTransitionRevision:0};
  const storage={aiProvider:spec.id,aiBaseUrl:spec.baseUrl,aiModel:'model-a',aiKey:els.aiKey.value,lang:'th'};
  let failFlush=false,delayedFlush=false;const pending=[];let checksFinished=0;
  const controller=createAiProfileController({els,state,setStorage:async patch=>{await sleep(1);Object.assign(storage,structuredClone(patch));}});await controller.initialize(storage);
  const noop=()=>{};const asyncNoop=async()=>{};
  const refreshed=async()=>{await sleep(2);checksFinished++;state.aiModelBlocked=false;};
  bindPopupEvents({els,state,profileController:controller,profilePagehideFlush:{flush:asyncNoop},usageController:{select:asyncNoop},providerMetaController:{cancelSchedule:noop,refresh:refreshed,schedule:noop},localConnectionController:{markModelChanged:refreshed,refreshThinkingCompatibility:noop,invalidate:noop},apiHealthController:{},applyPromptForLang:asyncNoop,updatePromptCount:noop,toggleUi:noop,selectedUsageTarget:()=>({provider:spec.id,model:state.desiredAiModel}),persistSelectedLocalCapacityHint:asyncNoop,renderLocalCapacityHint:noop,scheduleSaveAi:noop,flushPendingAiEditsForSwitch:async()=>{if(delayedFlush)await new Promise(r=>pending.push(r));return{ok:!failFlush};},setFieldMessage:noop,canUseAiUi:()=>true,renderAiUsage:asyncNoop,refreshSeriesMemory:asyncNoop});
  const change=value=>{els.aiModel.value=value;els.aiModel.dispatchEvent(new Event('change'));};
  change('model-b');await until(()=>checksFinished===1);
  check(spec.id+' actual change persists model-b',storage.aiProfilesV1.active.model==='model-b',storage.aiProfilesV1.active);
  // Native select initially has no high option. A saved capability must insert
  // it before assignment, and reopening must preserve the saved preference.
  await controller.saveModelCapabilities({reasoning:{supported:true,mandatory:false,control:'levels',supported_efforts:['none','low','high']}},'aaaaaaaaaaaaaaaa');
  controller.selectModel('model-b');
  els.aiThinking.value='high';els.aiThinking.dispatchEvent(new Event('change'));
  await until(()=>storage.aiProfilesV1.providers[storage.aiProfilesV1.active.providerIdentity].models['model-b'].profile.thinking==='high');
  check(spec.id+' native Thinking select retains high',els.aiThinking.value==='high',els.aiThinking.value);
  const reopened=createAiProfileController({els,state,setStorage:async patch=>Object.assign(storage,structuredClone(patch))});await reopened.initialize(storage);
  check(spec.id+' reopening keeps explicit model',els.aiModel.value==='model-b',els.aiModel.value);
  check(spec.id+' reopening keeps high',els.aiThinking.value==='high',els.aiThinking.value);
  // A -> C -> A while the first flush is outstanding. Resolve in reverse.
  delayedFlush=true;change('model-a');change('model-c');change('model-a');await until(()=>pending.length===3);
  pending.pop()();await until(()=>checksFinished===2);pending.shift()();pending.shift()();await sleep(25);
  check(spec.id+' stale A-C-A completion cannot overwrite latest',storage.aiProfilesV1.active.model==='model-a'&&els.aiModel.value==='model-a',storage.aiProfilesV1.active);
  delayedFlush=false;failFlush=true;change('model-c');await sleep(25);
  check(spec.id+' failed old-profile save blocks switch visibly',storage.aiProfilesV1.active.model==='model-a'&&els.aiModel.value==='model-a',storage.aiProfilesV1.active);
  root.remove();
 }
 return {checks,providers:specs.length};
}''',urls)
 report.update(result);report['browserErrors']=errors
 assert not errors, errors
 report['passed']=sum(c['passed'] for c in report['checks']);(a.out/'provider-selection-browser.json').write_text(json.dumps(report,indent=2))
 browser.close()
print('PASS',report['providers'],'providers;',report['passed'],'real browser event/select checks')
