"""Real Chromium: production popup events and persistent Direct Local history.

No browser extension installation, credentials, provider, or model are used.
"""
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
start = html.index('          <div class="field" id="ai-rate-wrap"')
end = html.index('        </section>', html.index('id="ai-translation-mode"', start))
fragment = html[start:end].replace('id="ai-rate-wrap" style="display: none"', 'id="ai-rate-wrap"')
css = (root / 'src/shared/theme.css').read_text() + '\n' + (root / 'src/popup/popup.css').read_text()
report = {'scope': 'Chromium production HTML/CSS/events and IndexedDB with synthetic history, no live provider', 'checks': []}

def check(name, actual):
    report['checks'].append({'name': name, 'passed': bool(actual)})
    print(name, bool(actual), flush=True)
    assert actual, name

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
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
      globalThis.chrome={runtime:{sendMessage:(m,cb)=>{broadcasts.push(m);cb?.();},lastError:null},storage:{onChanged:{addListener:()=>{}}}};
      const els=new Proxy({aiTranslationMode:document.querySelector('#ai-translation-mode'),aiConversationReset:document.querySelector('#ai-conversation-reset')},
        {get:(t,k)=>t[k]||(t[k]=document.createElement('input'))});
      (await import(url)).bindPopupEvents({els,state:{},profileController:{saveProfile:async patch=>{saved.push(patch);}},profilePagehideFlush:{},
        usageController:{},providerMetaController:{},localConnectionController:{},apiHealthController:{}});
    }''', events)
    check('Conversation is selected and Independent remains visible', page.locator('#ai-translation-mode').input_value() == 'conversation' and 'Independent (original)' in page.locator('#ai-translation-mode').inner_text())
    check('Independent option is disabled', page.locator('#ai-translation-mode option[value="independent"]').is_disabled())
    check('Translation mode selector remains inspectable', not page.locator('#ai-translation-mode').is_disabled())
    check('Selector is immediately after rate-cap block', page.evaluate("document.querySelector('#ai-rate-wrap').nextElementSibling.id==='ai-translation-mode-wrap'"))
    check('Mode explanation stays short and English', len(page.locator('#ai-translation-mode-wrap .hint').inner_text()) < 120 and not re.search('[\u0e00-\u0e7f]',page.locator('#ai-translation-mode-wrap').inner_text()))
    check('No Independent change event or warmup request',page.locator('#ai-conversation-reset').count()==0 and page.evaluate('saved.length===0 && broadcasts.length===0 && networkCalls===0'))
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
