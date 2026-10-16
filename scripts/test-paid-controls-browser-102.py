"""Native Chromium DOM + production controllers; synthetic browser API/storage/network."""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
from pathlib import Path
import json,re,base64,argparse,hashlib
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=Path('/tmp/tp-paid-ui-102'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[1]
report={'scope':'Actual popup HTML/CSS, controllers and Prompt Studio in Chromium; shimmed extension APIs/storage, SHA-256 via Python and URL query shim (browser network blocked by environment); synthetic account; not an installed extension', 'checks':[]}
def html(name):
 s=(root/name).read_text();s=re.sub(r'<script\b[^>]*>.*?</script>','',s,flags=re.S)
 s=re.sub(r'<link[^>]+rel="stylesheet"[^>]+>','',s)
 css=(root/'src/shared/theme.css').read_text()+'\n'+(root/Path(name).with_suffix('.css')).read_text()
 s=s.replace('</head>','<style>'+css+'</style></head>')
 return s.replace('../icons/48.png','data:image/png;base64,'+base64.b64encode((root/'src/icons/48.png').read_bytes()).decode())
def modules(page):
 cache={}
 def module(name):
  if name in cache:return cache[name]
  f=root/name;source=f.read_text()
  if name=="src/prompt/prompt.js": source=source.replace("location.search", "(globalThis.__qaLocationSearch || location.search)")
  def sub(m):return m[1]+json.dumps(module((f.parent/m[3]).resolve().relative_to(root).as_posix()))
  source=re.sub(r'(\b(?:from\s*|import\s*))([\'"])(\.[^\'"]+)\2',sub,source)
  cache[name]=page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))",source)
  return cache[name]
 return module
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=chromium_executable(),headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 page=b.new_page(viewport={'width':470,'height':1500});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/*',lambda r:r.abort());page.set_content(html('src/popup/popup.html'))
 page.expose_function('_qaSha256',lambda data:list(hashlib.sha256(bytes(data)).digest()))
 page.evaluate('''()=>{if(!crypto.subtle)Object.defineProperty(crypto,'subtle',{value:{digest:async(name,data)=>new Uint8Array(await window._qaSha256(Array.from(new Uint8Array(data)))).buffer}})}''')
 mod=modules(page)
 urls=[mod(x) for x in ['src/popup/dom.js','src/popup/controllers/ai-profile-controller.js','src/popup/controllers/paid-service-controller.js','src/popup/controllers/popup-ui-controller.js','src/popup/controllers/popup-event-controller.js','src/popup/controllers/settings-persistence-controller.js','src/popup/controllers/ai-profile-storage-writer.js']]
 result=page.evaluate('''async urls=>{
 const [dom,profiles,paid,ui,events,persistence,writers]=await Promise.all(urls.map(u=>import(u)));
 const {els}=dom,noop=()=>{},asyncNoop=async()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const checks=[],check=(name,ok,actual)=>{checks.push({name,passed:!!ok});if(!ok)throw Error(name+': '+JSON.stringify(actual));};
 const store={tpDataConsentV1:{version:1,granted:true,at:1},aiServiceMode:'paid',paidSessionToken:'QA_customer_only',paidEmail:'tester@example.com',paidApiBase:'http://localhost:7860',paidModel:'qa/vision',customApiUrl:'http://localhost:7860',apiUrlDefault:'http://api-default.test',apiDefaultsFetchedAt:Date.now(),aiProvider:'huggingface',aiModel:'manual/text',lang:'th',aiPrompt:'Translate naturally into Thai.',aiThinking:'minimum'};
 window.__store=store;window.__opened=[];
 window.chrome={storage:{local:{get(keys,cb){const value=Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||store)).map(k=>[k,store[k]]));cb?.(value);return Promise.resolve(value);},set(patch,cb){Object.assign(store,structuredClone(patch));cb?.();return Promise.resolve();}},onChanged:{addListener:noop,removeListener:noop}},runtime:{getURL:x=>'https://ui.test/'+x,sendMessage:asyncNoop,getManifest:()=>({version:'2026.10.1.2'})},tabs:{create:x=>window.__opened.push(x)}};
 let isPaused=false;window.__pause=()=>{isPaused=true;};
 const caps={reasoning:{supported:true,mandatory:false,control:'levels',supported_efforts:['none','low','high']},vision:{supported:true,source:'QA verified catalogue'}};
 window.fetch=async (url,opts)=>({ok:true,status:200,json:async()=>String(url).endsWith('/paid/me')?{email:'tester@example.com',paid_paused:isPaused,credits:{available:'10000',held:'0'},models:[{id:'qa/vision',name:'QA Vision · test model',eligible_tp:'10000',model_capabilities:caps}]}:{available:true,paid:{available:true}}});
 const options=(el,v,val)=>{el.replaceChildren(...v.map(x=>new Option(x,x)));el.value=val;};
 options(els.mode,['lens_text'],'lens_text');options(els.sources,['ai'],'ai');options(els.lang,['th','en'],'th');options(els.aiProvider,['huggingface'],'huggingface');options(els.aiModel,['manual/text'],'manual/text');els.apiUrl.value=store.customApiUrl;
 const state={desiredLang:'th',desiredSources:'ai',desiredAiModel:'manual/text',lastSavedApiUrl:store.customApiUrl,aiPromptByLang:{},aiPromptDirtyByLang:{},apiDefaults:{},aiMetaSeq:0,aiProbeSeq:0};
 const write=writers.createAiProfileStorageWriter(async patch=>Object.assign(store,structuredClone(patch)));
 const profile=profiles.createAiProfileController({els,state,setStorage:write});await profile.initialize(store);
 let pc;const uic=ui.createPopupUiController({els,state,isLocalProvider:()=>false,toggleDom:dom.toggleUi,applyPaidMode:()=>pc?.applyVisibility(),updatePromptWarning:noop,validateAiKey:noop,validateLangSource:noop});
 const persist=persistence.createSettingsPersistenceController({els,state,profileController:profile,providerMetaController:{schedule:noop,renderStatus:noop},apiHealthController:{},persist:write,setStatus:noop,setFieldMessage:noop,toggleUi:uic.toggle,canUseAiUi:()=>true,isRemoteDefaultApiUrl:()=>false,refreshPromptHistoryButtons:asyncNoop});
 pc=paid.createPaidServiceController({els,state,getStorage:async keys=>Object.fromEntries(keys.map(k=>[k,store[k]])),setStorage:write,toggleUi:uic.toggle,onProfileContext:c=>profile.setPaidContext(c),beforeSwitch:()=>persist.flushPendingAiEditsForSwitch(state.desiredLang,state.desiredAiModel)});
 events.bindPopupEvents({els,state,profileController:profile,profilePagehideFlush:persist.profilePagehideFlush,providerMetaController:{cancelSchedule:noop},localConnectionController:{refreshThinkingCompatibility:noop},apiHealthController:{},usageController:{},applyPromptForLang:noop,updatePromptCount:noop,toggleUi:uic.toggle,canUseAiUi:()=>true,fieldMessageType:()=>'',setFieldMessage:noop,updateAiPromptWarning:noop,scheduleSaveAi:persist.scheduleSaveAi,flushPromptForLang:persist.flushPromptForLang,flushPendingAiEditsForSwitch:persist.flushPendingAiEditsForSwitch,refreshSeriesMemory:asyncNoop});
 await pc.initialize();pc.setAvailability(true,store.customApiUrl);await sleep(150);uic.toggle();
 document.querySelector('#panel-translate').hidden=true;document.querySelector('#panel-tools').hidden=true;document.querySelector('#panel-ai').hidden=false;document.querySelector('#panel-ai').classList.add('active');document.querySelector('#tab-ai').setAttribute('aria-selected','true');document.querySelector('#tab-translate').setAttribute('aria-selected','false');
 check('Signed-in Paid account retains shared options',state.paidReady,state);
 for(const key of ['aiThinkingWrap','aiPromptWrap','aiCharactersWrap','aiPageImageWrap','aiTokenCeilingWrap','aiTranslationModeWrap'])check(key+' is visible',getComputedStyle(els[key]).display!=='none' && els[key].getBoundingClientRect().height>0);
 for(const key of ['aiProviderWrap','aiKeyWrap','aiModelWrap'])check(key+' is hidden',getComputedStyle(els[key]).display==='none');
 els.aiThinking.value='high';els.aiThinking.dispatchEvent(new Event('change'));await sleep(30);
 els.aiMemoryMode.value='full';els.aiMemoryMode.dispatchEvent(new Event('change'));await sleep(30);
 els.aiPageImage.checked=true;els.aiPageImage.dispatchEvent(new Event('change'));await sleep(30);
 els.aiPrompt.value='Keep Sora as โซระ. Natural Thai dialogue.';els.aiPrompt.dispatchEvent(new Event('input'));await sleep(550);
 const entry=()=>Object.values(store.paidAiProfilesV1.entries).find(x=>x.profile.thinking==='high');
 check('Native thinking change persists',entry()?.profile.thinking==='high');check('Native series memory persists',entry()?.profile.memoryMode==='full');check('Native page-image checkbox persists',entry()?.profile.pageImage==='always');
 check('Popup prompt debounce saves Paid not Manual style',entry()?.prompts.th.text===els.aiPrompt.value,store);
 els.aiPromptStudio.click();await sleep(50);
 check('Prompt Studio opens the selected Paid model identity',window.__opened[0]?.url.includes('model=qa%2Fvision')&&window.__opened[0]?.url.includes('identity=paid%3A'),window.__opened);
 check('Cloud Translation mode remains Conversation',els.aiTranslationMode.value==='conversation');
 window.__qa={pc,profile,els,state,check,checks};return {checks,store};
}''',urls)
 report['checks']+=result['checks'];page.screenshot(path=str(a.out/'paid-controls-desktop.png'),full_page=True)
 result2=page.evaluate('''async()=>{window.__pause();document.querySelector('#ai-paid-refresh').click();await new Promise(r=>setTimeout(r,150));const {state,els}=window.__qa;const passed=!state.paidReady&&/paused/i.test(els.aiPaidStatus.textContent)&&/signed in/i.test(els.aiPaidAccountState.textContent);if(!passed)throw Error(els.aiPaidStatus.textContent);return {name:'Paused is a signed-in service restriction, not Cancelled or unknown',passed};}''')
 report['checks'].append(result2);page.screenshot(path=str(a.out/'paid-paused-desktop.png'),full_page=True)
 store=page.evaluate('window.__store');url=page.evaluate('window.__opened[0].url');page.evaluate('window.__qa.pc.dispose()')
 # Full production Prompt Studio with the exact Paid URL opened above.
 studio=b.new_page(viewport={'width':1100,'height':820});studio.on('pageerror',lambda e:errors.append(str(e)))
 studio.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html('src/prompt/prompt.html')) if r.request.resource_type=='document' else r.abort())
 studio.set_content(html('src/prompt/prompt.html'));studio.evaluate('s=>window.__qaLocationSearch=s','?'+urlsplit(url).query);m=modules(studio)
 studio.evaluate('''store=>{window.__store=store;window.chrome={storage:{local:{get(keys,cb){const v=Object.fromEntries((Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||store)).map(k=>[k,store[k]]));cb?.(v);return Promise.resolve(v);},set(patch,cb){Object.assign(store,structuredClone(patch));cb?.();return Promise.resolve();}}},runtime:{getURL:x=>'https://ui.test/'+x,sendMessage:()=>Promise.resolve(),getManifest:()=>({version:'2026.10.1.2'})}};window.fetch=async()=>({ok:true,json:async()=>({defaultApiUrl:'http://localhost:7860',resetApiUrl:'http://localhost:7860'})});}''',store)
 studio.evaluate('u=>import(u)',m('src/prompt/prompt.js'));studio.wait_for_function("document.querySelector('#ps-text').value.includes('Sora')")
 report['checks'].append({'name':'Full Prompt Studio loads Paid style not hidden Manual style','passed':True})
 studio.locator('#ps-text').fill('Studio: preserve names and speak naturally.');studio.locator('#ps-save').click()
 studio.wait_for_function("Object.values(window.__store.paidAiProfilesV1.entries).some(e=>e.prompts.th?.text.startsWith('Studio:'))")
 result3=studio.evaluate('''before=>{const e=Object.values(window.__store.paidAiProfilesV1.entries).find(x=>x.prompts.th?.text.startsWith('Studio:'));return e.profile.thinking==='high'&&e.profile.pageImage==='always'&&JSON.stringify(before.aiProfilePromptsV1)===JSON.stringify(window.__store.aiProfilePromptsV1)}''',store)
 assert result3
 report['checks'].append({'name':'Full Prompt Studio saves Paid style while preserving controls and Manual prompts','passed':True})
 studio.screenshot(path=str(a.out/'paid-prompt-studio.png'),full_page=True)
 report['browser_errors']=errors;assert not errors,errors
 report['passed']=True;report['total']=len(report['checks']);(a.out/'browser-controls.json').write_text(json.dumps(report,indent=2));b.close()
print(json.dumps(report,indent=2))
