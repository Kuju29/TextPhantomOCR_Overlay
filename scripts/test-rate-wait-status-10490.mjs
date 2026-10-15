// 10490 E2E finding: while the extension waited out the API's per-install
// limit (429 identity_rate_limited + Retry-After), the in-page status showed
// only the generic queue text ("AI รอข้อความตอบกลับ"). Every install-limit
// wait must register itself; the batch snapshot carries its end time and the
// page shows "Server busy — waiting {seconds}s before continuing" (Thai:
// "เซิร์ฟเวอร์มีคนใช้เยอะ — รอ {seconds} วิ แล้วทำต่อให้อัตโนมัติ") with a
// countdown, cleared as soon as the work is sent again.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const store = {tpInstallIdV1:'ab'.repeat(16)};
globalThis.chrome = {runtime:{getManifest:() => ({version:'2026.test'}), sendMessage:() => Promise.resolve()},
  storage:{local:{get(keys, cb){const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(store);
    const out = Object.fromEntries(list.filter(k => k in store).map(k => [k, store[k]])); cb?.(out); return Promise.resolve(out);},
    set(value, cb){Object.assign(store, value); cb?.(); return Promise.resolve();}}, onChanged:{addListener(){}}}};
const header = await import('../src/background/transports/install-header.js');
const {withRequestSlot} = await import('../src/background/ai/translation-paths/request-slot.js');
const {ensureBatch, batchProgressSnapshot} = await import('../src/background/batches.js');
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
let checks = 0;
const ok = name => { checks++; console.log('PASS ' + name); };

// ------------------------------------------------------------ wait registry
{
  header.resetInstallHeaderForTest();
  let changes = 0;
  const off = header.onInstallWaitChange(() => changes++);
  const now = Date.now();
  assert.equal(header.installWaitUntil(now), 0);
  const endShort = header.beginInstallWait(2000, now), endLong = header.beginInstallWait(7000, now);
  assert.equal(header.installWaitUntil(now), now + 7000, 'the latest running wait is shown');
  endLong();
  assert.equal(header.installWaitUntil(now), now + 2000);
  endLong();
  endShort();
  assert.equal(header.installWaitUntil(now), 0, 'cleared when the work resumes');
  assert.equal(changes, 4, 'start/end of each wait is announced once');
  let during = 0;
  await header.waitInstallLimit(1200, async () => { during = header.installWaitUntil(); });
  assert(during > Date.now(), 'shown while waiting');
  assert.equal(header.installWaitUntil(), 0, 'cleared after the wait');
  off();
  ok('install-limit waits register, report their end time and clear on resume');
}

// ------------------------------------------------------------ AI request slot
{
  header.resetInstallHeaderForTest();
  const payload = {mode:'lens_text', source:'ai', engine:'extension', ai:{provider:'openai', model:'rate-wait', base_url:''}};
  const seen = [], shown = [];
  const off = header.onInstallWaitChange(() => shown.push(header.installWaitUntil() - Date.now()));
  let calls = 0;
  await withRequestSlot({payload, unitCount:1}, null, async () => {
    calls++;
    seen.push(header.installWaitUntil());
    if (calls === 1) throw Object.assign(new Error('HTTP 429'), {status:429, code:'identity_rate_limited',
      retryAfterMs:1000, generationAttempts:0});
    return {ok:true};
  });
  off();
  assert.equal(calls, 2);
  assert(shown[0] > 900 && shown[0] <= 1000, 'the Retry-After wait is shown while the request waits');
  assert(shown.at(-1) <= 0, 'and cleared when it ends');
  assert.equal(seen[0], 0, 'nothing shown before the limit');
  assert.equal(seen[1], 0, 'the countdown is gone once the request is sent again');
  ok('AI request slot: the install wait is shown until the same request is sent again');
}

// ------------------------------------------------------------ batch snapshot
{
  header.resetInstallHeaderForTest();
  const batch = ensureBatch('rate-wait-snapshot', 99410, 0);
  batch.items.set('img', {attempt:1, status:'processing', phase:'ai_generating', payload:{metadata:{image_id:'img'}}});
  assert.equal(batchProgressSnapshot(batch).rateWait, null);
  const now = Date.now(), end = header.beginInstallWait(5000, now);
  assert(batchProgressSnapshot(batch, '', now).rateWait.until >= now + 5000);
  end();
  assert.equal(batchProgressSnapshot(batch).rateWait, null);
  ok('batch snapshot carries the install wait end time (null when nothing waits)');
}

