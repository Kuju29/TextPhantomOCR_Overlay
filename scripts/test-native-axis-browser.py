"""Optional real Chromium regression for both native Lens vertical encodings.
Constructed geometry, not a replay of the latest screenshot's absent Lens tree.
"""
from pathlib import Path
import argparse, copy, json, math, re, sys
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--project',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--browser',default='/usr/bin/chromium');p.add_argument('--out',type=Path,default=Path('/tmp/tp-native-axis'))
a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True);sys.path.insert(0,str(a.project/'api'))
from backend.render.html.translated import render_translated_overlay
from backend.render.html.overlay import render_tree_overlay
from backend.render.html.css import overlay_css
W,H=500,800

def native(text,x,y,width,height,angle=0,index=0):
    rad=math.radians(angle);cx=x+width/2;cy=y+height/2
    return {'item_index':index,'text':text,'height_raw':height/H,
      'baseline_p1':{'x':(cx-math.cos(rad)*width/2)/W,'y':(cy-math.sin(rad)*width/2)/H},
      'baseline_p2':{'x':(cx+math.cos(rad)*width/2)/W,'y':(cy+math.sin(rad)*width/2)/H},
      'box':{'left':x/W,'top':y/H,'width':width/W,'height':height/H,'rotation_deg':angle,'center':{'x':cx/W,'y':cy/H}}}

def tree_of(items,side='translated',same_paragraph=False):
    packs=[items] if same_paragraph else [[it] for it in items]
    return {'side':side,'source_lang':'ja','paragraphs':[{'para_index':i,'text':' '.join(it['text'] for it in block),'items':block} for i,block in enumerate(packs)]}

