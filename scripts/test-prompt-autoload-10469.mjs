// .69 owner request: switching to a model/language with no saved Set prompt
// loads the built-in style by itself (no manual Reload). Never overwrites an
// edit in progress, asks once per key, and an unreachable API shows no error.
import assert from 'node:assert/strict';
const disk = {};
globalThis.chrome = {runtime:{lastError:null},storage:{local:{
  get(keys,cb){const out=keys==null?{...disk}:Object.fromEntries([].concat(keys).map(k=>[k,disk[k]]));cb?.(out);return Promise.resolve(out);},
  set(v,cb){Object.assign(disk,v);cb?.();return Promise.resolve();},remove(k,cb){[].concat(k).forEach(x=>delete disk[x]);cb?.();return Promise.resolve();}}}};
const {createPromptController} = await import('../src/popup/controllers/prompt-controller.js');
const listeners = () => ({addEventListener(){}});
const els = {aiPrompt:{value:'',...listeners()},lang:{value:'th',...listeners()},apiUrl:{value:'http://api.test',...listeners()},
  aiPromptWrap:{},aiProvider:listeners(),aiModel:listeners(),aiBaseUrl:listeners()};
const state = {desiredLang:'th',desiredAiModel:'model-a',aiPromptByLang:{},aiPromptDirtyByLang:{},promptSeq:0};
let fetches = 0, reply = 'BUILT-IN STYLE', saved = [], messages = [];
const controller = createPromptController({els,state,canUseAiUi:()=>true,
  fetchDefaultPrompt:async(_base,lang,model)=>{fetches++;return reply === null ? null : `${reply} ${lang}/${model}`;},
  setStorage:async()=>{},broadcast:()=>{},updatePromptCount:()=>{},
  setFieldMessage:(_w,type,text)=>messages.push([type,text]),fieldMessageType:()=>'',
  keyForPrompt:(lang,model)=>`${model}|${lang}`,saveProfilePrompt:async(lang,text)=>saved.push([lang,text])});
const settle = () => new Promise(r => setTimeout(r, 20));

controller.applyForLang('th'); await settle();
assert.equal(els.aiPrompt.value, 'BUILT-IN STYLE th/model-a', 'unused model loads its default without Reload');
assert.deepEqual(saved, [['th','BUILT-IN STYLE th/model-a']]);
assert.equal(fetches, 1);

// A model that already has a saved prompt keeps it and does not fetch.
state.desiredAiModel = 'model-b'; state.aiPromptByLang['model-b|th'] = {text:'MY OWN STYLE',mode:'replace'};
controller.applyForLang('th'); await settle();
assert.equal(els.aiPrompt.value, 'MY OWN STYLE'); assert.equal(fetches, 1);

// An edit in progress is never replaced.
state.desiredAiModel = 'model-c'; state.aiPromptDirtyByLang['model-c|th'] = true; els.aiPrompt.value = 'typing…';
controller.applyForLang('th'); await settle();
assert.equal(els.aiPrompt.value, 'typing…'); assert.equal(fetches, 1);

// API unreachable: no error banner (the built-in style is still used), asked once per key.
state.desiredAiModel = 'model-d'; reply = null; messages = [];
controller.applyForLang('th'); await settle(); controller.applyForLang('th'); await settle();
assert.equal(fetches, 2, 'one automatic attempt per model/language');
assert.ok(!messages.some(([type]) => type === 'error'), 'automatic load failure shows no error');
console.log('PASS Set prompt auto-loads the default for an unused model; saved prompts and edits are kept');
