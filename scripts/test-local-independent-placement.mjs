import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const TP={bail:false,log:{info(){},warn(){}},findTargetImage:()=>null,
  isMangaDexHost:()=>false,mdKeyFromUrl:()=>'',isStillCurrent:()=>({ok:true})};
const target={isConnected:true},waits=[];
TP.waitForTarget=async (...args)=>{waits.push(args[0]);return target;};
TP.applyHtmlOverlay=async()=>({drawn:true});
const context=vm.createContext({window:{__TP:TP},document:{visibilityState:'visible'},
  WeakMap,Map,Date,JSON,String,Number,Boolean,Array,Promise});
vm.runInContext(await readFile(new URL('../src/content/overlay/message-controller.js',import.meta.url),'utf8'),context);
const generation={targetKey:'page-1'};
const message={type:'OVERLAY_HTML',original:'https://fixture.invalid/page-1',
  mode:'lens_text',source:'ai',generation,
  translationRun:{runId:'run',generationId:'image',phase:'initial',revision:1}};
const preview=await TP.applyInsertMessage({...message,
  result:{meta:{provisional:true},aiRoute:{translationMode:'independent'}}});
assert.equal(preview.previewSkipped,true,
  'unmounted Local preview does not wait for the 60-second ordinary remount timer');
assert.equal(waits.length,0);
const final=await TP.applyInsertMessage({...message,result:{}});
assert.equal(final.applied,true);
assert.deepEqual(waits,['page-1'],'normal final placement retains its existing remount owner');
console.log('PASS absent Local preview never blocks the next provider chunk; final insertion still waits for its target');
