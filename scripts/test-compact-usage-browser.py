"""Real Chromium UI check with fixture data; no installed extension/live model."""
from pathlib import Path
import json,re,argparse
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=Path('/tmp/tp-compact-usage'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
r=Path(__file__).resolve().parents[1];html=(r/'src/popup/popup.html').read_text();fragment=html[html.index('          <details class="ai-compact-panel"'):html.index('          <dialog id="ai-usage-history-dialog"')]
css=(r/'src/shared/theme.css').read_text()+'\n'+(r/'src/popup/popup.css').read_text()
report={'scope':'actual Chromium, production HTML/CSS/controller, fixture usage and request; no live provider','checks':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 page=browser.new_page(viewport={'width':344,'height':520},device_scale_factor=1)
 page.route('**/*',lambda route:route.abort())
 page.set_content('<!doctype html><meta charset="utf-8"><style>'+css+'</style><main style="padding:10px" id="fixture">'+fragment+'</main>')
 cache={}
 def module(name):
  if name in cache:return cache[name]
  f=(r/name).resolve();s=f.read_text()
  def rep(m):return m[1]+json.dumps(module((f.parent/m[3]).resolve().relative_to(r).as_posix()))
  s=re.sub(r'(\b(?:from\s*|import\s*))([\'\"])(\.[^\'\"]+)\2',rep,s)
  cache[name]=page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))",s);return cache[name]
 url=module('src/popup/controllers/usage-view-controller.js')
 page.evaluate('''async url=>{
 const {createUsageViewController}=await import(url);const el=id=>document.getElementById(id);
 const els={aiProvider:{value:'huggingface'},aiModel:{value:'deepseek-ai/DeepSeek-V4-Flash-0731'},lang:{value:'th'},
 aiUsageLabel:el('ai-usage-label'),aiUsageWrap:el('ai-usage-wrap'),aiUsageKind:el('ai-usage-kind'),aiUsageModel:el('ai-usage-model'),aiUsageCounts:el('ai-usage-counts'),aiUsageTotal:el('ai-usage-total'),
};
 window.refreshCalls=0;
 const row={runtime:'cloud',provider:'huggingface',model:els.aiModel.value,requests:46,inputTokens:136342,outputTokens:3954,totalTokens:140296,thinkingTokens:0,cachedInputTokens:43520,tokenStatus:'incomplete',incompleteRequests:3,pendingOperations:3};
 window.ui=createUsageViewController({els,state:{desiredLang:'th'},isLocalProvider:()=>false,getStorage:async()=>({}),storageKey:'usage',currentUsage:()=>row,historyRows:()=>[]});ui.render(row);
}''',url)
 def check(name,passed,value=None):
  report['checks'].append({'name':name,'passed':bool(passed),'value':value});assert passed,(name,value)
 height=page.locator('#fixture').bounding_box()['height'];check('Usage panel is compact, total height <= 50px',height<=50,height)
 page.locator('#fixture').screenshot(path=str(a.out/'compact-closed.png'))
 page.locator('#ai-usage-wrap > summary').click();check('Usage expands by user action',page.locator('#ai-usage-wrap').get_attribute('open') is not None)
 text=page.locator('#ai-usage-counts').inner_text();check('English labels despite Thai target',not re.search(r'[\u0e00-\u0e7f]',text),text)
 check('Partial total and pending visible', 'Recorded total: 140,296' in text and 'Awaiting usage: 3' in text)
 check('Latest AI request panel is absent',page.locator('#ai-diagnostics-wrap').count()==0)
 page.locator('#fixture').screenshot(path=str(a.out/'compact-expanded.png'))
 check('No horizontal overflow',page.evaluate('document.documentElement.scrollWidth <= 344'))
 browser.close()
report['passed']=len(report['checks']);(a.out/'ui-browser.json').write_text(json.dumps(report,indent=2));print(f"PASS {report['passed']} actual Chromium compact UI checks")
