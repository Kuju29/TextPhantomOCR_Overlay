import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const {translationSettingsChanged}=await import(pathToFileURL(root+'/src/background/translation-settings.js'));
const source=readFileSync(root+'/src/background/index.js','utf8');
const begin=source.indexOf('let translationServiceMode;');
const end=source.indexOf('  else invalidate();',begin)+'  else invalidate();'.length;
assert(begin>=0 && end>begin);
// Execute the exact production startup/listener gate. The remaining listener
// features are unrelated diagnostic shipping and are intentionally not mocked.
const code=source.slice(begin,end)+'\n});';
function harness(){let listener,resolve,bumped=0,cancelled=0;const saved=new Promise(r=>resolve=r);vm.runInNewContext(code,{getStorage:()=>saved,chrome:{storage:{onChanged:{addListener:fn=>listener=fn}}},translationSettingsChanged,bumpSettingsEpoch:()=>bumped++,repairCoordinator:{cancelSettings:()=>cancelled++},traceNote:()=>{}});return {change:(c,area='local')=>listener(c,area),boot:async mode=>{resolve({aiServiceMode:mode});await Promise.resolve();await Promise.resolve();await Promise.resolve();},counters:()=>({bumped,cancelled})};}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
const login={paidSessionToken:{oldValue:'',newValue:'a'.repeat(64)},paidApiBase:{oldValue:'',newValue:'http://localhost:7860'}};
await test('Manual startup defers support login and preserves active translation after settings read',async()=>{const h=harness();h.change(login);assert.deepEqual(h.counters(),{bumped:0,cancelled:0});await h.boot('manual');assert.deepEqual(h.counters(),{bumped:0,cancelled:0});h.change({paidSessionToken:{oldValue:'a',newValue:''}});assert.deepEqual(h.counters(),{bumped:0,cancelled:0});});
await test('Local startup does not cancel translation on shared customer login/logout or Paid model update',async()=>{const h=harness();await h.boot('local');h.change(login);h.change({paidModel:{oldValue:'one',newValue:'two'},paidAiProfilesV1:{oldValue:{a:1},newValue:{a:2}}});assert.deepEqual(h.counters(),{bumped:0,cancelled:0});});
await test('Paid startup bumps the settings epoch for new work when the verified account changes (.70: running work is not cancelled)',async()=>{const h=harness();h.change(login);await h.boot('paid');assert.deepEqual(h.counters(),{bumped:1,cancelled:0});});
await test('New Manual mode event wins a late stale Paid startup read',async()=>{const h=harness();h.change({aiServiceMode:{oldValue:'paid',newValue:'manual'}});h.change(login);await h.boot('paid');assert.deepEqual(h.counters(),{bumped:1,cancelled:0});h.change({paidSessionToken:{oldValue:'a',newValue:'b'}});assert.deepEqual(h.counters(),{bumped:1,cancelled:0});});
await test('New Paid mode event wins a late stale Manual startup read; identity change bumps the epoch without cancelling',async()=>{const h=harness();h.change({aiServiceMode:{oldValue:'manual',newValue:'paid'}});await h.boot('manual');h.change(login);assert.deepEqual(h.counters(),{bumped:2,cancelled:0});});
await test('Support preferences unread and session-area changes do not cancel any translation',async()=>{const h=harness();await h.boot('paid');h.change({supportUnread:{newValue:{unread:1}},supportDockView:{newValue:'expanded'},supportNotification:{newValue:'preview'},supportActivated:{newValue:true}});h.change(login,'session');assert.deepEqual(h.counters(),{bumped:0,cancelled:0});});
const report={checks:results.length,passed:results.filter(r=>r.passed).length,results};console.log(JSON.stringify(report,null,2));process.exitCode=report.checks!==report.passed?1:0;
