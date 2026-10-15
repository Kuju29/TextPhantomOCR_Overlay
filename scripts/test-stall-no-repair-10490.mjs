// 10490 E2E finding: a page whose provider stream stopped with
// ai_provider_stalled before writing any line was handed to one automatic
// repair, which stalled again; the user saw "AI กำลังเตรียมซ่อมคำแปล" and the
// final message only at ~124 s. Now:
// * a page stopped by a stream rule (stalled / thought too long / safety
//   ceiling) with no line leaves the repair run: its error is not deferred and
//   it is reported to the repair ledger with nothing to repair;
// * a partial page (some lines) still repairs its missing lines;
// * the status keeps "ไม่มีการตอบกลับ — กำลังหยุด" visible for ≥ 1.5 s even
//   when the page error arrives right after it (display only).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRepairCoordinator} from '../src/background/repair/coordinator.js';
import {createTranslationSessionStore} from '../src/background/translation-session-store.js';
import {digestText} from '../src/background/repair/page-checkpoint.js';
import {ensureBatch} from '../src/background/batches.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
let checks = 0;
const ok = name => { checks++; console.log('PASS ' + name); };

// ------------------------------------------------------------ repair run
async function runCase(name, release) {
  const value = {}, area = {get:async key => key == null ? structuredClone(value) : {[key]:structuredClone(value[key])},
    set:async patch => Object.assign(value, structuredClone(patch)), remove:async keys => [].concat(keys).forEach(key => delete value[key])};
  const sessions = createTranslationSessionStore({area:() => area}), events = [], reports = [];
  const batch = ensureBatch('stall-no-repair-' + name, 97600 + checks, 0);
  const payload = id => ({engine:'extension', mode:'lens_text', source:'ai', lang:'th', src:`https://fixture.invalid/${id}.png`, metadata:{image_id:id}});
  for (const id of ['stall-page', 'partial-page']) batch.items.set(id, {attempt:1, status:'processing', phase:'ai_generating', payload:payload(id)});
  const unit = async (id, text) => ({id, text, translatable:true, paragraphIds:['p-' + id], sourceHash:await digestText(text)});
  const page = async (pageId, units, accepted, failures) => ({pageId, generationId:'gen-' + pageId, groupKey:'a'.repeat(64),
    units, accepted, failures, blocked:[], inFlight:[], repaired:[], phase:'finished', delivered:false,
    ai:{provider:'openrouter', model:'m', translation_mode:'conversation'}, route:'server', sourceLang:'ja', targetLang:'th',
    ctx:{tabId:batch.tabId, frameId:0, sessionId:'fixture-session', settingsEpoch:7}});
  const coordinator = createRepairCoordinator({sessions, currentEpoch:() => 7, currentSession:() => 'fixture-session',
    getBase:async () => 'http://fixture.invalid',
    preparedPages:{listRun:async () => [], clearRun:async () => {}}, dispatchJournal:{listRun:async () => [], clearRun:async () => {}},
    getCapabilitiesFor:async () => ({}), readSettings:async () => ({}), emit:(event, data) => events.push({event, data}),
    insert:async () => ({ok:true, applied:true}),
    api:async (_run, path, body) => { if (path === 'pages') reports.push(...body.pages); return path === 'seal' ? {phase:'repairing', pending:[{id:'R0'}]} : {}; },
    execute:async () => ({phase:'done', repaired:0, unresolved:1, failedUnits:1, initialAccepted:1, unverified:0, results:[], skipped:[]})});
  const run = await coordinator.registerBatch(batch, ['stall-page', 'partial-page'].map(payload));
  assert.ok(run);
  const stalledUnits = await Promise.all([0, 1, 2].map(i => unit('S' + i, `来年の私 ${i}`)));
  const partialUnits = await Promise.all([0, 1].map(i => unit('Q' + i, `ありがとう ${i}`)));
  await sessions.update(run.id, current => ({...current, pages:{}}));
  const stall = await page('stall-page', stalledUnits, [], stalledUnits.map(u => ({id:u.id, reason:'missing'})));
  const partial = await page('partial-page', partialUnits, [{id:'Q0', text:'ขอบคุณ'}], [{id:'Q1', reason:'missing'}]);
  await sessions.update(run.id, current => ({...current, pages:{'stall-page':stall, 'partial-page':partial}}));
  // The page owns its failure while repair is collecting (the image error would be deferred).
  batch.items.get('stall-page').presentation = {repairPhase:'collecting'};
  batch.repair = {phase:'collecting'};
  assert.equal(coordinator.ownsInitialFailure(batch.id, 'stall-page'), true);
  if (release) assert.equal(coordinator.releaseStoppedPage(batch.id, 'stall-page', 'ai_stalled'), true);
  await coordinator.finishInitial(batch); await sessions.flush();
  return {reports, events, saved:await sessions.get(run.id), batch, coordinator};
}
{
  const before = await runCase('control', false);
  assert.equal(before.reports.find(r => r.pageId === 'stall-page').failed.length, 3, 'without release the stalled page is repaired');
  const after = await runCase('released', true);
  const stall = after.reports.find(r => r.pageId === 'stall-page'), partial = after.reports.find(r => r.pageId === 'partial-page');
  assert.equal(stall.status, 'finished');
  assert.deepEqual(stall.failed, [], 'a stopped page with no line reports nothing to repair');
  assert.equal(stall.initialAccepted, 0);
  assert.deepEqual(partial.failed.map(f => f.id), ['Q1'], 'a partial page still repairs its missing line');
  assert.equal(after.saved.pages['stall-page'], undefined);
  assert.equal(after.saved.initialSkips['stall-page'], 'ai_stalled');
  assert.equal(after.coordinator.ownsInitialFailure(after.batch.id, 'stall-page'), false, 'its error is no longer deferred');
  assert.ok(after.events.find(e => e.event === 'repairPageReleased' && e.data.pageId === 'stall-page' && e.data.code === 'ai_stalled'));
  ok('repair run: a stream-stopped page with no line is not repaired; a partial page still is');
}

