"""Real Chromium: assigned popup modes and optional Local history persistence.

No browser extension installation, credentials, provider, or model are used.
Local translation jobs are Independent. The low-level IndexedDB history checks
exercise optional Conversation storage, not an editable Local mode selector.
"""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
from pathlib import Path
import argparse
import json
import re
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, default=Path('/tmp/tp-conversation-browser'))
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parents[1]
html = (root / 'src/popup/popup.html').read_text()
# .68: the per-model token ceiling block replaced the Cloud/Local rate-cap blocks.
start = html.index('          <div class="field" id="ai-token-ceiling-wrap"')
end = html.index('        </section>', html.index('id="ai-translation-mode"', start))
fragment = html[start:end].replace('id="ai-token-ceiling-wrap" style="display: none"', 'id="ai-token-ceiling-wrap"')
css = (root / 'src/shared/theme.css').read_text() + '\n' + (root / 'src/popup/popup.css').read_text()
report = {'scope': 'Chromium production HTML/CSS/profile hydration/events and optional IndexedDB history with synthetic data, no live provider', 'checks': []}

def check(name, actual):
    report['checks'].append({'name': name, 'passed': bool(actual)})
    print(name, bool(actual), flush=True)
    assert actual, name

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=chromium_executable(), headless=True,
        args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
    page = browser.new_page(viewport={'width': 380, 'height': 630})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    # Secure fixed origin makes IndexedDB and crypto available across page reloads.
    page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html><body></body></html>')
               if route.request.url.startswith('http://127.0.0.1:8765/') else route.abort())
    # Managed test browsers may block navigation; UI checks need no origin.
    try:
        page.goto('http://127.0.0.1:8765/')
        persistent_origin = True
    except Exception as error:
        if 'ERR_BLOCKED_BY_ADMINISTRATOR' not in str(error):
            raise
        page.close()
        page = browser.new_page(viewport={'width': 380, 'height': 630})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/*', lambda route: route.abort())
        persistent_origin = False
        report['persistence'] = 'Not exercised in Chromium: managed browser blocks origins; covered by separate state fixtures.'
    page.set_content('<!doctype html><meta charset="utf-8"><style>'+css+'</style><main id="fixture" style="padding:12px">'+fragment+'</main>')
    modules = {}
    def module(name):
        if name in modules:
            return modules[name]
        source_file = (root/name).resolve()
        source = source_file.read_text()
        def replace_import(match):
            relative = (source_file.parent/match[3]).resolve().relative_to(root).as_posix()
            return match[1] + json.dumps(module(relative))
        source = re.sub(r'(\b(?:from\s*|import\s*))([\'\"])(\.[^\'\"]+)\2', replace_import, source)
        modules[name] = page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))", source)
        return modules[name]
    page.set_default_timeout(6000)
    if not persistent_origin:
        page.evaluate("Object.defineProperty(crypto,'randomUUID',{value:()=> '00000000-0000-4000-8000-000000000001'})")
    events = module('src/popup/controllers/popup-event-controller.js')
    page.evaluate('''async url=>{
      window.saved=[];window.broadcasts=[];window.networkCalls=0;
      globalThis.fetch=async()=>{networkCalls++;throw new Error('Unexpected provider request');};
      globalThis.chrome={runtime:{sendMessage:(m,cb)=>{broadcasts.push(m);cb?.();},lastError:null},storage:{onChanged:{addListener:()=>{}}}};
      const els=new Proxy({aiTranslationMode:document.querySelector('#ai-translation-mode'),aiConversationReset:document.querySelector('#ai-conversation-reset')},
        {get:(t,k)=>t[k]||(t[k]=document.createElement('input'))});
      (await import(url)).bindPopupEvents({els,state:{},profileController:{saveProfile:async patch=>{saved.push(patch);}},profilePagehideFlush:{},
        usageController:{},providerMetaController:{},localConnectionController:{},apiHealthController:{}});
    }''', events)
    check('Both assigned modes remain visible', page.locator('#ai-translation-mode').input_value() == 'conversation' and
          page.locator('#ai-translation-mode option').all_text_contents() == ['Conversation', 'Independent'])
    check('Translation mode is read-only with an accessible assignment label',
          page.locator('#ai-translation-mode').is_disabled() and
          page.locator('#ai-translation-mode').get_attribute('aria-label') == 'Assigned translation mode')
    check('Assigned mode follows the token ceiling block', page.evaluate('''()=>{
      const ceiling=document.querySelector('#ai-token-ceiling-wrap');
      return ceiling.nextElementSibling.id==='ai-translation-mode-wrap';
    }'''))
    # 10496: the explanation is the hover tip of the option name, not text under it.
    explanation = page.locator('#ai-translation-mode-tip').inner_text() if page.locator('#ai-translation-mode-tip').is_visible() else page.evaluate("document.querySelector('#ai-translation-mode-tip').textContent")
    check('Mode explanation states the automatic Cloud/Local assignment',
          page.locator('#ai-translation-mode-wrap [data-tip-src="ai-translation-mode-tip"]').count() == 1 and
          'Cloud → Conversation' in explanation and 'Local → Independent' in explanation and
          'automatically' in explanation and len(explanation) < 180 and
          not re.search('[\u0e00-\u0e7f]', explanation))
    page.evaluate("document.querySelector('#ai-translation-mode').dispatchEvent(new Event('change',{bubbles:true}))")
    check('No manual mode change save, reset control, broadcast, or warmup request',
          page.locator('#ai-conversation-reset').count()==0 and
          page.evaluate('saved.length===0 && broadcasts.length===0 && networkCalls===0'))
    profiles = module('src/popup/controllers/ai-profile-controller.js')
    cloud_catalog = module('src/shared/ai/providers/cloud-registry.js')
    local_catalog = module('src/shared/ai/providers/local-registry.js')
    assignments = page.evaluate('''async ({profiles,cloud,local})=>{
      const {createAiProfileController}=await import(profiles);
      const choices=[
        ...(await import(cloud)).cloudProviderCatalog().map(p=>({id:p.id,endpoint:p.baseUrl,mode:'conversation'})),
        ...(await import(local)).localProviderCatalog().map(p=>({id:p.id,endpoint:p.baseUrl,mode:'independent'})),
        {id:'customlocal',endpoint:'http://127.0.0.1:9999/v1',mode:'independent'},
      ];
      const results=[];
      for(const {id,endpoint,mode} of choices){
        const stored={aiProvider:id,aiBaseUrl:endpoint,aiModel:`${id}-fixture`,aiTranslationMode:'conversation'};
        const input=value=>Object.assign(document.createElement('input'),{value});
        const els={aiProvider:input(id),aiBaseUrl:input(endpoint),aiModel:input(stored.aiModel),
          aiTranslationMode:document.querySelector('#ai-translation-mode'),aiThinking:document.createElement('select'),
          aiPageImage:input(''),aiMemoryMode:input('off'),aiStyleExamples:input(''),
          aiStyleExamplesWrap:document.createElement('div'),aiLocalCapacityMode:input('auto'),
          aiLocalManualConcurrency:input('1'),aiPrompt:input('')};
        const profile=createAiProfileController({els,state:{desiredAiModel:stored.aiModel,desiredLang:'th'},
          setStorage:async patch=>Object.assign(stored,structuredClone(patch))});
        await profile.initialize(stored);
        const provider=stored.aiProfilesV1.providers[stored.aiProfilesV1.active.providerIdentity];
        const hydrated={mode:els.aiTranslationMode.value,readonly:els.aiTranslationMode.disabled,
          examples:!els.aiStyleExamples.disabled,previousPreference:provider.models[stored.aiModel].profile.translationMode};
        els.aiModel.value=`${id}-fresh-model`;
        profile.selectModel(els.aiModel.value);
        await profile.saveProfile({});
        const persisted=stored.aiProfilesV1.providers[stored.aiProfilesV1.active.providerIdentity]
          .models[els.aiModel.value].profile.translationMode;
        results.push({id,expected:mode,...hydrated,persisted});
      }
      return results;
    }''', {'profiles': profiles, 'cloud': cloud_catalog, 'local': local_catalog})
    report['provider_assignments'] = assignments
    check('Current catalogs cover 9 Cloud and 10 Local choices',
          sum(v['expected']=='conversation' for v in assignments)==9 and
          sum(v['expected']=='independent' for v in assignments)==10)
    for assignment in assignments:
        check(f"{assignment['id']}: real popup hydration and new-profile save follow the provider assignment",
              assignment['mode']==assignment['expected'] and assignment['readonly'] and
              assignment['examples'] is True and  # 10447: the Human examples switch serves Conversation and Independent
              assignment['previousPreference']=='conversation' and
              assignment['persisted']==assignment['expected'])
    check('Profile hydration and save never call a provider or broadcast a mode change',
          page.evaluate('saved.length===0 && broadcasts.length===0 && networkCalls===0'))
    check('No horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=380'))
    page.locator('#fixture').screenshot(path=str(args.out/'conversation-option.png'))
    if persistent_origin:
        history = module('src/background/ai/translation-paths/local-history.js')
        base = {'provider':'ollama','model':'fixture','base_url':'http://127.0.0.1:11434','prompt':'Fixture style','thinking':'off','memory_mode':'off',
            'conversation':{'owner':'synthetic-owner','documentId':'doc-1','reset':'0'}}
        result = page.evaluate('''async ({url,ai})=>{
          const {withLocalHistory}=await import(url);
          return withLocalHistory(ai,'th','en',null,async s=>{
            const storage=await s.save({history:[{user:'Hello',assistant:'สวัสดี'}],prefix:'fixture',revision:1});
            return {before:s.history.length,storage};
          });
        }''', {'url': history, 'ai': base})
        check('Direct Local commits to real IndexedDB',result == {'before':0,'storage':'local_indexeddb'})
        page.reload()
        modules.clear()
        history = module('src/background/ai/translation-paths/local-history.js')
        result = page.evaluate('''async ({url,ai})=>{
          const {withLocalHistory}=await import(url);
          const result=[];
          for (const c of [ai,{...ai,conversation:{...ai.conversation,owner:'other'}},{...ai,conversation:{...ai.conversation,documentId:'doc-fresh'}},ai]) {
            result.push(await withLocalHistory(c,'th','en',null,s=>({turns:s.history.length,storage:s.storage})));
          }
          return result;
        }''', {'url': history, 'ai': base})
        check('History restored after a real page reload',result[0] == {'turns':1,'storage':'local_indexeddb'})
        check('Other owner and document cannot see stored history', [v['turns'] for v in result] == [1,0,0,1])
    check('No browser script errors', not errors)
    report['errors'] = errors
    browser.close()
report['passed'] = len(report['checks'])
(args.out/'conversation-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(f"PASS {report['passed']} actual Chromium conversation checks (see report for IndexedDB origin availability)")
