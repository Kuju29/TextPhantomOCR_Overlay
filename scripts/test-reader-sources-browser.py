"""Offline reader source + lifecycle regression. Real Chromium DOM and isolated
world; location, network, component data and final render receipts are fixtures.
No installed extension, live website, Lens or AI. Requires Python playwright.
"""
import argparse
import json
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument('--browser', default='/usr/bin/chromium')
args = parser.parse_args()
root = args.project / 'src'
results = []

def check(name, ok):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name, flush=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=args.browser, headless=True,
                                        args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context()
    context.route('**/*', lambda route: route.abort())

    def setup(attr='data-page', start=1, count=28, prefix='reader', mounted=3,
              canvas=False, load_bridge=True, host='reader.test'):
        page = context.new_page()
        page.set_content('<style>.page-slot{width:300px;height:430px;position:relative}img,canvas{width:300px;height:430px}</style><main data-reader id="book"></main>')
        loc = {'href': f'https://{host}/read/book-42', 'hostname': host, 'pathname': '/read/book-42'}
        fixture = {'loc': loc, 'attr': attr, 'start': start, 'count': count,
                   'mounted': mounted, 'canvas': canvas, 'prefix': prefix}
        page.evaluate('''o=>{
          window.fixture=o;
          window.urlFor=id=>'https://cdn.reader.test/image/book42/'+id+'.jpg';
          const book=document.querySelector('main'); book.className=o.prefix+'-container';
          for(let n=0;n<o.count;n++){
            const id=o.start+n,slot=document.createElement('div');slot.className='page-slot';
            slot.setAttribute(o.attr,o.attr==='aria-label'?'Page '+id:String(id));
            if(n<o.mounted){const img=document.createElement('img');img.src=urlFor(id);img.width=600;img.height=860;slot.append(img);}
            else if(o.canvas){const c=document.createElement('canvas');c.width=600;c.height=860;slot.append(c);}
            book.append(slot);
          }
          window.items=Array.from({length:o.count},(_,n)=>urlFor(o.start+n));
        }''', fixture)
        uid = str(uuid.uuid4())
        mocks = f'''const location={json.dumps(loc)}, crypto={{randomUUID:()=>{json.dumps(uid)}}};'''
        if load_bridge:
            page.evaluate('(()=>{' + mocks + (root/'content/reader/page-sources.js').read_text() + '})()')
        cdp = context.new_cdp_session(page)
        frame = cdp.send('Page.getFrameTree')['frameTree']['frame']['id']
        world = cdp.send('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'TextPhantom-fixture'})['executionContextId']
        def evaluate(expression):
            reply = cdp.send('Runtime.evaluate', {'contextId': world, 'expression': expression,
                'awaitPromise': True, 'returnByValue': True})
            if 'exceptionDetails' in reply:
                raise AssertionError(reply['exceptionDetails'].get('exception', {}).get('description', str(reply)))
            return reply.get('result', {}).get('value')
        bootstrap = '''window.calls={fetch:0,bridge:0,placed:[],events:[],warnings:[]};
          document.addEventListener('TP_READER_SOURCES_V1',()=>calls.bridge++);
          window.__TP={pageInstanceId:'fixture-page',bail:false,
            log:{info(){},warn(...a){calls.warnings.push(a)},error(){}},
            normUrl:raw=>{try{return new URL(raw,LOCATION.href).href}catch{return ''}},
            getBestImgUrl:img=>img?.getAttribute('data-src')||img?.currentSrc||img?.src||'',
            isTranslationOutputImage:()=>false,isMangaDexHost:()=>false,
            buildPayload:(o)=>({...o,context:{}}), buildPositionFromElement:()=>({}),
            traceNote(){},traceNoteFor(){},
            overlayMount:{dropHtmlOverlay(){},hasRasterOverlay:()=>false,hasHtmlOverlay:()=>false},
            applyInsertMessage:async msg=>{calls.placed.push(msg.generation.readerPageId);return{ok:true,applied:true}},
          };
          window.chrome={runtime:{sendMessage:(msg,cb)=>{calls.events.push(msg);cb?.()},lastError:null}};
          window.fetch=async()=>{calls.fetch++;return{ok:false}};
        '''.replace('LOCATION', json.dumps(loc))
        evaluate(bootstrap)
        for name in ['sources.js','classification.js','runtime.js']:
            evaluate('(()=>{' + mocks + (root/'content/reader'/name).read_text() + '})()')
        evaluate('window.plan=__TP.readerClassification.detect()')
        return page, evaluate

    def inline(page, data, identifier=None):
        page.evaluate('''({data,id})=>{const s=document.createElement('script');s.type='application/json';if(id)s.id=id;s.textContent=JSON.stringify(data);document.body.append(s)}''', {'data':data,'id':identifier})

    def collect(ev):
        return ev('(async()=>{const m=await __TP.readerClassification.sources(plan);return {size:m.size,urls:[...m],profile:plan.profile,calls,detail:plan.sourceDiagnostics}})()')

    page, ev = setup()
    check('partial numbered reader is detected without a named host', ev('plan?.ids.length===28'))
    inline(page, {'payload': {'chapter': {'pages': [f'https://cdn.reader.test/image/book42/{i}.jpg' for i in range(1,29)]}}})
    result=collect(ev)
    check('JSON manifest fills 28 pages from 3 mounted images', result['size']==28 and result['profile']=='reader-manifest')
    check('complete manifest needs no bridge or HTML request', result['calls']['bridge']==0 and result['calls']['fetch']==0)
    page.close()

    for host, attr, start in [('other.test','data-page-number',1),('reader-two.test','data-index',0),('mirror.invalid','aria-label',1)]:
        page,ev=setup(attr=attr,start=start,host=host)
        page.evaluate('''()=>{document.querySelectorAll('.page-slot').forEach((s,i)=>{s.__reactProps$fixture={page:{url:items[i]}}})}''')
        check(f'{attr}: page component data works on {host}', collect(ev)['size']==28)
        check(f'{attr}: request marker cleaned after bridge reply',ev('!document.querySelector("[data-tp-reader-source-probe]")'))
        page.close()

    page,ev=setup()
    page.evaluate('''()=>{
      const data={pages:{baseUrl:'https://cdn.reader.test/image/book42',items:items.map((_,i)=>({src:(i+1)+'.jpg'}))}};
      const parent={stateNode:document.querySelector('main'),memoizedProps:{data}};
      const slot=document.querySelector('.page-slot');slot.__reactFiber$fixture={stateNode:slot,memoizedProps:{},return:parent};
    }''')
    result=collect(ev)
    check('ancestor component manifest retains full scope and resolves relative items',result['size']==28 and result['profile']=='reader-page-data')
    page.close()

    page,ev=setup()
    inline(page, {'pages':[f'https://cdn.reader.test/image/old-book/{i}.jpg' for i in range(1,29)]})
    result=collect(ev)
    check('same-length manifest from a different chapter is rejected',result['size']==3)
    page.close()

    page,ev=setup()
    page.evaluate("document.querySelectorAll('img').forEach((img,i)=>img.src='https://cdn.reader.test/image?id='+(i+1))")
    inline(page, {'pages':[f'https://cdn.reader.test/image?id={i+100}' for i in range(1,29)]})
    check('query-only image identities are not treated as equivalent', collect(ev)['size']==3)
    page.close()

    page,ev=setup(mounted=0)
    inline(page, {'pages':[f'https://cdn.reader.test/image/book42/{i}.jpg' for i in range(1,29)]})
    check('count alone without source or chapter identity cannot bind a manifest', collect(ev)['size']==0)
    page.close()

    page,ev=setup(mounted=0,canvas=True)
    page.evaluate("document.querySelector('main').setAttribute('data-chapter-id','42')")
    inline(page, {'chapterId':'42','pages':[f'https://cdn.reader.test/image/book42/{i}.jpg' for i in range(1,29)]})
    check('explicit matching chapter identity permits a canvas-only reader',collect(ev)['size']==28)
    page.close()

    page,ev=setup(mounted=3)
    base=[f'https://cdn.reader.test/image/book42/{i}.jpg' for i in range(1,29)]
    second=base.copy();second[9]='https://cdn.reader.test/image/conflicting/10.jpg'
    inline(page, {'a':{'pages':base},'b':{'pages':second}})
    check('ambiguous manifests are rejected, not selected by order',collect(ev)['size']==3)
    page.close()

    page,ev=setup()
    page.evaluate('''()=>{document.querySelectorAll('.page-slot').forEach((s,i)=>{s.__reactProps$fixture={page:{url:items[i]},image:{url:'https://cdn.reader.test/ambiguous.jpg'}}})}''')
    check('ambiguous per-slot component URLs stay unresolved',collect(ev)['size']==3)
    page.close()

    page,ev=setup()
    page.evaluate('''()=>{
      window.getterReads=0;document.querySelectorAll('.page-slot').forEach((s,i)=>{
        s.__reactProps$fixture={imageUrl:items[i]};
        Object.defineProperty(s.__reactProps$fixture,'page',{get(){getterReads++;throw Error('Do not invoke getters')}});
      });
      const outside=document.createElement('section');outside.dataset.page='10';outside.__reactProps$fixture={imageUrl:'https://other.test/wrong.jpg'};document.body.append(outside);
    }''')
    check('scoped component read ignores outside slots and does not invoke getters',collect(ev)['size']==28 and page.evaluate('getterReads')==0)
    page.close()

    page,ev=setup()
    result=collect(ev)
    check('missing source stays unresolved; no synthetic URL derivation',result['size']==3 and result['profile']=='reader-source-unresolved')
    error=ev('''(async()=>{try{await __TP.collectReaderImages('lens_text','th');return ''}catch(e){return e.message}})()''')
    check('Translate All reports missing sources instead of silently accepting 3/28', '25/28' in error and 'READER_SOURCE_UNAVAILABLE' in error)
    page.close()

    page,ev=setup(load_bridge=False)
    ev('window.abortDiscovery=new AbortController()')
    ev('window.abortedRead=__TP.readerClassification.sources(plan,abortDiscovery.signal).then(()=>false,e=>e.name) ; void 0')
    ev('abortDiscovery.abort();void 0')
    check('cancelled discovery clears the bridge marker and rejects',ev('abortedRead')=='AbortError' and ev('!document.querySelector("[data-tp-reader-source-probe]")'))
    page.close()

    page,ev=setup(load_bridge=False)
    check('unavailable MAIN bridge produces explicit diagnostic',collect(ev)['detail']['bridge']=='bridge_unavailable')
    page.close()

    page,ev=setup(mounted=28)
    check('fully mounted ordinary numbered images remain NORMAL',ev('plan===null') and ev('calls.bridge===0 && calls.fetch===0'))
    page.close()

    page,ev=setup()
    ev('__TP.isMangaDexHost=()=>true')
    check('existing MangaDex route remains authoritative',ev('__TP.readerClassification.detect()===null'))
    page.close()

    page,ev=setup(mounted=0,canvas=True)
    page.evaluate('''()=>{document.querySelectorAll('.page-slot').forEach((s,i)=>{s.__reactProps$fixture={page:{url:items[i]}}})}''')
    check('canvas-only component props recover sources without pixel reads',collect(ev)['size']==28)
    ev("(async()=>{window.runItems=(await __TP.collectReaderImages('lens_text','th')).items;return runItems.length})()")
    ev('''window.messageFor=(i,phase='initial')=>({type:'OVERLAY_HTML',generation:runItems[i].generation,
      result:{},translationRun:{runId:'translation',generationId:'generation',phase,revision:phase==='repair'?2:1}})''')
    first=ev('__TP.stageReaderInsert(messageFor(0))')
    check('ready result is placed before chapter completion',first.get('applied')==True)
    page.evaluate("document.querySelectorAll('.page-slot')[9].querySelector('canvas').remove()")
    wait=ev('__TP.stageReaderInsert(messageFor(9))')
    check('unmounted page retains prepared result',wait.get('pending')==True)
    page.evaluate("(()=>{const c=document.createElement('canvas');c.width=600;c.height=860;document.querySelectorAll('.page-slot')[9].append(c)})()")
    page.wait_for_timeout(120)
    check('remount replays stored result without source fetch/OCR/AI',ev("calls.placed.includes('10') && calls.fetch===0"))
    repair=ev("__TP.stageReaderInsert(messageFor(0,'repair'))")
    stale=ev('__TP.stageReaderInsert(messageFor(0))')
    check('repair supersedes the initial result',repair.get('applied')==True and stale.get('stale')==True)
    ev('__TP.cancelReaderRun()')
    check('cancelled run rejects late results',ev('__TP.stageReaderInsert(messageFor(1))').get('stale')==True)
    page.close()
    browser.close()

failed=[name for name,ok in results if not ok]
print(f'Reader sources/lifecycle: {len(results)-len(failed)}/{len(results)} passed')
raise SystemExit(bool(failed))