// ------------------------------------------------------------ which failures skip repair
{
  const jobs = await read('src/background/jobs.js');
  const set = jobs.match(/const STREAM_STOP_NO_REPAIR = new Set\(\[([^\]]*)\]\)/);
  assert(set, 'jobs.js lists the stop codes that are not repaired');
  const codes = [...set[1].matchAll(/"(\w+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(codes, ['ai_provider_stalled', 'ai_stalled', 'ai_stream_ceiling', 'ai_thinking_too_long'],
    'stall / thought too long / ceiling (page codes lower-cased and raw stream codes); no-progress stops still repair');
  assert.match(jobs, /if \(STREAM_STOP_NO_REPAIR\.has\(code\)\) \{\s*repairCoordinator\.releaseStoppedPage\(batch\?\.id, imageKey, code\);\s*return false;/,
    'the image error is shown at the first stop, not deferred to repair');
  const translation = await read('src/background/pipeline/page-translation.js');
  for (const code of ['AI_STALLED', 'AI_THINKING_TOO_LONG', 'AI_STREAM_CEILING'])
    assert(codes.includes(code.toLowerCase()) && translation.includes(`"${code}"`), code);
  ok('jobs.js: AI_STALLED / AI_THINKING_TOO_LONG / AI_STREAM_CEILING page failures leave repair');
}

// ------------------------------------------------------------ the stop stays readable
{
  const pageText = await read('src/shared/page-ui-text.js');
  const panel = await read('src/content/progress-panel.js');
  const node = () => ({style:{}, dataset:{}, children:[], isConnected:true, textContent:'', title:'',
    appendChild(child){this.children.push(child); return child;}, addEventListener(){}, setAttribute(){},
    contains(){return false;}, querySelectorAll(){return [];}});
  const host = {root:node(), main:node(), text:node(), toggle:node(), details:node()};
  let tick = null;
  const context = {window:null, document:{addEventListener(){}, removeEventListener(){}, createElement:node},
    setInterval:fn => { tick = fn; return 1; }, clearInterval(){}, setTimeout, clearTimeout,
    chrome:{storage:{local:{get:(_k, done) => done({uiLanguageV1:'th'})}, onChanged:{addListener(){}}}}};
  context.globalThis = context;
  context.window = {__TP:{bail:false, getToastProgressHost:() => host, setToastProgressMode(){}}, addEventListener(){}};
  vm.createContext(context);
  vm.runInContext(pageText, context); vm.runInContext(panel, context);
  const start = Date.now(), stalled = {phase:'stalled', reason:'ai_provider_stalled', receivedAt:Date.now()};
  // The page error arrives with the stall phase still on the (now failed) AI lane.
  context.window.__TP.updateBatchProgress({id:'stall-hold', sequence:1, startedAt:start + 10, total:1, lifecycle:'processing',
    terminal:1, stats:{error:1}, items:[{label:'Image 1', terminal:true, phase:'error', progress:{overall:{state:'error'},
      ai:{state:'error', function:'provider_stream', streamPhase:stalled, startedAt:start - 60_000, finishedAt:start},
      insert:{state:'idle'}, result:{state:'error', detail:'AI_STALLED'}}}]});
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.match(host.text.textContent, /ไม่มีการตอบกลับ — กำลังหยุด/, host.text.textContent);
  assert.doesNotMatch(host.text.textContent, /ผิดพลาด|เสร็จใน/, 'the stop is not replaced at once');
  await new Promise(resolve => setTimeout(resolve, 1200));
  tick();
  assert.match(host.text.textContent, /ไม่มีการตอบกลับ — กำลังหยุด/, 'still visible after 1.3 s');
  await new Promise(resolve => setTimeout(resolve, 400));
  tick();
  assert.doesNotMatch(host.text.textContent, /ไม่มีการตอบกลับ/, 'then the error takes over');
  assert.match(host.text.textContent, /ผิดพลาด 1/);
  ok('status keeps "ไม่มีการตอบกลับ — กำลังหยุด" for ≥ 1.5 s before the error');
}
console.log(`${checks} checks passed`);
