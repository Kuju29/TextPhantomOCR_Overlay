"""Offline Chromium DOM/canvas integration. Requires Python playwright and Chromium.
No extension service worker, provider, Lens call, or user key is used. The real
checkpoint, renderer, eraser, target-generation and content message modules run.
Usage: python scripts/test-repair-browser.py --browser /usr/bin/chromium --out /tmp/tp-browser
"""
from pathlib import Path
import argparse, json, re, subprocess
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--project',type=Path,default=Path(__file__).resolve().parents[1])
parser.add_argument('--browser',default='/usr/bin/chromium')
parser.add_argument('--producer-replay',action='store_true',help='Use the real recorded Lens decoder, not hand-owned fixture masks; leave one unit unresolved after repair')
parser.add_argument('--out',type=Path,default=Path('/tmp/tp-repair-browser'))
args=parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
# No browser navigation/server: all source is loaded from this checkout into
# in-memory module blobs. This also works on network-disabled test machines.
module_cache={}
def module_url(page,name):
    if name in module_cache: return module_cache[name]
    path=(args.project/'src'/name).resolve()
    source=path.read_text()
    pattern=re.compile(r"(\b(?:from\s*|import\s*))([\"'])(\.[^\"']+)\2")
    def child(match):
        dep=(path.parent/match.group(3)).resolve().relative_to((args.project/'src').resolve()).as_posix()
        return match.group(1)+json.dumps(module_url(page,dep))
    source=pattern.sub(child,source)
    module_cache[name]=page.evaluate("source=>URL.createObjectURL(new Blob([source],{type:'text/javascript'}))",source)
    return module_cache[name]
