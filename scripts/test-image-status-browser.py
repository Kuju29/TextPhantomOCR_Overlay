"""Offline Chromium: progress status is disabled; image-specific errors remain."""
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
report=dict(scope='Linux Chromium DOM; per-image progress disabled, error-only badge path active; network blocked',browser=version,checks=checks,passed=sum(c['pass_'] for c in checks),failed=sum(not c['pass_'] for c in checks))
(a.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if report['failed'] else 0)
