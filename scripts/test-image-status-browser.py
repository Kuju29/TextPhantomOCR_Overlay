"""Offline Chromium: one batch progress board plus image-specific terminal errors."""
from pathlib import Path
import argparse, json, subprocess
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--browser',default='/usr/bin/chromium');p.add_argument('--out',type=Path,default=Path('/tmp/tp-image-status'));a=p.parse_args()
r=Path(__file__).resolve().parents[1];a.out.mkdir(parents=True,exist_ok=True)
run=subprocess.run(['node','scripts/test-image-status.mjs'],cwd=r,capture_output=True,text=True)
assert run.returncode==0,run.stderr
checks=[]
def check(name,ok):
    checks.append(dict(name=name,pass_=bool(ok)));print(('PASS ' if ok else 'FAIL ')+name,flush=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=a.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    ctx=browser.new_context(viewport={'width':850,'height':800},locale='th-TH')
    ctx.route('**/*',lambda route:route.abort())
    page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content('''<!doctype html><meta charset="utf-8"><style>body{margin:24px;background:#ddd;font:16px sans-serif}img{display:block;width:360px;height:560px;background:#fff}</style><img id="a" alt="Image A">''')
    page.evaluate('''()=>{window.__TP={normUrl:s=>String(s||''),imageIdentity:s=>String(s||''),getBestImgUrl:img=>img.currentSrc||img.src,truncate:s=>String(s||'').slice(0,100),log:{debug(){},info(){},warn(){}},isMangaDexHost:()=>false};window.chrome={i18n:{getUILanguage:()=> 'th'},runtime:{lastError:null}};document.getElementById('a').src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="560"><rect width="360" height="560" fill="white"/></svg>');}''')
    for f in ['src/content/image-finder.js','src/content/target-key.js','src/content/image-status.js']:
        page.add_script_tag(content=(r/f).read_text())
    page.evaluate('''()=>{window.img=document.getElementById('a');window.gen=__TP.generationFor(img);}''')

    # Batch progress must reuse the original TextPhantom toast; details expand inside that same box.
    page.add_script_tag(content=(r/'src/content/dom-utils.js').read_text())
    page.add_script_tag(content=(r/'src/content/progress-panel.js').read_text())
    page.evaluate("()=>{__TP.showToast('TextPhantom: collecting images…',60000);window.toastBefore=document.querySelector('#tp-toast');}")
    now=page.evaluate('Date.now()')
    batch={"id":"b1","total":2,"active":1,"terminal":1,"stage":"AI processing","stats":{"finished":1,"total":2,"error":0,"skipped":0,"scanSkipped":0},"items":[
      {"label":"Image 1","terminal":False,"progress":{"overall":{"state":"running","startedAt":now-2100,"detail":"Processing"},"lens":{"state":"done","startedAt":now-1900,"finishedAt":now-1500,"detail":"Lens complete"},"grouping":{"state":"done","startedAt":now-1450,"finishedAt":now-1200,"detail":"Grouping complete"},"ai":{"state":"running","startedAt":now-1000,"queueWaitMs":240,"detail":"Request sent · waiting response","function":"waiting_response","pageCount":2,"unitCount":19,"queuedPageCount":0,"turn":2,"conversation":True},"insert":{"state":"idle"},"result":{"state":"pending","detail":""}}},
      {"label":"Image 2","terminal":True,"progress":{"overall":{"state":"done","startedAt":now-3000,"finishedAt":now-500,"detail":"Complete"},"lens":{"state":"done","startedAt":now-2900,"finishedAt":now-2500},"grouping":{"state":"skipped","finishedAt":now-2400,"detail":"Not needed"},"ai":{"state":"done","startedAt":now-2300,"finishedAt":now-800},"insert":{"state":"done","startedAt":now-750,"finishedAt":now-500},"result":{"state":"done","detail":"Done"}}}
    ]}
    page.evaluate('(b)=>__TP.updateBatchProgress(b)',batch);page.wait_for_timeout(140)
    check('progress reuses exactly the original TextPhantom toast box',page.evaluate("document.querySelectorAll('#tp-toast').length===1&&document.querySelector('#tp-toast')===window.toastBefore&&document.querySelectorAll('#tp-progress-board').length===0"))
    check('collapsed toast hides completed/inactive lanes and keeps only live function status',page.evaluate("(()=>{const t=document.querySelector('#tp-toast > div:first-child > span').textContent;return t.startsWith('TextPhantom: 1/2')&&t.includes('AI waiting response 2p/19u')&&!t.includes('Lens')&&!t.includes('Group')&&!t.includes('Insert')&&!t.includes('Result')&&!t.includes('|');})()"))
    check('detail table is hidden by default and plus toggle is inside the same toast',page.evaluate("(()=>{const b=document.querySelector('#tp-toast');const btn=b.querySelector('button');return btn.textContent==='+'&&btn.getAttribute('aria-expanded')==='false'&&b.querySelector(':scope > div:nth-child(2)').style.display==='none';})()"))
    check('collapsed status uses function-level wording and no image-number ranges',page.evaluate("(()=>{const t=document.querySelector('#tp-toast > div:first-child > span').textContent;return t.includes('waiting response')&&!t.includes('#1')&&!t.includes('queue');})()"))
    total_before=page.evaluate("document.querySelector('#tp-toast > div:first-child > span').textContent")
    page.wait_for_timeout(650)
    total_after=page.evaluate("document.querySelector('#tp-toast > div:first-child > span').textContent")
    check('collapsed RUN timer advances without a new background event',total_before!=total_after)
    page.evaluate("document.querySelector('#tp-toast button').click()")
    page.wait_for_timeout(30)
    check('plus expands per-image detail inside the same toast and becomes minus',page.evaluate("(()=>{const b=document.querySelector('#tp-toast');const btn=b.querySelector('button');return btn.textContent==='−'&&btn.getAttribute('aria-expanded')==='true'&&b.querySelector(':scope > div:nth-child(2)').style.display==='block';})()"))
    check('toggle glyph is centered and toggle stays at the far right',page.evaluate("(()=>{const b=document.querySelector('#tp-toast'),m=b.firstElementChild,btn=b.querySelector('button'),s=getComputedStyle(btn),mr=m.getBoundingClientRect(),br=btn.getBoundingClientRect();return (s.display==='flex'||s.display==='inline-flex')&&s.alignItems==='center'&&s.justifyContent==='center'&&Math.abs((mr.right-10)-br.right)<3;})()"))
    check('expanded toast preserves AI function detail and queue wait',page.evaluate("document.querySelector('#tp-toast').textContent.includes('Request sent · waiting response')&&document.querySelector('#tp-toast').textContent.includes('queue 240ms')"))
    before=page.evaluate("document.querySelector('[data-lane=ai]').textContent")
    page.wait_for_timeout(650)
    after=page.evaluate("document.querySelector('[data-lane=ai]').textContent")
    check('expanded RUN timer advances without a new background event',before!=after)
    page.keyboard.press('Escape')
    check('Escape collapses details without hiding the live status toast',page.evaluate("document.querySelector('#tp-toast button').textContent==='+'&&document.querySelector('#tp-toast > div:nth-child(2)').style.display==='none'&&document.querySelector('#tp-toast').style.display!=='none'"))
    page.evaluate("document.querySelector('#tp-toast button').click()")
    page.evaluate("document.getElementById('a').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))")
    check('clicking the page outside the toast collapses details automatically',page.evaluate("document.querySelector('#tp-toast button').textContent==='+'&&document.querySelector('#tp-toast > div:nth-child(2)').style.display==='none'"))
    page.evaluate("document.querySelector('#tp-toast button').click()")
    page.evaluate("document.querySelector('#tp-toast button').click()")
    check('minus collapses details back into the original one-line toast',page.evaluate("document.querySelector('#tp-toast button').textContent==='+'&&document.querySelector('#tp-toast > div:nth-child(2)').style.display==='none'"))

    # Even legacy/current progress packets must be harmless and create no DOM.
    packet={"original":page.evaluate('img.src'),"generation":page.evaluate('gen'),"status":{"batchId":"b1","sequence":1,"startedAt":1,"phase":"repair_applying","total":12,"accepted":11,"applied":10,"pending":2}}
    result=page.evaluate('p=>__TP.updateImageStatus(p)',packet)
    page.wait_for_timeout(30)
    check('repair/progress packet is acknowledged but progress UI is disabled',result.get('disabled') is True and page.evaluate("document.querySelectorAll('.tp-image-status').length===0"))
    check('repair progress never creates an image error badge',page.evaluate("document.querySelectorAll('[data-tp-image-error]').length===0"))
    # Only an actual image-specific terminal error should appear.
    page.evaluate('''()=>__TP.markImageError(img.src,{userMessage:'Lens OCR failed',code:'LENS_FAILED'},gen)''')
    page.wait_for_timeout(30)
    check('actual image error creates exactly one warning badge',page.evaluate("document.querySelectorAll('[data-tp-image-error]').length===1"))
    check('actual image error outlines only that image',page.evaluate("img.style.outline.includes('red')"))
    page.screenshot(path=str(a.out/'error-only.png'))
    page.evaluate("()=>{img.style.width='260px';window.scrollTo(0,80);__TP.repositionImageError?.(img)}");page.wait_for_timeout(50)
    check('error badge tracks image without progress-badge offset',page.evaluate('''()=>{const i=img.getBoundingClientRect(),e=document.querySelector('[data-tp-image-error]').getBoundingClientRect();return Math.abs((i.left+4)-e.left)<2&&Math.abs((i.top+4)-e.top)<2;}'''))
    page.evaluate("()=>document.querySelector('[data-tp-image-error]').click()")
    check('user can dismiss the image error badge',page.evaluate("document.querySelectorAll('[data-tp-image-error]').length===0&&!img.style.outline.includes('red')"))
    # Old leftover DOM from a prior build is removed by the disabled module hook.
    page.evaluate("()=>{const n=document.createElement('div');n.className='tp-image-status';document.body.appendChild(n);__TP.clearImageStatuses();}")
    check('legacy progress badges are removed',page.evaluate("document.querySelectorAll('.tp-image-status').length===0"))
    check('no uncaught browser errors',not errors)
    version=browser.version;browser.close()
report=dict(scope='Linux Chromium DOM; single batched per-image progress board + error-only image badge; network blocked',browser=version,checks=checks,passed=sum(c['pass_'] for c in checks),failed=sum(not c['pass_'] for c in checks))
(a.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if report['failed'] else 0)