original=tree_of([native('これは俺の能力です',250,120,24,240),native('のうりょく',280,210,8,50,index=1)],'original',True)
original['bubble_groups']=[{'bubble_index':0,'para_indices':[0],'direction':'v','text':'これは俺の能力です','bubble_bounds_px':[250,120,288,360],'font_size_px':23}]
translated=tree_of([native('ฉันอยากให้เธอรู้',250,120,30,220),native('ว่าฉันอยู่ตรงนี้',210,120,30,220)])
controls=tree_of([native('Horizontal stays',100,400,180,26),native('ข้อความเอียงจริง',220,560,150,25,32)])
cases={'original':original,'translated':translated,'controls':controls}
api={f'translated-{flag}':render_translated_overlay(translated,W,H,rotate=flag,target_lang='th') for flag in (False,True)}
api['original']=render_tree_overlay(original,W,H,'ja')
report={'scope':'actual offline Chromium; constructed native zero-degree and tilt fixtures; not live Lens/provider or exact user-page replay','checks':[]}
def check(name,value,detail=None):
    report['checks'].append({'name':name,'pass':bool(value),'detail':detail});print(('PASS ' if value else 'FAIL ')+name,flush=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=a.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']);report['browser']=browser.version
    context=browser.new_context(viewport={'width':620,'height':940});context.route('**/*',lambda route:route.abort())
    page=context.new_page();page.set_content('<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#eee;font:16px sans-serif}main{position:relative;width:500px;height:800px;background:white}h3{height:40px}</style><h3></h3><main></main>')
    cache={}
    def module(name):
        if name in cache:return cache[name]
        path=(a.project/'src'/name).resolve();source=path.read_text()
        def replace(m):
            dep=(path.parent/m.group(3)).resolve().relative_to((a.project/'src').resolve()).as_posix();return m.group(1)+json.dumps(module(dep))
        source=re.sub(r'(\b(?:from\s*|import\s*))(["\'])(\.[^"\']+)\2',replace,source)
        cache[name]=page.evaluate("s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'}))",source);return cache[name]
    page.evaluate('''async ({renderer,builder,cases})=>{
      window.renderer=await import(renderer);const {buildTranslatedLensDocument}=await import(builder);
      window.docs={};for(const [key,tree] of Object.entries(cases)){
        const d=buildTranslatedLensDocument(tree,{width:500,height:800,sourceLang:'ja',targetLang:'th'});
        if(key==='original'){d.paragraphs.forEach(p=>{p.items=p.lensItems;p.sourceText=p.lensText;});
          d.canonicalOriginalTree={paragraphs:[{id:'group-original',text:'これは俺の能力です',source:{documentParagraphIds:['p0']},direction:'v'}]};}
        docs[key]=d;
      }
      window.originalSnapshot=JSON.stringify(docs);
      window.css=document.createElement('style');css.textContent=window.renderer.OVERLAY_CSS;document.head.append(css);
      window.draw=(key,rotate)=>{document.querySelector('h3').textContent=key+' / Rotate '+rotate+' / 100%';
        const r=window.renderer.renderOverlay(docs[key],{source:key==='original'?'original':'translated',relayoutTranslated:rotate});document.querySelector('main').replaceChildren(r.root);return r.report;};
      window.inspect=()=>[...document.querySelectorAll('.tp-line')].map(e=>{
        const c=getComputedStyle(e),m=new DOMMatrix(c.transform==='none'?undefined:c.transform);
        let first=null,last=null;
        if(e.firstChild?.nodeType===3&&e.firstChild.length>1){const r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);first=r.getBoundingClientRect().y;r.setStart(e.firstChild,e.firstChild.length-1);r.setEnd(e.firstChild,e.firstChild.length);last=r.getBoundingClientRect().y;}
        return {text:e.textContent,font:parseFloat(c.fontSize),lineHeight:parseFloat(c.lineHeight),rotation:Math.atan2(m.b,m.a)*180/Math.PI,writing:c.writingMode,opacity:c.opacity,visibility:c.visibility,first,last,sw:e.scrollWidth,cw:e.clientWidth,sh:e.scrollHeight,ch:e.clientHeight,group:e.dataset.tpGroup||''};});
    }''',{'renderer':module('processors/render/renderer.js'),'builder':module('shared/lens-document.js'),'cases':cases})
    page.evaluate("draw('original',false)");allrows=page.evaluate('inspect()');o=[r for r in allrows if r['opacity']!='0']
    check('Original zero-degree CJK keeps upright vertical flow',len(o)==2 and all(r['writing']=='vertical-rl' and r['rotation']==0 for r in o),o)
    check('Original main font does not average down with ruby',o[0]['font']>=20 and o[1]['font']<=12)
    check('Original CJK starts at top and ends below',all(r['first']<r['last'] for r in o))
    check('Original canonical group is hidden and original text is conserved',len(allrows)==3 and allrows[-1]['opacity']=='0' and allrows[-1]['text']=='これは俺の能力です')
    page.screenshot(path=str(a.out/'original-zero-degree.png'))
    rows_by={}
    for flag in (False,True):
        page.evaluate("f=>draw('translated',f)",flag);rows=page.evaluate('inspect()');rows_by[flag]=rows
        check(f'Translated {flag}: readable fixture font at 100%',all(r['font']>=20 for r in rows),rows)
        check(f'Translated {flag}: preserved all target text',''.join(r['text'] for r in rows).replace(' ','')=='ฉันอยากให้เธอรู้ว่าฉันอยู่ตรงนี้')
        check(f'Translated {flag}: text fits local canvas',all(r['sh']<=r['ch']+2 and r['sw']<=r['cw']+2 for r in rows))
        if flag:
            check('Rotate ON uses one horizontal union block, not narrow-column font',len(rows)==1 and rows[0]['rotation']==0)
        else:
            check('Rotate OFF normalizes tall zero-angle columns to -90 and lower start',all(r['rotation']==-90 and r['first']>r['last'] for r in rows))
            check('Rotate OFF one translated group shares font',len({r['font'] for r in rows})==1 and len({r['group'] for r in rows})==1)
        page.screenshot(path=str(a.out/f'translated-zero-{flag}.png'))
    page.evaluate("draw('controls',false)");control=page.evaluate('inspect()')
    check('Horizontal and genuinely tilted targets remain unchanged',control[0]['rotation']==0 and abs(control[1]['rotation']-32)<1e-5,control)
    page.evaluate("draw('translated',false)")
    check('Toggle roundtrip deterministic and native documents immutable',page.evaluate('inspect()')==rows_by[False] and page.evaluate('JSON.stringify(docs)===originalSnapshot'))
    page.evaluate('s=>css.textContent=s',overlay_css())
    for key in ('original','translated-False','translated-True'):
        page.evaluate('({html,key})=>{document.querySelector("main").innerHTML=html;document.querySelector("h3").textContent="API "+key}',{'html':api[key],'key':key});rows=[r for r in page.evaluate('inspect()') if r['opacity']!='0']
        ref=o if key=='original' else rows_by[key.endswith('True')]
        check(f'API {key}: text/orientation/font parity with Extension',[(r['text'],r['font'],r['rotation'],r['writing']) for r in rows]==[(r['text'],r['font'],r['rotation'],r['writing']) for r in ref],rows)
        if key!='original':check(f'API {key}: local layout stays within canvas',all(r['sh']<=r['ch']+2 and r['sw']<=r['cw']+2 for r in rows))
        page.screenshot(path=str(a.out/f'api-{key}.png'))
    browser.close()
report['passed']=sum(r['pass'] for r in report['checks']);report['failed']=len(report['checks'])-report['passed']
(a.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if report['failed'] else 0)
