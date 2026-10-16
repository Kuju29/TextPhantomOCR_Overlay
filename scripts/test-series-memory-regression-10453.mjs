/** Production series derivation, writer queue, popup and message handler.
 * Only browser/storage surfaces are synthetic; no provider calls or summaries.
 * TP_SERIES_TEST_SOURCE permits an immutable baseline checkout for red proof.
 */
import assert from 'node:assert/strict';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(process.env.TP_SERIES_TEST_SOURCE || dirname(fileURLToPath(import.meta.url)) + '/..');
const source = path => pathToFileURL(resolve(root, 'src', path)).href;
const deferred = () => {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return {promise, resolve:resolvePromise};
};
const waitFor = async (condition, message) => {
  for (let turn=0;turn<64;turn++) {
    if (condition()) return;
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
};
let storage = {}, failReads = false, failWrites = false, blockedWrite = null, serial = 0;
const listeners = [];
function complete(callback, value, failed) {
  if (failed) chrome.runtime.lastError = {message:'Synthetic storage unavailable'};
  try { callback?.(value); } finally { delete chrome.runtime.lastError; }
}
globalThis.chrome = {
  runtime:{id:'series-fixture',getManifest:()=>({version:'2026.10.4.53'}),
    getURL:path=>'chrome-extension://series-fixture/'+path,
    onMessage:{addListener:fn=>listeners.push(fn)}},
  storage:{local:{
    get(keys, callback) {
      const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(storage);
      const value = Object.fromEntries(names.map(key=>[key,structuredClone(storage[key])]));
      complete(callback,value,failReads);
    },
    set(patch, callback) {
      const copy = structuredClone(patch);
      const finish = () => {
        if (!failWrites) Object.assign(storage,copy);
        complete(callback,undefined,failWrites);
      };
      if (blockedWrite) {
        const blocked = blockedWrite; blockedWrite = null;
        blocked.release = finish; blocked.started.resolve();
      } else finish();
    },
  }},
};
const series = await import(source('shared/series.js'));
const storageApi = await import(source('shared/storage.js'));
const popup = await import(source('popup/controllers/series-memory-controller.js'));
let messages = null;
try { messages = await import(source('background/series-memory-messages.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const bg = async () => import(source('background/series-memory.js') + '?series-test=' + ++serial);
const scoped = (key, target) => typeof series.seriesMemoryKey === 'function'
  ? series.seriesMemoryKey(key,target) : key;
const sender = {id:chrome.runtime.id,url:chrome.runtime.getURL('popup/popup.html')};
const fresh = all => { storage = {aiSeriesMemory:structuredClone(all || {})}; failReads = failWrites = false; blockedWrite = null; };
const result = (target, batch='batch-fixture') => ({Ai:{glossary:[{src:'主人公',tgt:target}],meta:{batchId:batch,pageIndex:0}},
  lensDocument:{paragraphs:[{text:'こんにちは',aiText:target}]}});
const memory = target => ({glossary:[{src:'主人公',tgt:target}],characters:[],state:'',prevContext:[],pageContexts:{},visionPages:0});
const empty = value => !value.glossary.length && !value.characters.length && !value.prevContext.length && !value.state;
const checks = [], failures = [];
async function check(name, action) {
  try { await action(); checks.push({name,passed:true}); }
  catch (error) { checks.push({name,passed:false,error:error.message}); failures.push(name); }
}
function popupFixture({tab={id:1,url:'https://reader.test/manga/alpha/chapter-1',title:'Alpha Chapter 1'},target='th',query,send}={}) {
  const clicks = new Map();
  const state = {seriesKey:'default',desiredLang:target,seriesMemory:{glossary:[],characters:[]}};
  const els = {lang:{value:target},aiCharactersCount:{textContent:''},aiCharactersClear:{disabled:false,
    addEventListener:(name,fn)=>clicks.set(name,fn)}};
  const controller = popup.createSeriesMemoryController({els,state,getStorage:storageApi.getStorage,setStorage:storageApi.setStorage,
    queryTabs:query || (async()=>[tab]),sendMessage:async message=>{
      assert(messages?.handleSeriesMemoryMessage,'Worker memory message handler must exist');
      const actualSend=value=>messages.handleSeriesMemoryMessage(value,sender);
      return send ? send(message,actualSend) : actualSend(message);
    }});
  controller.bind();
  return {controller,state,els,click:()=>clicks.get('click')()};
}

await check('Numeric title IDs identify different series',async()=>{
  const a = series.seriesKeyFromUrl('https://reader.test/title/1234/chapter-1');
  const b = series.seriesKeyFromUrl('https://reader.test/title/5678/chapter-1');
  assert.notEqual(a,b);
  assert.match(a,/\/title\/1234(?:\/|$)/);
});
await check('Chapters of one numeric manga keep the same series ID',async()=>{
  const a = series.seriesKeyFromUrl('https://reader.test/manga/1234/chapter-1');
  const b = series.seriesKeyFromUrl('https://reader.test/manga/1234/chapter-92/page-2');
  assert.equal(a,b); assert.match(a,/\/manga\/1234(?:\/|$)/);
});
await check('UUID immediately following a series route remains a series identity',async()=>{
  const a = series.seriesKeyFromUrl('https://reader.test/series/12345678-1234-4123-8123-123456789abc/chapter-1');
  const b = series.seriesKeyFromUrl('https://reader.test/series/87654321-1234-4123-8123-123456789abc/chapter-1');
  assert.notEqual(a,b); assert.match(a,/12345678-1234-4123-8123-123456789abc/);
});
await check('Numeric chapter/page routes are excluded from series identity',async()=>{
  assert.equal(series.seriesKeyFromUrl('https://reader.test/chapter/1234'),'reader.test');
  assert.equal(series.seriesKeyFromUrl('https://reader.test/page/88'),'reader.test');
  assert.equal(series.seriesKeyFromUrl('https://reader.test/manga/alpha/chapter/1234'),'reader.test/manga/alpha');
});
await check('Scoped memory keys separate targets while preserving legacy key access',async()=>{
  assert.equal(typeof series.seriesMemoryKey,'function');
  assert.notEqual(series.seriesMemoryKey('reader.test/manga/alpha','th'),series.seriesMemoryKey('reader.test/manga/alpha','en'));
  assert.equal(series.seriesMemoryKey('reader.test/manga/alpha'),'reader.test/manga/alpha');
});
await check('Actual accumulator and reader isolate Thai and English glossary/snippets',async()=>{
  fresh(); const module = await bg(), key='reader.test/manga/alpha';
  await module.accumulateSeriesMemory(key,result('พระเอก'),'th');
  await module.accumulateSeriesMemory(key,result('Hero'),'en');
  const thai = await module.getSeriesMemory(key,'th'), english = await module.getSeriesMemory(key,'en');
  assert.equal(thai.glossary[0].tgt,'พระเอก'); assert.equal(english.glossary[0].tgt,'Hero');
  assert.equal(thai.prevContext[0].tgt,'พระเอก'); assert.equal(english.prevContext[0].tgt,'Hero');
  assert.notEqual(scoped(key,'th'),scoped(key,'en'));
});
await check('Production AI payload builder reads memory for the effective target language',async()=>{
  fresh(); const module=await bg(), key='reader.test/manga/alpha';
  await module.accumulateSeriesMemory(key,result('พระเอก'),'th');
  await module.accumulateSeriesMemory(key,result('Hero'),'en');
  const {buildAiPayload}=await import(source('background/context-menu.js'));
  const settings={lang:'th',aiProvider:'openrouter',aiModel:'fixture',aiPageImage:'off',aiMemoryMode:'full',aiThinking:'off'};
  const thai=await buildAiPayload('lens_text','ai',settings,key);
  const english=await buildAiPayload('lens_text','ai',settings,key,'en');
  assert.equal(thai.glossary[0].tgt,'พระเอก'); assert.equal(thai.prev_context[0].tgt,'พระเอก');
  assert.equal(english.glossary[0].tgt,'Hero'); assert.equal(english.prev_context[0].tgt,'Hero');
});
await check('Actual page pipeline refreshes prior-chapter context for its requested target',async()=>{
  fresh(); const module=await bg(), key='reader.test/manga/alpha';
  await module.accumulateSeriesMemory(key,result('พระเอก'),'th');
  await module.accumulateSeriesMemory(key,result('Hero'),'en');
  const {translateLensPage}=await import(source('background/pipeline/page-translation.js'));
  for (const [target,expected] of [['th','พระเอก'],['en','Hero']]) {
    let prepared;
    const stop=new Error('Stopped at the actual prepared checkpoint before provider dispatch');
    await assert.rejects(translateLensPage({base:'http://fixture.invalid',payload:{lang:target,
      context:{series_key:key,page_index:0},metadata:{image_id:'series-fixture-'+target}},
      result:{lensDocument:{schema:'tp.lens-document/1',image:{width:100,height:100},
        languages:{source:'en',target},paragraphs:[{id:'p0',sourceText:'Hello there',items:[]}]},
        eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},
      plan:{route:'server',ai:{provider:'login',model:'fixture',translation_mode:'conversation',memory_mode:'full'}},
      conversationSubmit:()=>{assert.fail('Memory checkpoint test must not dispatch to a provider');},
      onCheckpoint:async event=>{if(event.stage === 'prepared'){prepared=event.plan.ai;throw stop;}}}),error=>error===stop);
    assert.equal(prepared.glossary[0].tgt,expected);
    assert.equal(prepared.prev_context[0].tgt,expected,'First chapter page must preserve prior-chapter excerpts');
  }
});
await check('Ambiguous legacy memory is not silently adopted into target scopes',async()=>{
  const key='reader.test/manga/alpha'; fresh({[key]:memory('Legacy Thai')}); const module=await bg();
  assert(empty(await module.getSeriesMemory(key,'en')));
  assert(empty(await module.getSeriesMemory(key,'th')));
  assert.equal((await module.getSeriesMemory(key)).glossary[0].tgt,'Legacy Thai');
});
await check('Queued clear follows blocked accumulation and preserves unrelated target/series',async()=>{
  const key='reader.test/manga/alpha', other='reader.test/manga/beta';
  fresh({[scoped(key,'en')]:memory('English'),[scoped(other,'th')]:memory('Other Thai')});
  const module=await bg(), blocked={started:deferred(),release:null}; blockedWrite=blocked;
  const accumulate=module.accumulateSeriesMemory(key,result('New Thai'),'th');
  await blocked.started.promise;
  if (typeof module.clearSeriesMemory !== 'function') {
    blocked.release(); await accumulate; assert.fail('Queued clearSeriesMemory API must exist');
  }
  const clear=module.clearSeriesMemory(key,'th');
  blocked.release(); await Promise.all([accumulate,clear]);
  assert(empty(await module.getSeriesMemory(key,'th')));
  assert.equal((await module.getSeriesMemory(key,'en')).glossary[0].tgt,'English');
  assert.equal((await module.getSeriesMemory(other,'th')).glossary[0].tgt,'Other Thai');
});
await check('Storage read errors propagate instead of becoming an empty memory',async()=>{
  fresh(); const module=await bg(); failReads=true;
  try { await assert.rejects(module.getSeriesMemory('reader.test/manga/alpha','th')); }
  finally { failReads=false; }
});
await check('Worker memory handler requires an extension popup sender',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function'); fresh();
  const response=await messages.handleSeriesMemoryMessage({type:'TP_CLEAR_SERIES_MEMORY',seriesKey:'reader.test/manga/alpha',targetLang:'th'},
    {id:chrome.runtime.id,url:'https://reader.test/manga/alpha',tab:{id:2}});
  assert.notEqual(response?.ok,true);
});
await check('Worker clear reports write failure and its queue recovers',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Preserved Thai')}); failWrites=true;
  const failed=await messages.handleSeriesMemoryMessage({type:'TP_CLEAR_SERIES_MEMORY',seriesKey:key,targetLang:'th'},sender);
  failWrites=false; assert.equal(failed?.ok,false);
  assert.equal(storage.aiSeriesMemory[scoped(key,'th')].glossary[0].tgt,'Preserved Thai');
  const cleared=await messages.handleSeriesMemoryMessage({type:'TP_CLEAR_SERIES_MEMORY',seriesKey:key,targetLang:'th'},sender);
  assert.equal(cleared?.ok,true); assert(!storage.aiSeriesMemory[scoped(key,'th')]);
});
await check('Popup shows snippet-only memory as existing memory',async()=>{
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:{glossary:[],characters:[],state:'',
    prevContext:[{src:'こんにちは',tgt:'สวัสดี'}],pageContexts:{},visionPages:0}});
  const fixture=popupFixture(); await fixture.controller.refresh();
  assert.doesNotMatch(fixture.els.aiCharactersCount.textContent,/no memory/i);
  assert.match(fixture.els.aiCharactersCount.textContent,/\b1\s+(?:context|snippet|excerpt|page)/i);
  assert.equal(fixture.state.seriesMemory.prevContext.length,1);
});
await check('Popup displays a saved series state without inventing character/glossary entries',async()=>{
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:{glossary:[],characters:[],state:'Stored fixture scene',prevContext:[]}});
  const fixture=popupFixture(); await fixture.controller.refresh();
  assert.doesNotMatch(fixture.els.aiCharactersCount.textContent,/no memory/i);
  assert.match(fixture.els.aiCharactersCount.textContent,/saved context|state|summary|scene/i);
  assert.equal(fixture.state.seriesMemory.state,'Stored fixture scene');
  assert.equal(fixture.state.seriesMemory.characters.length,0);
});
await check('Popup read error is visible instead of claiming there is no memory',async()=>{
  fresh(); const fixture=popupFixture(); failReads=true;
  try { await fixture.controller.refresh(); }
  finally { failReads=false; }
  assert.match(fixture.els.aiCharactersCount.textContent,/could not|unavailable|failed|error|cannot|unable/i);
  assert.doesNotMatch(fixture.els.aiCharactersCount.textContent,/no memory/i);
});
await check('Popup failed clear preserves stored memory and displays the error',async()=>{
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Preserved Thai')});
  const fixture=popupFixture(); await fixture.controller.refresh(); failWrites=true;
  try { await fixture.click(); } finally { failWrites=false; }
  assert.equal(storage.aiSeriesMemory[scoped(key,'th')].glossary[0].tgt,'Preserved Thai');
  assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'Preserved Thai');
  assert.match(fixture.els.aiCharactersCount.textContent,/could not|unavailable|failed|error|cannot|unable/i);
});
await check('Late refresh cannot replace a newer tab and target language',async()=>{
  const a='reader.test/manga/alpha', b='reader.test/manga/beta';
  fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'en')]:memory('English Beta')});
  const pending=deferred(); let calls=0;
  const fixture=popupFixture({query:()=>++calls===1 ? pending.promise : Promise.resolve([{id:2,url:'https://reader.test/manga/beta/chapter-2',title:'Beta Chapter 2'}])});
  const old=fixture.controller.refresh(); fixture.state.desiredLang='en'; fixture.els.lang.value='en';
  await fixture.controller.refresh();
  pending.resolve([{id:1,url:'https://reader.test/manga/alpha/chapter-1',title:'Alpha Chapter 1'}]); await old;
  assert.equal(fixture.state.seriesKey,b);
  assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'English Beta');
  assert.match(fixture.els.aiCharactersCount.textContent,/beta/i);
});
await check('Actual popup language-change event refreshes the newly selected target memory',async()=>{
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Thai Alpha'),[scoped(key,'en')]:memory('English Alpha')});
  const fixture=popupFixture(); await fixture.controller.refresh();
  const events=new Map();
  const field=(name,value='')=>({value,addEventListener:(type,fn)=>events.set(name+':'+type,fn)});
  const els={...fixture.els,mode:field('mode','lens_text'),sources:field('sources','ai'),apiUrl:field('apiUrl','http://fixture.invalid'),
    aiKey:field('aiKey'),aiModel:field('aiModel','fixture'),aiPrompt:field('aiPrompt'),resetApi:field('resetApi')};
  els.lang.addEventListener=(type,fn)=>events.set('lang:'+type,fn);
  const originalWindow=globalThis.window; globalThis.window={addEventListener(){}};
  let refreshes=0, refreshed;
  try {
    const {bindPopupEvents}=await import(source('popup/controllers/popup-event-controller.js'));
    bindPopupEvents({els,state:fixture.state,providerMetaController:{cancelSchedule(){},refresh(){}},
      toggleUi(){},canUseAiUi:()=>false,applyPromptForLang:async()=>{},
      refreshSeriesMemory:()=>{refreshes++; refreshed=fixture.controller.refresh(); return refreshed;}});
    els.lang.value='en'; await events.get('lang:change')();
    assert.equal(refreshes,1,'Changing target language must refresh its displayed memory immediately');
    await refreshed;
    assert.equal(fixture.state.desiredLang,'en');
    assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'English Alpha');
  } finally { if(originalWindow === undefined)delete globalThis.window;else globalThis.window=originalWindow; }
});
for (const transition of ['tab-change','same-tab-navigation']) {
  await check(`One pending refresh detects ${transition} without a second user refresh`,async()=>{
    assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
    const a='reader.test/manga/alpha',b='reader.test/manga/beta';
    fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'th')]:memory('Thai Beta')});
    let active={id:1,url:'https://reader.test/manga/alpha/chapter-1',title:'Alpha Chapter 1'},blocked=true;
    const started=deferred(),released=deferred();
    const fixture=popupFixture({query:async()=>[active],send:async(message,actualSend)=>{
      const reply=await actualSend(message);
      if(blocked && message.type === 'TP_GET_SERIES_MEMORY'){blocked=false;started.resolve();await released.promise;}
      return reply;
    }});
    const pending=fixture.controller.refresh(); await started.promise;
    active={id:transition === 'tab-change'?2:1,url:'https://reader.test/manga/beta/chapter-2',title:'Beta Chapter 2'};
    released.resolve(); await pending;
    await waitFor(()=>fixture.state.seriesKey===b,'A programmatic tab/URL change must trigger a fresh current-tab read');
    assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'Thai Beta');
    assert.match(fixture.els.aiCharactersCount.textContent,/beta/i);
  });
}
await check('Clear refuses a newly selected target whose memory has not been displayed',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Thai Alpha'),[scoped(key,'en')]:memory('English Alpha')});
  const sent=[],fixture=popupFixture({send:(message,actualSend)=>{sent.push(message);return actualSend(message);}});
  await fixture.controller.refresh();fixture.state.desiredLang='en';fixture.els.lang.value='en';await fixture.click();
  assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.equal(storage.aiSeriesMemory[scoped(key,'th')].glossary[0].tgt,'Thai Alpha');
  assert.equal(storage.aiSeriesMemory[scoped(key,'en')].glossary[0].tgt,'English Alpha');
});
await check('Clear during target refresh cannot write an unseen target scope',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Thai Alpha'),[scoped(key,'en')]:memory('English Alpha')});
  const sent=[],started=deferred(),released=deferred();
  const fixture=popupFixture({send:async(message,actualSend)=>{
    sent.push(message);const reply=await actualSend(message);
    if(message.type==='TP_GET_SERIES_MEMORY'&&message.targetLang==='en'){started.resolve();await released.promise;}
    return reply;
  }});
  await fixture.controller.refresh();fixture.state.desiredLang='en';fixture.els.lang.value='en';
  const pending=fixture.controller.refresh();await started.promise;
  try {await fixture.click();} finally {released.resolve();await pending;}
  assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.equal(storage.aiSeriesMemory[scoped(key,'en')].glossary[0].tgt,'English Alpha');
  assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'English Alpha');
});
await check('A failed refresh invalidates previous display authority for destructive clear',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const key='reader.test/manga/alpha'; fresh({[scoped(key,'th')]:memory('Thai Alpha')});
  const sent=[],fixture=popupFixture({send:(message,actualSend)=>{sent.push(message);return actualSend(message);}});
  await fixture.controller.refresh();failReads=true;
  try {await fixture.controller.refresh();} finally {failReads=false;}
  await fixture.click();
  assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.equal(storage.aiSeriesMemory[scoped(key,'th')].glossary[0].tgt,'Thai Alpha');
});
await check('Tab changed before clear dispatch preserves both scopes and refreshes the active tab',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const a='reader.test/manga/alpha',b='reader.test/manga/beta';
  fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'th')]:memory('Thai Beta')});
  const sent=[];let active={id:1,url:'https://reader.test/manga/alpha/chapter-1',title:'Alpha Chapter 1'};
  const fixture=popupFixture({query:async()=>[active],send:(message,actualSend)=>{sent.push(message);return actualSend(message);}});
  await fixture.controller.refresh();active={id:2,url:'https://reader.test/manga/beta/chapter-2',title:'Beta Chapter 2'};
  await fixture.click();
  await waitFor(()=>fixture.state.seriesKey===b,'Clear must refresh rather than clearing memory for an inactive tab');
  assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.equal(storage.aiSeriesMemory[scoped(a,'th')].glossary[0].tgt,'Thai Alpha');
  assert.equal(storage.aiSeriesMemory[scoped(b,'th')].glossary[0].tgt,'Thai Beta');
});
await check('Navigation after a valid clear dispatch cannot publish empty memory into the new tab',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const a='reader.test/manga/alpha',b='reader.test/manga/beta';
  fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'th')]:memory('Thai Beta')});
  let active={id:1,url:'https://reader.test/manga/alpha/chapter-1',title:'Alpha Chapter 1'};
  const started=deferred(),released=deferred();
  const fixture=popupFixture({query:async()=>[active],send:async(message,actualSend)=>{
    const reply=await actualSend(message);
    if(message.type==='TP_CLEAR_SERIES_MEMORY'){started.resolve();await released.promise;}
    return reply;
  }});
  await fixture.controller.refresh();const pending=fixture.click();await started.promise;
  active={id:1,url:'https://reader.test/manga/beta/chapter-2',title:'Beta Chapter 2'};
  released.resolve();await pending;
  await waitFor(()=>fixture.state.seriesKey===b,'A completed clear must refresh a different active page before publication');
  assert(!storage.aiSeriesMemory[scoped(a,'th')]);
  assert.equal(storage.aiSeriesMemory[scoped(b,'th')].glossary[0].tgt,'Thai Beta');
  assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'Thai Beta');
});
await check('New scoped retention evicts only scoped memory and preserves twelve legacy records',async()=>{
  assert.equal(typeof series.seriesMemoryKey,'function');
  const legacy=Object.fromEntries(Array.from({length:12},(_,index)=>[
    `reader.test/manga/legacy-${index}`,{...memory('Legacy '+index),at:index+1}]));
  fresh(legacy);const module=await bg();
  for(let index=0;index<13;index++) {
    await module.accumulateSeriesMemory(`reader.test/manga/new-${index}`,result('Scoped '+index),'th');
  }
  for(const [key,value] of Object.entries(legacy))assert.deepEqual(storage.aiSeriesMemory[key],value);
  const scopedKeys=Object.keys(storage.aiSeriesMemory).filter(key=>key.startsWith('tp-memory-v2:'));
  assert.equal(scopedKeys.length,12);
  assert(!storage.aiSeriesMemory[scoped('reader.test/manga/new-0','th')]);
  assert.equal(storage.aiSeriesMemory[scoped('reader.test/manga/new-12','th')].glossary[0].tgt,'Scoped 12');
});
await check('Generic read routes use distinct non-generic series titles',async()=>{
  const a=series.refineSeriesKeyWithTitle(series.seriesKeyFromUrl('https://reader.test/read/chapter-1'),'Alpha | Reader');
  const b=series.refineSeriesKeyWithTitle(series.seriesKeyFromUrl('https://reader.test/read/chapter-2'),'Beta | Reader');
  assert.notEqual(a,b);assert.match(a,/alpha/);assert.match(b,/beta/);
  assert.equal(series.seriesIdentityKnown(a),true);assert.equal(series.seriesIdentityKnown(b),true);
});
await check('A leading hostname label is not accepted as the fallback series title',async()=>{
  const a=series.refineSeriesKeyWithTitle(series.seriesKeyFromUrl('https://reader.test/read/chapter-1'),'reader.test | Alpha');
  const b=series.refineSeriesKeyWithTitle(series.seriesKeyFromUrl('https://reader.test/read/chapter-2'),'reader.test | Beta');
  assert.notEqual(a,b);assert.match(a,/alpha/);assert.match(b,/beta/);
});
await check('Children in a series name survives chapter-marker title cleanup',async()=>{
  assert.equal(series.seriesSlugFromTitle('Children of the Dawn - Chapter 12 | Reader','reader.test'),'children-of-the-dawn');
});
await check('An unresolved Reader-only page neither borrows nor accumulates website memory',async()=>{
  assert.equal(typeof series.seriesIdentityKnown,'function');
  const key=series.refineSeriesKeyWithTitle(series.seriesKeyFromUrl('https://reader.test/chapter/123'),'Reader');
  assert.equal(series.seriesIdentityKnown(key),false);
  const poisoned={[key]:memory('Legacy website memory'),[scoped(key,'th')]:memory('Scoped website memory')};
  fresh(poisoned);const module=await bg();
  const unknown=await module.getSeriesMemory(key,'th');assert(empty(unknown));assert.equal(unknown.identityKnown,false);
  await module.accumulateSeriesMemory(key,result('Must not become shared memory'),'th');
  assert.deepEqual(storage.aiSeriesMemory,poisoned);
  const {buildAiPayload}=await import(source('background/context-menu.js'));
  const ai=await buildAiPayload('lens_text','ai',{lang:'th',aiProvider:'openrouter',aiModel:'fixture',aiPageImage:'off',aiMemoryMode:'full'},key);
  assert.deepEqual(ai.glossary,[]);assert.deepEqual(ai.prev_context,[]);
  const sent=[],fixture=popupFixture({tab:{id:1,url:'https://reader.test/chapter/123',title:'Reader'},
    send:(message,actualSend)=>{sent.push(message);return actualSend(message);}});
  await fixture.controller.refresh();assert.equal(fixture.state.seriesMemory.identityKnown,false);
  // 10496: the same warning, now a small warning chip: "Series not recognised on this page — memory is not shared."
  assert.match(fixture.els.aiCharactersCount.textContent,/^Series not recognised on this page — memory is not shared\.$/);
  await fixture.click();assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.deepEqual(storage.aiSeriesMemory,poisoned);
});
await check('A same-tab same-URL title change invalidates a pending title-derived memory read',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const base=series.seriesKeyFromUrl('https://reader.test/');
  const a=series.refineSeriesKeyWithTitle(base,'Series Alpha | Reader'),b=series.refineSeriesKeyWithTitle(base,'Series Beta | Reader');
  fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'th')]:memory('Thai Beta')});
  let active={id:1,url:'https://reader.test/',title:'Series Alpha | Reader'},blocked=true;
  const started=deferred(),released=deferred();
  const fixture=popupFixture({query:async()=>[active],send:async(message,actualSend)=>{
    const reply=await actualSend(message);
    if(blocked&&message.type==='TP_GET_SERIES_MEMORY'){blocked=false;started.resolve();await released.promise;}
    return reply;
  }});
  const pending=fixture.controller.refresh();await started.promise;
  active={...active,title:'Series Beta | Reader'};released.resolve();await pending;
  await waitFor(()=>fixture.state.seriesKey===b,'Changed fallback title must cause a fresh series read');
  assert.equal(fixture.state.seriesMemory.glossary[0].tgt,'Thai Beta');
});
await check('A changed title-derived identity is checked before destructive clear dispatch',async()=>{
  assert.equal(typeof messages?.handleSeriesMemoryMessage,'function');
  const base=series.seriesKeyFromUrl('https://reader.test/');
  const a=series.refineSeriesKeyWithTitle(base,'Series Alpha | Reader'),b=series.refineSeriesKeyWithTitle(base,'Series Beta | Reader');
  fresh({[scoped(a,'th')]:memory('Thai Alpha'),[scoped(b,'th')]:memory('Thai Beta')});
  let active={id:1,url:'https://reader.test/',title:'Series Alpha | Reader'};const sent=[];
  const fixture=popupFixture({query:async()=>[active],send:(message,actualSend)=>{sent.push(message);return actualSend(message);}});
  await fixture.controller.refresh();active={...active,title:'Series Beta | Reader'};await fixture.click();
  await waitFor(()=>fixture.state.seriesKey===b,'Clear must reread a changed title identity instead of clearing the prior series');
  assert.equal(sent.filter(message=>message.type==='TP_CLEAR_SERIES_MEMORY').length,0);
  assert.equal(storage.aiSeriesMemory[scoped(a,'th')].glossary[0].tgt,'Thai Alpha');
  assert.equal(storage.aiSeriesMemory[scoped(b,'th')].glossary[0].tgt,'Thai Beta');
});

console.log(JSON.stringify({scope:'Actual production modules; synthetic browser/storage; no live provider or semantic summary',
  sourceRoot:root,total:checks.length,passed:checks.length-failures.length,failed:failures.length,checks},null,2));
assert.deepEqual(failures,[],'Series-memory production regressions must all pass');
