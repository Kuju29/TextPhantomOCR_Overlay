import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const listeners=new Map(),messages=[],placed=[],notices=[];
let warningActive=false;
const slot={isConnected:true,getBoundingClientRect:()=>({top:200,bottom:630,width:300,height:430})};
const root={isConnected:true,parentElement:null,contains:node=>node===slot || node===slot.surface,
  addEventListener(){},removeEventListener(){}};
let surface=null;
const plan={adapter:'',profile:'numbered-reader',root,selector:'[data-page]',attr:'data-page',
  ids:['12'],slots:new Map([['12',slot]])};
const classify={detect:()=>plan,sources:async()=>new Map([['12','https://fixture.invalid/page-12.jpg']]),
  number:()=> '12',surface:()=>surface,source:()=> 'https://fixture.invalid/page-12.jpg',own:()=>false};
const TP={bail:false,pageInstanceId:'fixture-instance',readerClassification:classify,
  log:{info(){},warn(){},error(){}},normUrl:s=>s,
  markImageError:(original,error,stamp)=>{notices.push({original,error,stamp});warningActive=true;return true;},
  hasImageError:()=>warningActive,clearImageError:()=>{warningActive=false;},
  buildPayload:(data)=>({...data,context:{}}),buildPositionFromElement:()=>({}),
  overlayMount:{dropHtmlOverlay(){},hasHtmlOverlay:()=>false},
  isStillCurrent:()=>({ok:true}),isMangaDexHost:()=>false,
  applyHtmlOverlay:async()=>{placed.push('12');return{drawn:true}}};
const document={hidden:false,visibilityState:'visible',documentElement:{clientHeight:720},
  addEventListener:(name,cb)=>listeners.set(`document:${name}`,cb),
  removeEventListener:(name)=>listeners.delete(`document:${name}`)};
const window={__TP:TP,innerHeight:720,
  addEventListener:(name,cb)=>listeners.set(`window:${name}`,cb),
  removeEventListener:(name)=>listeners.delete(`window:${name}`)};
const context={window,document,location:{href:'https://fixture.invalid/book',hostname:'fixture.invalid'},
  chrome:{runtime:{sendMessage:(message,callback)=>{messages.push(message);callback?.()},lastError:null}},
  MutationObserver:class{observe(){}disconnect(){}},IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
  AbortController,DOMException,crypto:webcrypto,WeakMap,Map,Set,Date,Promise,URL,Array,JSON,String,
  setTimeout,clearTimeout};
vm.runInNewContext(await readFile(new URL('../src/content/reader/runtime.js',import.meta.url),'utf8'),context);
vm.runInNewContext(await readFile(new URL('../src/content/overlay/message-controller.js',import.meta.url),'utf8'),context);
const items=await TP.collectReaderImages('lens_text','th');
for (const missing of [['P0','P1'],['P1']]) {
  const preview=await TP.applyInsertMessage({type:'OVERLAY_HTML',
    original:'https://fixture.invalid/page-12.jpg',mode:'lens_text',source:'ai',
    generation:items.items[0].generation,
    result:{meta:{provisional:true},aiRoute:{translationMode:'independent'},aiPartial:{missing}},
    translationRun:{runId:'r',generationId:'g',phase:'initial',revision:1}});
  assert.equal(preview.pending,true);
  assert.equal(placed.length,0,'successive Local previews are staged for an unmounted reader');
}
const wait=await TP.applyInsertMessage({type:'OVERLAY_HTML',original:'https://fixture.invalid/page-12.jpg',
  mode:'lens_text',source:'translated',generation:items.items[0].generation,result:{aiPartial:{missing:['P0']}},
  translationRun:{runId:'r',generationId:'g',phase:'initial',revision:1}});
assert.equal(wait.pending,true);
assert.equal(placed.length,0,'a saved result is not an insertion receipt');
const notice={type:'IMAGE_NOTICE',original:'https://fixture.invalid/page-12.jpg',generation:items.items[0].generation,
  error:{schema:'tp.error/1',code:'AI_INCOMPLETE',severity:'warning',userMessage:'AI แปลขาด 1 จุด'}};
assert.equal((await TP.applyInsertMessage(notice)).stored,true);
assert.equal(notices.length,1,'the available page slot can show a warning while its canvas is absent');
surface={isConnected:true,width:600,height:860,tagName:'CANVAS',matches:selector=>selector==='canvas',
  getBoundingClientRect:slot.getBoundingClientRect};
listeners.get('document:scroll')?.();
await new Promise(resolve=>setTimeout(resolve,250));
assert.deepEqual(placed,['12'],'scroll wakes the viewport result before the 750 ms retry');
assert.ok(notices.length>=1,'mounted reader image retains its pending repair warning');
assert.equal(notices[0].error.severity,'warning');
const initialNoticeCount=notices.length;
await TP.applyInsertMessage({type:'OVERLAY_HTML',mode:'lens_text',source:'translated',original:notice.original,
  generation:items.items[0].generation,result:{aiPartial:{missing:['P1']}},
  translationRun:{runId:'r',generationId:'g',phase:'repair',revision:2}});
assert.equal(notices.length,initialNoticeCount,
  'a completed repair does not create another warning even when units remain unresolved');
assert.equal(warningActive,false,
  'the translated repair result clears the initial pending warning');
assert.equal(placed.length,2,'notice must never overwrite the staged translated overlay');
surface.isConnected=false;
surface={isConnected:true,width:600,height:860,tagName:'CANVAS',matches:selector=>selector==='canvas',
  getBoundingClientRect:slot.getBoundingClientRect};
await TP.releaseReaderPlacement(items.items[0].generation.readerRunId);
await new Promise(resolve=>setTimeout(resolve,50));
assert.equal(placed.length,3,'remount replays the repaired overlay, not IMAGE_NOTICE');
await TP.applyInsertMessage({type:'OVERLAY_HTML',mode:'lens_text',source:'translated',original:notice.original,
  generation:items.items[0].generation,result:{},
  translationRun:{runId:'r',generationId:'g',phase:'repair',revision:3}});
assert.equal(TP.stageReaderNotice(notice).stale,true,'the completed repair cannot regain its old warning');
assert.ok(messages.some(message=>message.type==='TP_READER_PLACED'&&message.pageId==='12'));
TP.cancelReaderRun();
assert.equal(listeners.has('document:scroll'),false,'listeners leave with their reader run');
console.log('PASS virtual reader fast scroll remount wakes staged placement without false receipts');
