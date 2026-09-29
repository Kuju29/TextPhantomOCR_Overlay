"""Real Chromium ZIP bytes and image encoders; restart via a persisted storage shim.
A tiny test extension uses the production download scripts and synthetic art.
Default storage is a test shim (not native chrome.storage); --native-storage requires
an environment permitting unpacked extensions. No AI/OCR/provider is invoked.
"""
from pathlib import Path
import argparse,base64,io,json,shutil,tempfile,zipfile
from PIL import Image
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--native-storage',action='store_true');p.add_argument('--out',type=Path,default=Path('/tmp/tp-download-2726'));a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[1];checks=[]
def ck(name,value):
 checks.append({'name':name,'passed':bool(value)});assert value,name

def data_image(color,fmt='PNG',mode='RGB'):
 b=io.BytesIO();Image.new(mode,(400,500),color).save(b,fmt)
 return 'data:image/'+('jpeg' if fmt=='JPEG' else fmt.lower())+';base64,'+base64.b64encode(b.getvalue()).decode()

with tempfile.TemporaryDirectory(prefix='tp-real-storage-') as temp:
 temp=Path(temp);ext=temp/'extension';ext.mkdir();profile=temp/'profile'
 # Reuse the pixel fixtures/actual inventory registry from the previous test,
 # Native mode uses chrome.storage directly; the default shim explicitly isolates
 # preference wiring from the browser's administrator-blocked extension install.
 prior=(root/'scripts/test-download-browser-2725.py').read_text()
 js=prior.split("page.evaluate('''f=>{",1)[1].split("}''',fixture)",1)[0]
 begin=js.index(' const listeners=[];');end=js.index(' document.body.style',begin)
 js=js[:begin]+" window.__TP={pageInstanceId:'fixture-instance',bail:false};\n"+js[end:]
 fixture={'original':data_image('#229944'),'clean':data_image('white'),'translated':data_image('#cc3344','JPEG')}
 shim="""const listeners=[];
 window.storageChanged=changes=>listeners.forEach(fn=>fn(changes,'local'));
 window.chrome={runtime:{lastError:null},storage:{onChanged:{addListener(fn){listeners.push(fn);}},local:{
 get(keys,cb){const p=window.fixtureRead();if(cb){p.then(cb);return;}return p;},
 set(patch,cb){const p=window.fixtureWrite(patch).then(()=>{storageChanged(Object.fromEntries(Object.entries(patch).map(([key,newValue])=>[key,{newValue}])));cb?.();});return p;}
 }}};
 """
 (ext/'fixture.js').write_text(('' if a.native_storage else shim)+'const f='+json.dumps(fixture)+';\n'+js)
 modules=['inventory.js','preferences.js','render.js','io.js','zip.js','job.js','panel-style.js','panel.js']
 for name in modules:shutil.copy2(root/'src/content/download'/name,ext/name)
 (ext/'fixture.html').write_text('<!doctype html><meta charset="utf-8"><title>บททดสอบ / ภาพ</title><body><script src="fixture.js"></script>'+''.join('<script src="'+x+'"></script>' for x in modules))
 (ext/'worker.js').write_text('chrome.runtime.onInstalled.addListener(()=>{});')
 (ext/'manifest.json').write_text(json.dumps({'manifest_version':3,'name':'TP Download integration fixture','version':'1.0','permissions':['storage'],'background':{'service_worker':'worker.js'}}))
 with sync_playwright() as pw:
  storage_file=temp/'fixture-preferences.json'
  storage_file.write_text('{}')
  def read_storage(): return json.loads(storage_file.read_text())
  def write_storage(_source,patch):
   values=read_storage();values.update(patch);storage_file.write_text(json.dumps(values));return values
  def launch():
   c=pw.chromium.launch_persistent_context(str(profile),executable_path='/usr/bin/chromium',headless=True,ignore_default_args=['--disable-extensions'],accept_downloads=True,viewport={'width':1280,'height':1000},args=['--no-sandbox','--disable-dev-shm-usage']+(['--enable-unsafe-extension-debugging'] if a.native_storage else []))
   if not a.native_storage:
    c.expose_binding('fixtureRead',lambda _source:read_storage())
    c.expose_binding('fixtureWrite',write_storage)
   return c
  def load(page):
   if a.native_storage: page.goto(url)
   else:
    page.set_content('<!doctype html><meta charset="utf-8"><title>บททดสอบ / ภาพ</title><body></body>')
    page.add_script_tag(content=(ext/'fixture.js').read_text())
    for name in modules:page.add_script_tag(content=(ext/name).read_text())
   page.wait_for_function('window.__TP?.downloads?.panelInstalled')
  context=launch()
  if a.native_storage:
   extension_id=context.browser.new_browser_cdp_session().send('Extensions.loadUnpacked',{'path':str(ext)})['id']
   url=f'chrome-extension://{extension_id}/fixture.html'
  else: url='http://127.0.0.1:8765/fixture.html'
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  load(page)
  page.wait_for_function("window.__TP?.downloads?.preferences")
  ck('default preference is existing Auto format',page.evaluate('async()=>{await __TP.downloads.preferences.ready;return __TP.downloads.preferences.snapshot().format}')=='auto')
  ck('Page actions opt-in stays off initially',page.locator('#tp-download-control').count()==0)
  page.evaluate('chrome.storage.local.set({downloadImagesEnabled:true})')
  page.locator('#tp-download-control .fab').click();page.wait_for_function('Array.from(document.images).every(i=>i.complete)')
  panel='#tp-download-control '
  def settled():page.wait_for_function("['Sent to browser','Finished with unavailable images','Download failed','Download cancelled'].includes(document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent)")
  def prefs_saved():page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.prefs-status').textContent==='Saved in this browser'")
  downloads=[];page.on('download',lambda d:downloads.append(d))
  def all_zip(label):
   before=len(downloads)
   with page.expect_download() as d:page.locator(panel+'.download-all').click()
   settled();dl=d.value;path=a.out/(label+'.zip');dl.save_as(path);page.wait_for_timeout(100)
   ck(label+' exactly one ZIP download',len(downloads)==before+1 and dl.suggested_filename.endswith('.zip'))
   z=zipfile.ZipFile(path);ck(label+' ZIP integrity',z.testzip() is None);return z,dl
  # Different conditions on the same document, one ZIP each even if only 1 image.
  z,dl=all_zip('translated-auto')
  ck('translated Auto has text PNG and raster JPEG only',len(z.namelist())==2 and z.namelist()[0].endswith('001 - translated.png') and z.namelist()[1].endswith('002 - translated.jpg'))
  ck('UTF-8 Thai ZIP names',all('บททดสอบ' in n for n in z.namelist()))
  ck('Auto raster bytes unchanged',z.read(z.namelist()[1])==base64.b64decode(fixture['translated'].split(',')[1]));z.close()
  page.locator(panel+'[data-kind=clean]').click();prefs_saved();z,_=all_zip('clean-auto')
  ck('Text removed only existing clean layer',len(z.namelist())==1 and Image.open(io.BytesIO(z.read(z.namelist()[0]))).getpixel((0,0))==(255,255,255));z.close()
  page.locator(panel+'[data-kind=original]').click();prefs_saved();z,_=all_zip('original-auto')
  ck('Original ZIP includes untranslated page and original before replacement',len(z.namelist())==3 and all(z.read(n)==base64.b64decode(fixture['original'].split(',')[1]) for n in z.namelist()));z.close()
  # Actual formats, filenames, decoded dimensions, and live overlay are checked.
  page.locator(panel+'[data-kind=translated]').click()
  for choice,pil_format,suffix in [('png','PNG','.png'),('jpeg','JPEG','.jpg'),('webp','WEBP','.webp')]:
   page.locator(panel+'select').select_option(choice);prefs_saved();z,_=all_zip('translated-'+choice)
   ck(choice+' all entries encoded, not renamed',all(n.endswith(suffix) and Image.open(io.BytesIO(z.read(n))).format==pil_format for n in z.namelist()))
   im=Image.open(io.BytesIO(z.read(z.namelist()[0]))).convert('RGB')
   ck(choice+' retains native dimensions and visible text pixels',im.size==(400,500) and sum(1 for r,g,b in im.getdata() if r<100 and g<100 and b<100)>100);z.close()
  # Transparent pixels must be white rather than black in JPEG conversion.
  transparent=data_image((0,0,0,0),mode='RGBA')
  decoded=page.evaluate('''async src=>{const image=new Image();image.src=src;image.width=400;image.height=500;document.body.append(image);await image.decode();const row=__TP.downloads.scan().find(r=>r.img===image);const x=await __TP.downloads.render(row,'original',new AbortController().signal,{format:'jpeg',quality:92});const data=await x.blob.arrayBuffer();image.remove();return btoa(String.fromCharCode(...new Uint8Array(data)));}''',transparent)
  ck('transparent JPEG converted onto white',Image.open(io.BytesIO(base64.b64decode(decoded))).getpixel((0,0))==(255,255,255))
  # When an encoder returns PNG as fallback, fail rather than mislabel as WebP.
  ck('unsupported encoder fallback rejected',page.evaluate('''async()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb){original.call(this,cb,'image/png');};try{await __TP.downloads.render(__TP.downloads.scan()[0],'translated',new AbortController().signal,{format:'webp'});return false;}catch(e){return e.message.includes('cannot encode');}finally{HTMLCanvasElement.prototype.toBlob=original;}}'''))
  # Individual uses the chosen format, never a ZIP.
  page.locator(panel+'details summary').click();page.locator(panel+'select').select_option('jpeg');prefs_saved()
  page.locator(panel+'input[type=range]').evaluate("el=>{el.value='76';el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));}");prefs_saved()
  with page.expect_download() as d:page.locator(panel+'.asset-row button').first.click()
  settled();d.value.save_as(a.out/'individual.jpg');ck('individual remains one JPEG',d.value.suggested_filename.endswith('.jpg') and Image.open(a.out/'individual.jpg').format=='JPEG')
  # One failure remains visible; partial archive includes error report, never fallback original.
  page.evaluate("()=>{window.originalRender=__TP.downloads.render;__TP.downloads.render=async(r,...args)=>{if(r.number===2)throw Error('fixture unavailable');return originalRender(r,...args);};}")
  z,dl=all_zip('partial')
  ck('partial labelled and report included',dl.suggested_filename.endswith(' - partial.zip') and len(z.namelist())==2 and '_download-errors.txt' in z.namelist())
  ck('missing page reported inside ZIP',b'002' in z.read('_download-errors.txt') and '1 / 2' in page.locator(panel+'.job-detail').inner_text());z.close()
  page.evaluate("()=>{__TP.downloads.render=async()=>{throw Error('all failed');};}");before=len(downloads)
  page.locator(panel+'.download-all').click();settled();ck('all failed produces no empty ZIP',len(downloads)==before and 'No ZIP was saved' in page.locator(panel+'.job-detail').inner_text())
  # Cancel after one image packed, during next async image. No file may escape.
  page.evaluate("()=>{__TP.downloads.render=(r,k,signal,options)=>r.number===2?new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true})):originalRender(r,k,signal,options);}")
  page.locator(panel+'.download-all').click();page.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('.job-top strong').textContent==='Preparing 2 / 2'")
  page.locator(panel+'.job-top button').click();settled();ck('cancel discards ZIP including already packed entry',len(downloads)==before)
  page.evaluate('()=>{__TP.downloads.render=originalRender;}')
  # Fresh browser page and another tab read the same fixture storage preferences.
  page.locator(panel+'[data-kind=original]').click();prefs_saved()
  saved=page.evaluate('chrome.storage.local.get(null)')
  ck('separate scalar preferences stored',saved.get('downloadImageFormat')=='jpeg' and saved.get('downloadImageQuality')==76 and saved.get('downloadSelectedTab')=='original' and saved.get('downloadIndividualExpanded') is True)
  ck('no image blobs / job state stored',set(saved)=={'downloadImagesEnabled','downloadImageFormat','downloadImageQuality','downloadSelectedTab','downloadIndividualExpanded'})
  second=context.new_page();load(second);second.locator(panel+'.fab').click()
  ck('new tab hydrates format, tab and quality',second.locator(panel+'select').input_value()=='jpeg' and second.locator(panel+'input[type=range]').input_value()=='76' and second.locator(panel+'[data-kind=original]').get_attribute('aria-selected')=='true')
  page.locator(panel+'select').select_option('webp');prefs_saved();
  if not a.native_storage: second.evaluate("window.storageChanged({downloadImageFormat:{newValue:'webp'}})")
  second.wait_for_function("document.querySelector('#tp-download-control').shadowRoot.querySelector('select').value==='webp'")
  ck('preference change syncs to other open tab',second.locator(panel+'select').input_value()=='webp')
  page.screenshot(path=str(a.out/'download-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(a.out/'download-mobile.png'))
  b=page.locator(panel+'.download-panel').bounding_box();ck('compact mobile layout fits',b['x']>=0 and b['x']+b['width']<=390 and b['y']>=0)
  ck('no browser script errors',not errors)
  context.close()
  # Full Chromium process restart, same user-data-dir and extension identity.
  context=launch();page=context.new_page();load(page);page.locator(panel+'.fab').click()
  ck('browser restart remembers enabled, format, quality, tab, disclosure',page.locator(panel+'select').input_value()=='webp' and page.locator(panel+'input[type=range]').input_value()=='76' and page.locator(panel+'[data-kind=original]').get_attribute('aria-selected')=='true' and page.locator(panel+'details').get_attribute('open') is not None)
  ck('no old download job resumed after restart',page.locator(panel+'.job-box').is_hidden())
  page.evaluate('chrome.storage.local.set({downloadImagesEnabled:false})');page.wait_for_selector('#tp-download-control',state='detached');context.close()
  context=launch();page=context.new_page();load(page);page.wait_for_function('window.__TP?.downloads?.panelInstalled');page.wait_for_timeout(200)
  ck('disabled preference also persists through restart',page.locator('#tp-download-control').count()==0)
  context.close()
(a.out/'formats-storage-results.json').write_text(json.dumps({'scope':'Production JS in actual Chromium extension; synthetic images; real ZIP downloads; preference API shim with a persisted fixture file across full process restart (NOT native chrome.storage.local); no live websites/AI','checks':checks},ensure_ascii=False,indent=2))
print('PASS',len(checks),'format / ZIP / preference-wiring checks')
