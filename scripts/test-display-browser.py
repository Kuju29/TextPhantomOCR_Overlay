"""Optional actual Chromium display check; no server, credentials or network.
python scripts/test-display-browser.py --browser /usr/bin/chromium --out /tmp/tp-display
"""
from pathlib import Path
import argparse, json, re, subprocess, sys
from playwright.sync_api import sync_playwright
parser=argparse.ArgumentParser();parser.add_argument('--project',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--browser',default='/usr/bin/chromium');parser.add_argument('--out',type=Path,default=Path('/tmp/tp-display-browser'))
args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(args.project/'api'))
from backend.render.html.translated import render_translated_overlay
from backend.render.html.css import overlay_css
NODE=r'''import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.argv[1]+'/');
const {buildTranslatedLensDocument}=await import(new URL('src/shared/lens-document.js',root));
const fixture=JSON.parse(await readFile(new URL('scripts/fixtures/renderer-golden.json',root),'utf8'));
const tree={side:'translated',paragraphs:fixture.paragraphs.map((p,index)=>({para_index:index,text:p.lensItems.map(i=>i.text).join(' '),items:p.lensItems.map((i,j)=>({text:i.text,item_index:j,height_raw:i.height,baseline_p1:{x:i.baseline[0][0],y:i.baseline[0][1]},baseline_p2:{x:i.baseline[1][0],y:i.baseline[1][1]},box:{rotation_deg:i.rotation}}))}))};
tree.paragraphs[2].items[0].box.rotation_deg=-90;
const doc=buildTranslatedLensDocument(tree,{...fixture.image,sourceLang:'ja',targetLang:'th'});
console.log(JSON.stringify({doc,tree,original:fixture}));'''
data=json.loads(subprocess.check_output(['node','--input-type=module','-e',NODE,str(args.project.resolve())],text=True))
api_html={str(rotate):render_translated_overlay(data['tree'],500,800,rotate=rotate,target_lang='th') for rotate in [False,True]}
report={'scope':'actual Chromium DOM; pure render modules / server-generated HTML; no installed extension or live provider','checks':[]}
def check(name,passed,details=None):
    row={'name':name,'pass':bool(passed)}
    if details is not None:row['details']=details
    report['checks'].append(row);print(('PASS' if passed else 'FAIL')+' '+name,flush=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
    report['browser']=browser.version
    context=browser.new_context(viewport={'width':650,'height':900});context.route('**/*',lambda route:route.abort())
    page=context.new_page();page.set_content('<!doctype html><meta charset="utf-8"><title>TextPhantom display verification</title><style>body{margin:20px;font:16px sans-serif;background:#eee}main{position:relative;width:500px;height:800px;background:white}.tp-line{outline:1px dashed #999}</style><h3 id="heading"></h3><main></main>')
    cache={}
    def module(name):
        if name in cache:return cache[name]
        path=(args.project/'src'/name).resolve();source=path.read_text()
        def replace(match):
            dep=(path.parent/match.group(3)).resolve().relative_to((args.project/'src').resolve()).as_posix()
            return match.group(1)+json.dumps(module(dep))
        source=re.sub(r'(\b(?:from\s*|import\s*))(["\'])(\.[^"\']+)\2',replace,source)
        cache[name]=page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))",source);return cache[name]
    url=module('processors/render/renderer.js')
    page.evaluate('''async ({url,data})=>{window.renderer=await import(url);window.fixture=data;
      const css=document.createElement('style');css.textContent=renderer.OVERLAY_CSS;document.head.append(css);
      window.originalWire=JSON.stringify(data.doc);
      window.draw=rotate=>{const result=renderer.renderOverlay(fixture.doc,{source:'translated',relayoutTranslated:rotate});document.querySelector('main').replaceChildren(result.root);return result.report;};
      window.inspect=()=>[...document.querySelectorAll('.tp-line')].map(e=>{
        const c=getComputedStyle(e),m=new DOMMatrix(c.transform==='none'?undefined:c.transform);
        let startY=null,endY=null;
        if(e.firstChild?.nodeType===3 && e.firstChild.length>1){const r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);startY=r.getBoundingClientRect().y;r.setStart(e.firstChild,e.firstChild.length-1);r.setEnd(e.firstChild,e.firstChild.length);endY=r.getBoundingClientRect().y;}
        return {text:e.textContent,group:e.dataset.tpGroup||'',rotation:Math.atan2(m.b,m.a)*180/Math.PI,font:parseFloat(c.fontSize),writingMode:c.writingMode,startY,endY,scrollW:e.scrollWidth,clientW:e.clientWidth,scrollH:e.scrollHeight,clientH:e.clientHeight};});
    }''',{'url':url,'data':data})
    page.evaluate("document.querySelector('#heading').textContent='Translated — Rotate OFF / left-facing columns';draw(false)")
    off=page.evaluate('inspect()');check('OFF: both mixed-sign vertical columns face -90 degrees',all(abs(x['rotation']+90)<1e-6 for x in off[1:]))
    check('OFF: text starts at bottom and ascends in actual DOM ranges',all(x['startY']>x['endY'] for x in off[1:]),off[1:])
    check('OFF: common computed font size in one translated group',off[1]['font']==off[2]['font'] and off[1]['group']==off[2]['group'])
    check('OFF: horizontal caption remains horizontal',abs(off[0]['rotation'])<1e-6)
    page.screenshot(path=str(args.out/'translated-off.png'))
    page.evaluate("document.querySelector('#heading').textContent='Translated — Rotate ON / horizontal reflow';draw(true)")
    on=page.evaluate('inspect()');check('ON: target group becomes one horizontal block',len(on)==2 and abs(on[1]['rotation'])<1e-6 and 'ภาษา ไทย'==on[1]['text'])
    check('ON: horizontal target reflow fits the group height',on[1]['scrollH']<=on[1]['clientH']+2,on[1])
    check('ON/OFF: native horizontal text unchanged',on[0]['font']==off[0]['font'] and on[0]['text']==off[0]['text'])
    page.screenshot(path=str(args.out/'translated-on.png'))
    page.evaluate('draw(false)');check('toggle roundtrip is deterministic; raw document immutable',page.evaluate('inspect()')==off and page.evaluate('JSON.stringify(fixture.doc)===originalWire'))
    extension_off=off;extension_on=on
    page.evaluate('css=>{document.querySelectorAll("style").forEach((s,i)=>{if(i>0)s.remove()});const s=document.createElement("style");s.textContent=css;document.head.append(s)}',overlay_css())
    for rotate in [False,True]:
        page.evaluate('({html,title})=>{document.querySelector("main").innerHTML=html;document.querySelector("#heading").textContent=title}',{'html':api_html[str(rotate)],'title':'API HTML — Rotate '+str(rotate)})
        rows=page.evaluate('inspect()');expected=extension_on if rotate else extension_off
        check(f'API HTML Rotate {rotate}: same text/rotation/font as Extension',[(x['text'],x['rotation'],x['font']) for x in rows]==[(x['text'],x['rotation'],x['font']) for x in expected],rows)
        page.screenshot(path=str(args.out/f'api-translated-{str(rotate).lower()}.png'))
    browser.close()
report['passed']=sum(c['pass'] for c in report['checks']);report['failed']=sum(not c['pass'] for c in report['checks'])
(args.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if report['failed'] else 0)
