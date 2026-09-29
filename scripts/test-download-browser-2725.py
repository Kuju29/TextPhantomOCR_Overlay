"""Real Chromium DOM, canvas and browser downloads. No AI, erasing or API.
Pixel fixtures are generated here; no user source art or credentials are embedded.
"""
from pathlib import Path
import argparse,json,base64,io,zipfile
from PIL import Image
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=Path('/tmp/tp-download-2725'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[1]
def img(color,fmt='PNG'):
 b=io.BytesIO();Image.new('RGB',(400,500),color).save(b,fmt);return 'data:image/'+('jpeg' if fmt=='JPEG' else 'png')+';base64,'+base64.b64encode(b.getvalue()).decode()
checks=[]
def ck(name,value):
 checks.append({'name':name,'passed':bool(value)})
 assert value,name
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 context=browser.new_context(accept_downloads=True,viewport={'width':1280,'height':900})
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 # No actual network, all external page image routes deterministically mocked.
 page.route('https://fixture.test/**',lambda r:r.fulfill(status=200,content_type='text/html',body='<!doctype html><title>Test chapter / 12</title>'))
 page.set_content('<!doctype html><title>Test chapter / 12</title><body></body>')
 fixture={'original':img('#229944'),'clean':img('white'),'translated':img('#cc3344','JPEG')}
 page.evaluate('''f=>{
 const listeners=[];const storage={downloadImagesEnabled:false};window.sent=[];window.__TP={pageInstanceId:'fixture-instance',bail:false};
 window.chrome={runtime:{id:'fixture',lastError:null,sendMessage(m,cb){window.sent.push(m);cb?.({ok:false,error:'blocked in test'});}},storage:{local:{get(k,cb){cb({...storage});},set(v,cb){Object.assign(storage,v);cb?.();listeners.forEach(f=>f(Object.fromEntries(Object.entries(v).map(([k,newValue])=>[k,{newValue}])),'local'));}},onChanged:{addListener(f){listeners.push(f);}}}};
 window.setEnabled=v=>listeners.forEach(f=>f({downloadImagesEnabled:{newValue:v}},'local'));
 document.body.style.cssText='background:#eceef2;margin:0;font:16px system-ui';
 const style=document.createElement('style');style.textContent='.tp-line{position:absolute;left:20%;top:20%;width:60%;height:15%;font-size:calc(var(--tp-font-scale,1) * 24px);font-family:Arial;color:#101010;line-height:30px}.tp-ol-scope{position:relative;width:400px;height:500px;--tp-font-scale:1}.tp-ol-root{position:absolute;inset:0}.tp-ol-clean-img{position:absolute;inset:0;width:400px;height:500px}';document.head.append(style);
 const records=[];
 for(const n of [3,1,2]){
  const owner=document.createElement('article');owner.dataset.page=String(n);owner.style.cssText='width:400px;height:500px;position:relative;margin:20px auto';
  const image=new Image();image.src=f.original;image.width=400;image.height=500;owner.append(image);document.body.append(owner);
  if(n===1){
   const host=document.createElement('div');host.className='tp-ol-root';const clean=new Image();clean.className='tp-ol-clean-img';clean.src=f.clean;
   const scope=document.createElement('div');scope.className='tp-ol-scope';const line=document.createElement('div');line.className='tp-line';line.textContent='Translated text 100%';line.style.cssText='left:20%;top:20%;width:60%;height:15%';
   const hidden=document.createElement('div');hidden.style.display='none';const srcLine=line.cloneNode(true);srcLine.textContent='HIDDEN OCR SOURCE';hidden.append(srcLine);scope.append(line,hidden);host.append(clean,scope);owner.append(host);records.push({img:image,root:host,scope,clean,kind:'html'});
  }
  if(n===2){image.dataset.tpOriginal=f.original;image.dataset.tpReplaceTracked='1';image.src=f.translated;}
 }
 window.__TP.overlayMount={downloadSnapshot:()=>records};
 window.fixture=f;
}''',fixture)
 for f in ['inventory.js','preferences.js','render.js','io.js','zip.js','job.js','panel-style.js','panel.js']:page.add_script_tag(content=(root/'src/content/download'/f).read_text())
 page.wait_for_function('Array.from(document.images).every(i=>i.complete)')
 ck('opt-in initially absent',page.locator('#tp-download-control').count()==0)
 page.evaluate('setEnabled(true)');page.locator('#tp-download-control .fab').click()
 ck('42px compact toggle',round(page.locator('#tp-download-control .fab').bounding_box()['width'])==42)
 ck('312px panel',round(page.locator('#tp-download-control .download-panel').bounding_box()['width'])==312)
 ck('initial list collapsed',page.locator('#tp-download-control details').get_attribute('open') is None)
 data=page.evaluate('''()=>__TP.downloads.scan().map(r=>({n:r.number,available:r.available,original:r.original,raster:r.rasterUrl,text:r.text}))''')
 ck('logical order preserved',[r['n'] for r in data]==[1,2,3]);ck('translated 2, clean 1, original 3',sum(r['available']['translated'] for r in data)==2 and sum(r['available']['clean'] for r in data)==1 and sum(r['available']['original'] for r in data)==3)
 ck('direct replacement retains true original',data[1]['original']==fixture['original'] and data[1]['raster']==fixture['translated'])
 ck('hidden OCR ancestor excluded',page.evaluate('__TP.downloads.visibleLines(__TP.downloads.scan()[0].scope).length')==1)
 def blob(kind,index=0):
  return page.evaluate('''async ([kind,index])=>{const r=__TP.downloads.scan()[index];const out=await __TP.downloads.render(r,kind,new AbortController().signal);const a=await out.blob.arrayBuffer();return {ext:out.ext,data:btoa(String.fromCharCode(...new Uint8Array(a)))}}''',[kind,index])
 clean=blob('clean');ck('clean bitmap byte exact',clean['data']==fixture['clean'].split(',')[1])
 original=blob('original',1);ck('original never translated bytes',original['data']==fixture['original'].split(',')[1])
 raster=blob('translated',1);ck('raster original JPEG format retained',raster['ext']=='jpg' and raster['data']==fixture['translated'].split(',')[1])
 flat=blob('translated');image=Image.open(io.BytesIO(base64.b64decode(flat['data'])));image.save(a.out/'translated-100.png')
 ck('text flattened at native 400x500',image.size==(400,500) and image.getpixel((0,0))[:3]==(255,255,255))
 ck('text pixels exist',sum(1 for p in image.getdata() if p[0]<100 and p[1]<100 and p[2]<100)>100)
 page.evaluate("__TP.downloads.scan()[0].scope.style.setProperty('--tp-font-scale','1.5')")
 large=blob('translated');largeImage=Image.open(io.BytesIO(base64.b64decode(large['data'])));largeImage.save(a.out/'translated-150.png')
 ck('live font scale changes exported pixels',flat['data']!=large['data'])
 ck('computed font 36px at150%',page.evaluate('__TP.downloads.captureLines(__TP.downloads.scan()[0].scope)[0].computed.fontSize')=='36px')
 page.locator('#tp-download-control details summary').click()
 with page.expect_download() as dl:page.locator('#tp-download-control .asset-row button').first.click()
 download=dl.value;download.save_as(a.out/download.suggested_filename)
 ck('browser receives real PNG file',download.suggested_filename=='Test chapter 12 - 001 - translated.png' and (a.out/download.suggested_filename).stat().st_size>100)
 page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent==='Sent to browser'")
 ck('individual download handoff shown truthfully','handed to your browser' in page.locator('#tp-download-control .job-detail').inner_text())
 # Download all now emits one ZIP; image payload/order/default formats stay unchanged.
 downloads=[];received=[];page.on('download',lambda d:(downloads.append(d.suggested_filename),received.append(d)))
 page.locator('#tp-download-control .download-all').click();page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent==='Sent to browser'")
 for _ in range(100):
  if len(downloads)>=1:break
  page.wait_for_timeout(50)
 ck('all translated emits one ZIP only',downloads==['Test chapter 12 - translated.zip'])
 received[-1].save_as(a.out/'translated.zip')
 with zipfile.ZipFile(a.out/'translated.zip') as z:
  ck('ZIP has both images in logical order, actual default extensions',z.namelist()==['Test chapter 12 - 001 - translated.png','Test chapter 12 - 002 - translated.jpg'] and z.testzip() is None)
 # Cleanup toggles, no translation API or erasing messages during reads/saves.
 ck('zero AI/OCR/erase or API messages',page.evaluate('sent.length')==0)
 # Recycled source must refuse; no silent redraw/re-OCR.
 stale=page.evaluate('''async()=>{const r=__TP.downloads.scan()[0];r.img.dataset.tpOriginal='https://fixture.test/changed';try{await __TP.downloads.render(r,'translated',new AbortController().signal);return false;}catch(e){return /changed|unmounted/.test(e.message);}finally{delete r.img.dataset.tpOriginal;}}''')
 ck('recycled identity rejected',stale)
 ck('cancel before read makes no file',page.evaluate('''async()=>{const c=new AbortController();c.abort();try{await __TP.downloads.render(__TP.downloads.scan()[0],'translated',c.signal);return false;}catch(e){return e.name==='AbortError';}}'''))
 # Missing clean layer disables only that category, original and translated still work.
 page.evaluate("__TP.downloads.scan()[0].clean.style.display='none'");page.locator('#tp-download-control .refresh').click()
 ck('no new erase when clean missing',page.locator('#tp-download-control [data-kind=clean]').is_disabled())
 # Simulated runtime read failure: UI must report failure rather than count an original as translated.
 page.evaluate("()=>{window.oldRead=__TP.downloads.render;__TP.downloads.render=async()=>{throw Error('fixture image unavailable');};}")
 page.locator('#tp-download-control .download-all').click();page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent==='Finished with unavailable images'")
 ck('failed translated not silently replaced with original','0 / 2' in page.locator('#tp-download-control .job-detail').inner_text() and len(downloads)==1)
 page.evaluate('()=>{__TP.downloads.render=oldRead;}')
 page.screenshot(path=str(a.out/'download-panel.png'),full_page=False)
 page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(a.out/'download-mobile.png'))
 box=page.locator('#tp-download-control .download-panel').bounding_box();ck('mobile panel within viewport',box['x']>=0 and box['x']+box['width']<=390 and box['y']>=0)
 # Compare new captured-style renderer with the user's v1.2 drawing algorithm.
 page.add_script_tag(content=(root/'scripts/fixtures/export-v12-renderer.js').read_text())
 parity=page.evaluate("""()=>{
 const scope=__TP.downloads.scan()[0].scope,line=scope.querySelector('.tp-line');const result=[];
 for(const text of ['Words with spaces wrap here','เราไปต่อกันเถอะ ยังมีเรื่องรออยู่','日本語縦書き'])for(const scale of [.5,1,1.5,2])for(const vertical of [false,true])for(const rotate of [0,17]){
  line.textContent=text;scope.style.setProperty('--tp-font-scale',String(scale));line.classList.toggle('vert',vertical);line.style.transform=`rotate(${rotate}deg)`;
  const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=400;a.height=b.height=500;
  exportV12Reference(a.getContext('2d'),line,400,500);
  __TP.downloads.drawOverlayLine(b.getContext('2d'),__TP.downloads.captureLines(scope)[0],400,500);
  result.push({text,scale,vertical,rotate,match:a.toDataURL()===b.toDataURL()});
 }
 line.classList.remove('vert');line.style.transform='none';line.textContent='Translated text';scope.style.setProperty('--tp-font-scale','1');return result;
}""")
 ck('48 exact v1.2 canvas pixel parity cases',len(parity)==48 and all(r['match'] for r in parity))
 (a.out/'renderer-reference-parity.json').write_text(json.dumps(parity,ensure_ascii=False,indent=2))
 # A live newer raster must not expose a previous text background as clean.
 ck('raster supersedes old text clean layer',page.evaluate("""()=>{const before=__TP.downloadMangaDexSnapshot;const r=__TP.overlayMount.downloadSnapshot()[0];const raster=document.querySelector('[data-page="2"] img');__TP.downloadMangaDexSnapshot=()=>[{img:r.img,raster,kind:'raster'}];const x=__TP.downloads.scan()[0];__TP.downloadMangaDexSnapshot=before;return x.available.translated&&!x.available.clean&&!x.text;}"""))
 # Known reader canvas targets are real existing pixels, not OCR/image rebuilds.
 ck('known canvas original exports without processing',page.evaluate("""async()=>{
 const c=document.createElement('canvas');c.width=40;c.height=50;c.dataset.page='99';c.getContext('2d').fillRect(0,0,40,50);document.body.append(c);
 const before=__TP.downloadMangaDexSnapshot;__TP.downloadMangaDexSnapshot=()=>[{img:c,kind:'html'}];
 const r=__TP.downloads.scan().find(r=>r.img===c);const x=await __TP.downloads.render(r,'original',new AbortController().signal);
 const good=x.ext==='png'&&x.blob.size>0;
 c.toBlob=()=>{throw new DOMException('tainted','SecurityError')};let blocked=false;try{await __TP.downloads.render(r,'original',new AbortController().signal)}catch{blocked=true}
 c.remove();__TP.downloadMangaDexSnapshot=before;return good&&blocked;
}"""))
 # Cancel a genuinely in-progress async export, and close without cancellation.
 page.locator('#tp-download-control [data-kind=original]').click()
 page.evaluate("""()=>{window.nativeRender=__TP.downloads.render;__TP.downloads.render=(_r,_k,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}));}""")
 before=len(downloads);page.locator('#tp-download-control .download-all').click()
 page.locator('#tp-download-control .panel-heading button').click()
 ck('minimize keeps export active',page.locator('#tp-download-control .fab').get_attribute('aria-expanded')=='false')
 page.locator('#tp-download-control .fab').click();page.locator('#tp-download-control .job-top button').click()
 page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent==='Download cancelled'")
 ck('cancel interrupts only export no file',len(downloads)==before and page.evaluate('sent.length')==0)
 page.evaluate('()=>{__TP.downloads.render=nativeRender;}')
 # Render the normal completed UI, not a debug/error mock, for delivery preview.
 page.set_viewport_size({'width':1280,'height':900})
 page.evaluate("__TP.overlayMount.downloadSnapshot()[0].clean.style.display='block'")
 page.locator('#tp-download-control .refresh').click();page.locator('#tp-download-control [data-kind=translated]').click()
 page.screenshot(path=str(a.out/'download-panel.png'),full_page=False)
 page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(a.out/'download-mobile.png'))
 page.evaluate('setEnabled(false)');ck('disable removes control',page.locator('#tp-download-control').count()==0)
 # Real toast + content message controller: a live progress toast suppressing
 # an error must not produce a positive error-display acknowledgement.
 page.add_script_tag(content=(root/'src/content/dom-utils.js').read_text())
 page.add_script_tag(content=(root/'src/content/overlay/message-controller.js').read_text())
 page.evaluate("()=>{__TP.log={info(){},warn(){}};__TP.emitViewerEvent=()=>{};__TP.markImageError=()=>false;}")
 ack=page.evaluate("async()=>await __TP.applyInsertMessage({type:'IMAGE_ERROR',original:'test',error:{schema:'tp.error/1',code:'TEST',userMessage:'Test failed'}})")
 ck('error toast acknowledgement requires actual DOM text',ack.get('toastDisplayed') is True)
 page.evaluate("()=>__TP.showToast('Other live batch',0,{batchId:'other',startedAt:Date.now(),active:true})")
 ack=page.evaluate("async()=>await __TP.applyInsertMessage({type:'IMAGE_ERROR',original:'test',error:{schema:'tp.error/1',code:'TEST2',userMessage:'Second failure'}})")
 ck('suppressed error toast is not acknowledged',ack.get('toastDisplayed') is False)
 ck('no uncaught browser errors',not errors)
 report={'scope':'Production export JS in real Chromium; generated image fixtures; actual download events; no live sites or AI','checks':checks,'browserErrors':errors}
 (a.out/'download-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 browser.close()
print('PASS',len(checks),'browser/download checks')
