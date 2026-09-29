import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../src/content/progress-panel.js',import.meta.url),'utf8');
let created=0;
function node(){
  created++;
  const events=new Map();
  return {style:{},dataset:{},children:[],isConnected:true,scrollTop:0,
    textContent:'',appendChild(child){this.children.push(child);return child;},
    addEventListener(name,fn){events.set(name,fn);},
    setAttribute(){},contains(){return false;},querySelectorAll(){return[];},
    fire(name){events.get(name)?.();}};
}
const host={root:node(),main:node(),text:node(),toggle:node(),details:node()};
const page={__TP:{bail:false,getToastProgressHost:()=>host,setToastProgressMode(){}},addEventListener(){}};
vm.runInNewContext(source,{window:page,document:{addEventListener(){},createElement:node},
  setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout});

const now=Date.now();
const running={id:'transport-turn',sequence:1,startedAt:now+1,total:3,
  lifecycle:'processing',terminal:0,processingComplete:false,
  items:[0,1,2].map(index=>({label:`Image ${index+1}`,inserted:index===0,terminal:false,
    progress:{overall:{state:'running'},ai:{state:'running',function:'receiving_response',
      startedAt:now,conversation:true,pageCount:3,unitCount:45,turn:1},
      insert:{state:index===0?'done':'queued'},result:{state:'pending'}}}))};
created=0;
page.__TP.updateBatchProgress(running);
await new Promise(resolve=>setTimeout(resolve,120));
assert.equal(created,0,'a collapsed board must not rebuild hundreds of grid cells for each status');
assert.match(host.text.textContent,/inserted 1\/3.*AI request receiving response \(3p\/45u turn\)/,
  'shown pages and the still-open request must be distinguishable');
host.details.scrollTop=115;
host.toggle.fire('click');
assert.ok(created>0,'opening the board must render the most recent per-image snapshot');
const before=created;
running.sequence=2;
page.__TP.updateBatchProgress(running);
await new Promise(resolve=>setTimeout(resolve,120));
assert.ok(created>before,'expanded board must refresh its grid');
assert.equal(host.details.scrollTop,115,'a refreshed grid must preserve reading position');
host.toggle.fire('click');
const afterClose=created;
running.sequence=3;
page.__TP.updateBatchProgress(running);
await new Promise(resolve=>setTimeout(resolve,120));
assert.equal(created,afterClose,'collapsed updates must stop rebuilding the grid again');
running.sequence=4;
running.conversation={phase:'turn_complete',turn:1};
running.repair={phase:'collecting',failedUnits:1,repaired:0};
running.items[0].progress.ai.function='preparing_next_turn';
page.__TP.updateBatchProgress(running);
await new Promise(resolve=>setTimeout(resolve,120));
assert.match(host.text.textContent,/AI reply complete · delivering page results/,
  'a closed provider response must not read as receiving merely because other pages await projection');
assert.doesNotMatch(host.text.textContent,/preparing next turn|AI request receiving response/);
running.sequence=5;
running.conversation={phase:'translating',turn:2};
running.items[1].progress.ai.turn=2;
page.__TP.updateBatchProgress(running);
await new Promise(resolve=>setTimeout(resolve,120));
assert.match(host.text.textContent,/AI request receiving response/,
  'a genuinely new provider turn takes priority over the prior turn response');
page.__TP.clearBatchProgress();
console.log('PASS active Conversation status distinguishes the open request and collapsed details stay cheap.');