NODE_FIXTURE=r'''import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
globalThis.crypto ||= webcrypto;
const root=pathToFileURL(process.argv[1]+'/');
const {makePageCheckpoint,buildPatchedResult,digestText}=await import(new URL('src/background/repair/page-checkpoint.js',root));
const {translationUnits,applyTranslations}=await import(new URL('src/shared/lens-document.js',root));
const {eraseBoxesForAiPartial}=await import(new URL('src/shared/erase-boxes.js',root));
const records=[];
if(process.argv[2]==='producer') {
 const {decodeLensResponse}=await import(new URL('src/shared/lens-decode.js',root));
 const f=JSON.parse(readFileSync(new URL('scripts/fixtures/lens-display-recorded.json',root),'utf8'));
 const d=decodeLensResponse(f.lens,{...f.image,targetLang:'th'}),doc=d.document;
 const raw={backgroundMode:'boxes',layout:{relayout_translated:false},lensDocument:doc,eraseBoxes:d.eraseBoxes,metadata:{image_id:'recorded'}};
 const units=translationUnits(doc),accepted=units.filter(u=>!['g0','g1'].includes(u.id)).map(u=>({id:u.id,text:'ผ่านแล้ว 0'}));
 const stamp={runId:'producer-run',pageId:'recorded',generationId:'recorded-generation'};
 const checkpoint=await makePageCheckpoint({payload:{metadata:raw.metadata,lang:'th'},result:raw,units,plan:{route:'direct-local',ai:{provider:'ollama',model:'fixture'}},ctx:{jobId:stamp.generationId},operationId:'initial'});
 checkpoint.accepted=accepted;
 const initialDoc=applyTranslations(doc,accepted).document,safe=eraseBoxesForAiPartial(initialDoc,raw.eraseBoxes);
 if(!safe.ok)throw new Error(safe.reason);
 const initial={...structuredClone(raw),lensDocument:initialDoc,eraseBoxes:safe.eraseBoxes,aiPartial:{missing:['g0','g1'],translated:accepted.length}};
 const u=checkpoint.units.find(x=>x.id==='g1');
 const patch=buildPatchedResult(checkpoint,[{id:'R1',pageId:stamp.pageId,unitId:u.id,sourceHash:u.sourceHash,generationId:stamp.generationId,translation:'ซ่อมแล้ว 0'}]);
 if(JSON.stringify(patch.missing)!=='["g0"]')throw new Error('must remain a partial repair');
 records.push({raw,stamp,initial,repaired:patch.result,revision:await digestText(JSON.stringify(patch.accepted)),producer:true});
} else for(let i=0;i<4;i++) {
 const paragraphs=[{id:'p0',sourceText:`HELLO ${i}`,items:[{text:`HELLO ${i}`,height:.1,rotation:0,baseline:[[.1,.2],[.45,.2]],valid_text:true}]},
 {id:'p1',sourceText:`WORLD ${i}`,items:[{text:`WORLD ${i}`,height:.1,rotation:0,baseline:[[.1,.7],[.6,.7]],valid_text:true}]}];
 const boxes=[{l:.09,t:.08,w:.4,h:.14,p:'p0'},{l:.09,t:.58,w:.55,h:.15,p:'p1'}];
 const groups=[];
 if(i%2) {
  paragraphs[1].items=[{text:`WORLD ${i}`,height:.07,rotation:90,baseline:[[.55,.5],[.55,.9]],valid_text:true}];
  paragraphs.push({id:'p2',sourceText:'GROUP',items:[{text:'GROUP',height:.07,rotation:90,baseline:[[.4,.5],[.4,.9]],valid_text:true}]});
  boxes[1]={l:.52,t:.49,w:.07,h:.42,p:'p1'};boxes.push({l:.37,t:.49,w:.07,h:.42,p:'p2'});
  groups.push({id:'vertical',paragraphIds:['p1','p2'],direction:'v',text:`WORLD ${i} GROUP`,boundsPx:[125,140,220,280]});
 }
 const doc={schema:'tp.lens-document/1',image:{width:360,height:300},languages:{source:'en',target:'th'},paragraphs,groups,uncoveredParagraphIds:[]};
 if(i%2) doc.canonicalOriginalTree={schema:'tp.canonical-original-tree/1',coverage:{complete:true},paragraphs:[
  {id:'single',text:`HELLO ${i}`,items:[],source:{contract:'tp.ai-source-members/1',rawParagraphIndices:[0],documentParagraphIds:['p0']}},
  {id:'group',text:`WORLD ${i} GROUP`,items:[],source:{contract:'tp.ai-source-members/1',rawParagraphIndices:[1,2],documentParagraphIds:['p1','p2']}}
 ]};
 const raw={backgroundMode:'boxes',layout:{relayout_translated:false},lensDocument:doc,eraseBoxes:{schema:'tp.erase-boxes/1',boxes},metadata:{image_id:`page${i}`}};
 const units=translationUnits(doc),accepted=[{id:units[0].id,text:`ผ่านแล้ว ${i}`}];
 const stamp={runId:'fixture-run',pageId:`page${i}`,generationId:`generation${i}`};
 const checkpoint=await makePageCheckpoint({payload:{metadata:raw.metadata,lang:'th'},result:raw,units,plan:{route:'direct-local',ai:{provider:'ollama',model:'fixture'}},ctx:{jobId:stamp.generationId},operationId:`initial${i}`});
 checkpoint.accepted=accepted;
 const initialDoc=applyTranslations(doc,accepted).document;
 const initial={...structuredClone(raw),lensDocument:initialDoc,eraseBoxes:eraseBoxesForAiPartial(initialDoc,raw.eraseBoxes).eraseBoxes,aiPartial:{missing:units.slice(1).map(x=>x.id),translated:1}};
 const repairs=units.slice(1).map((u,j)=>({id:`R${i}-${j}`,pageId:stamp.pageId,unitId:u.id,sourceHash:checkpoint.units.find(x=>x.id===u.id).sourceHash,generationId:stamp.generationId,translation:`ซ่อมแล้ว ${i}`}));
 const repaired=buildPatchedResult(checkpoint,repairs),revision=await digestText(JSON.stringify(repaired.accepted));
 if(i%2 && repaired.result.lensDocument.paragraphs[1].aiGroupParagraphIds?.length!==2) throw new Error('Fixture must contain one multi-paragraph translation unit');
 records.push({raw,stamp,initial,repaired:repaired.result,revision});
}
console.log(JSON.stringify(records));'''
records=json.loads(subprocess.check_output(['node','--input-type=module','-e',NODE_FIXTURE,str(args.project.resolve()),'producer' if args.producer_replay else 'manual'],text=True))
setup=r'''async () => {
 window.fixtureLogs={warnings:[],events:[],builds:0};
 window.chrome={runtime:{getURL:path=>window.moduleUrls[path]}};
 window.__TP={bail:false,log:{warn:(...x)=>fixtureLogs.warnings.push(x),debug(){},info(){}},traceNote:(...x)=>fixtureLogs.events.push(x),isMangaDexHost:()=>false,
 findTargetImage:src=>[...document.querySelectorAll('img.source')].find(img=>img.src===src),setTrace(){},clearImageError(){},
 markImageError:(...x)=>fixtureLogs.warnings.push(x)};
}'''
fixture=r'''async records => {
 const TP=window.__TP;
 const erase=TP.buildErasedBackground;
 TP.buildErasedBackground=async(...args)=>{fixtureLogs.builds++;return erase(...args);};
 window.fixtures=[];
 for(const [i,record] of records.entries()) {
  const {raw,stamp}=record;
  const {width:W,height:H}=record.producer?raw.lensDocument.image:{width:360,height:300};
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#000';for(const b of raw.eraseBoxes.boxes){
   if(!record.producer){ctx.fillRect((b.l+.01)*W,(b.t+.01)*H,(b.w-.02)*W,(b.h-.02)*H);continue;}
   ctx.save();ctx.translate((b.l+b.w/2)*W,(b.t+b.h/2)*H);ctx.rotate((b.r||0)*Math.PI/180);
   const bw=Math.max(1,b.w*W*.45),bh=Math.max(1,b.h*H*.45);ctx.fillRect(-bw/2,-bh/2,bw,bh);ctx.restore();
  }
  // Unique image identity, outside any erase/contrast sample region.
  ctx.fillRect(330,10,3+i,3);
  const data=canvas.toDataURL();const wrapper=document.createElement('div');wrapper.className='case';
  const img=new Image();img.className='source';img.src=data;
  if(record.producer){wrapper.style.height=(H*360/W)+'px';img.style.height=(H*360/W)+'px';}
  wrapper.append(img);document.querySelector('main').append(wrapper);await img.decode();
  const generation=TP.generationFor(img);
  const message=(result,phase)=>({type:'OVERLAY_HTML',mode:'lens_text',source:'ai',original:img.src,generation,result,translationRun:{...stamp,phase,revision:phase==='repair'?record.revision:''}});
  await TP.applyInsertMessage({type:'TP_TRANSLATION_BIND',original:img.src,generation,translationRun:stamp});
  fixtures.push({img,wrapper,raw,producer:record.producer,W,H,initial:message(record.initial,'initial'),repair:message(record.repaired,'repair')});
 }
 window.inspectFixture=async()=>Promise.all(fixtures.map(async(f,i)=>{
  const clean=f.wrapper.querySelector('.tp-ol-clean-img');let pixels=[];
  if(clean?.src){await clean.decode();const c=document.createElement('canvas');c.width=f.W;c.height=f.H;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(clean,0,0);pixels=f.raw.eraseBoxes.boxes.map(b=>[...x.getImageData(Math.floor((b.l+b.w/2)*f.W),Math.floor((b.t+b.h/2)*f.H),1,1).data]);}
  return {cleanVisible:!!clean&&getComputedStyle(clean).display!=='none',pixels,text:f.wrapper.querySelector('.tp-ol-scope')?.textContent||'',drawnParagraphs:[...new Set([...f.wrapper.querySelectorAll('[data-tp-para]')].map(n=>n.dataset.tpPara))],hosts:f.wrapper.querySelectorAll('.tp-ol-root').length,sourceUnchanged:f.img.src===f.initial.original};
 }));
 const initial=await TP.applyInsertBatch(fixtures.map((f,i)=>({id:String(i),message:f.initial})));
 await TP.nextFrame();window.initialInspection=await inspectFixture();
 return {initial,inspection:initialInspection,builds:fixtureLogs.builds};
}'''
report={'schema':'tp.browser-repair/1','project':str(args.project),'scope':'actual Chromium DOM/canvas modules; no extension worker, provider or Lens','producer_replay':args.producer_replay,'checks':[]}
def check(name,value):
    report['checks'].append({'name':name,'pass':bool(value)})
    print(('PASS' if value else 'FAIL'),name,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 report['browser']=browser.version;context=browser.new_context(viewport={'width':800,'height':700})
 context.route('**/*',lambda route:route.abort())
 page=context.new_page();page.set_content('<!doctype html><meta charset="utf-8"><title>TextPhantom repair fixture</title><style>body{margin:20px;font:14px sans-serif;background:#dedede}main{display:grid;grid-template-columns:repeat(2,360px);gap:24px}.case{position:relative;background:white;width:360px;height:300px}img.source{width:360px;height:300px}</style><main></main>')
 module_url(page,'processors/render/renderer.js')
 page.evaluate('urls=>window.moduleUrls=urls',module_cache)
 page.evaluate(setup)
 for name in ['dom-utils.js','target-key.js','erase-canvas.js','overlay/style.js','overlay/background.js','overlay/status.js','overlay/mount.js','overlay/local-render.js','overlay.js','overlay/message-controller.js']:
  page.add_script_tag(content=(args.project/'src/content'/name).read_text())
 report['initial']=page.evaluate(fixture,records)
 if args.producer_replay:
  check('real decoder emits an owned mask for every captured source span',all(b.get('p') for b in records[0]['raw']['eraseBoxes']['boxes']))
  check('initial partial keeps accepted text and clean background',all(x['cleanVisible'] and 'ผ่านแล้ว' in x['text'] for x in report['initial']['inspection']))
  check('untranslated p0/p1 retain original pixels before repair',all(px[0]<30 for b,px in zip(records[0]['raw']['eraseBoxes']['boxes'],report['initial']['inspection'][0]['pixels']) if b['p'] in ('p0','p1')))
 else:
  check('initial partial keeps clean backgrounds and existing translations',all(x['cleanVisible'] and 'ผ่านแล้ว' in x['text'] and x['pixels'][0][0]>240 and x['pixels'][1][0]<30 for x in report['initial']['inspection']))
 page.screenshot(path=str(args.out/'initial.png'))
 report['repair']=page.evaluate('''async()=>{
  const ack=await __TP.applyInsertBatch(fixtures.map((f,i)=>({id:String(i),message:f.repair})));
  await __TP.nextFrame();return {ack,inspection:await inspectFixture(),builds:fixtureLogs.builds};
 }''')
 if args.producer_replay:
  masks=records[0]['raw']['eraseBoxes']['boxes'];before=report['initial']['inspection'][0]['pixels'];after=report['repair']['inspection'][0]['pixels']
  check('repair now erases repaired p1 source pixels',all(px[0]>240 for b,px in zip(masks,after) if b['p']=='p1'))
  check('still-unresolved p0 source pixels remain untouched after repair',all(px[0]<30 for b,px in zip(masks,after) if b['p']=='p0'))
  check('all previously erased sample pixels stay erased; source image not restored',all(a[0]>240 for b,a,z in zip(masks,after,before) if b['p'] not in ('p0','p1') and z[0]>240))
 else:
  check('repair keeps erased pixels for old and repaired units',all(x['cleanVisible'] and all(px[0]>240 for px in x['pixels']) for x in report['repair']['inspection']))
 if not args.producer_replay: check('canonical group member is drawn by its leader only',all('p1' in x['drawnParagraphs'] and 'p2' not in x['drawnParagraphs'] for i,x in enumerate(report['repair']['inspection']) if i%2))
 check('horizontal/grouped pages keep accepted text and own repaired text',all('ผ่านแล้ว '+str(i) in x['text'] and 'ซ่อมแล้ว '+str(i) in x['text'] and x['hosts']==1 and x['sourceUnchanged'] for i,x in enumerate(report['repair']['inspection'])))
 page.screenshot(path=str(args.out/'repaired.png'))
 report['replay']=page.evaluate('''async()=>{const before=fixtureLogs.builds;const ack=await __TP.applyInsertBatch(fixtures.map((f,i)=>({id:String(i),message:f.repair})));return {ack,extraBuilds:fixtureLogs.builds-before};}''')
 check('duplicate repair receipt never rebuilds a background',report['replay']['extraBuilds']==0 and all(x.get('replayed') for x in report['replay']['ack']['results']))
 report['late']=page.evaluate('''async()=>__TP.applyInsertBatch(fixtures.map((f,i)=>({id:String(i),message:f.initial})))''')
 check('late initial result cannot overwrite repair',all(x.get('stale') and not x.get('applied') for x in report['late']['results']))
 check('expected partial never emits console warnings',not page.evaluate('fixtureLogs.warnings').__len__())
 report['cancelBefore']=page.evaluate('''async()=>{__TP.resetForNavigation('test-navigation');const ack=await __TP.applyInsertMessage(fixtures[0].repair);return {ack,hosts:document.querySelectorAll('.tp-ol-root').length};}''')
 check('navigation before delivery rejects an old generation',report['cancelBefore']['ack'].get('stale') and report['cancelBefore']['hosts']==0)
 # Suspend a genuine async erasure, navigate, then release its old answer.
 report['cancelDuring']=page.evaluate('''async()=>{
  const f=fixtures[0], generation=__TP.generationFor(f.img), stamp={...f.initial.translationRun,generationId:'during-render'};
  await __TP.applyInsertMessage({type:'TP_TRANSLATION_BIND',original:f.img.src,generation,translationRun:stamp});
  const real=__TP.buildErasedBackground;let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  __TP.buildErasedBackground=async(...a)=>{started();await gate;return real(...a);};
  const pending=__TP.applyInsertMessage({...f.initial,generation,translationRun:stamp});
  await began;__TP.resetForNavigation('mid-render');release();const ack=await pending;
  __TP.buildErasedBackground=real;return {ack,hosts:document.querySelectorAll('.tp-ol-root').length};
 }''')
 if 'ack' in report['cancelDuring']:
  check('navigation during erasure cannot remount an old overlay',report['cancelDuring']['ack'].get('stale') and report['cancelDuring']['hosts']==0)
 browser.close()
report['passed']=sum(x['pass'] for x in report['checks']);report['failed']=sum(not x['pass'] for x in report['checks'])
(args.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'passed':report['passed'],'failed':report['failed']},indent=2))
raise SystemExit(1 if report['failed'] else 0)