// ------------------------------------------------------------ every wait site
{
  const jobs = await read('src/background/jobs.js');
  assert.match(jobs, /if \(installLimited\) await waitInstallLimit\(retryAfterMs/, 'Lens/grouping stage wait');
  const server = await read('src/background/pipeline/server-translation.js');
  assert.equal((server.match(/await waitInstallLimit\(/g) || []).length, 2, 'server request + job submit waits');
  assert.match(await read('src/background/repair/client.js'), /waitInstallLimit\(installRetryDelayMs\(error\)/, 'repair control wait');
  assert.match(await read('src/background/ai/translation-paths/request-slot.js'), /endInstallWait=beginInstallWait\(delay\)/);
  assert.match(await read('src/background/batches.js'), /onInstallWaitChange\(/, 'a wait start/end refreshes the page status');
  ok('Lens/grouping, AI slot, server pipeline, job submit and repair waits all register');
}

// ------------------------------------------------------------ page status
{
  const pageText = await read('src/shared/page-ui-text.js');
  const panel = await read('src/content/progress-panel.js');
  const render = language => {
    const node = () => ({style:{}, dataset:{}, children:[], isConnected:true, textContent:'', title:'',
      appendChild(child){this.children.push(child); return child;}, addEventListener(){}, setAttribute(){},
      contains(){return false;}, querySelectorAll(){return [];}});
    const host = {root:node(), main:node(), text:node(), toggle:node(), details:node()};
    let tick = null;
    const context = {window:null, document:{addEventListener(){}, removeEventListener(){}, createElement:node},
      setInterval:fn => { tick = fn; return 1; }, clearInterval(){}, setTimeout, clearTimeout,
      chrome:{storage:{local:{get:(_k, done) => done({uiLanguageV1:language})}, onChanged:{addListener(){}}}}};
    context.globalThis = context;
    context.window = {__TP:{bail:false, getToastProgressHost:() => host, setToastProgressMode(){}}, addEventListener(){}};
    vm.createContext(context);
    vm.runInContext(pageText, context); vm.runInContext(panel, context);
    let sequence = 0;
    return {host, tick:() => tick?.(), async show(rateWait) {
      const start = Date.now();
      context.window.__TP.updateBatchProgress({id:'rate-' + language, sequence:++sequence, startedAt:start + 10, total:2,
        lifecycle:'processing', terminal:0, rateWait, items:[{label:'Image 1', terminal:false, progress:{overall:{state:'running'},
          ai:{state:'running', function:'waiting_response_text', startedAt:start, conversation:true, pageCount:1, unitCount:14, turn:1},
          insert:{state:'queued'}, result:{state:'pending'}}}]});
      await new Promise(resolve => setTimeout(resolve, 110));
      return host.text.textContent;
    }};
  };
  const th = render('th'), en = render('');
  const thText = await th.show({until:Date.now() + 4200});
  assert.match(thText, /เซิร์ฟเวอร์มีคนใช้เยอะ — รอ 5 วิ แล้วทำต่อให้อัตโนมัติ/, thText);
  assert(thText.indexOf('เซิร์ฟเวอร์มีคนใช้เยอะ') < thText.indexOf('คำขอ AI'), 'the wait is named before the queue text');
  assert.match(await en.show({until:Date.now() + 9100}), /Server busy — waiting 10s before continuing/);
  // The 500 ms tick counts down between updates (whole seconds: ≤ 1 change/s).
  await th.show({until:Date.now() + 1900});
  assert.match(th.host.text.textContent, /รอ 2 วิ/);
  await new Promise(resolve => setTimeout(resolve, 1000));
  th.tick();
  assert.match(th.host.text.textContent, /รอ 1 วิ/, 'the countdown advances without a new update');
  assert.doesNotMatch(await th.show(null), /เซิร์ฟเวอร์มีคนใช้เยอะ/, 'cleared when the work resumes');
  assert.doesNotMatch(await th.show({until:Date.now() - 1}), /เซิร์ฟเวอร์มีคนใช้เยอะ/, 'an elapsed wait is not shown');
  ok('page status shows the Thai/English install wait with a countdown and clears it');
}
console.log(`${checks} checks passed`);
