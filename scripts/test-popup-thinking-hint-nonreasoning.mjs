import assert from 'node:assert/strict';
import { createPopupUiController } from '../src/popup/controllers/popup-ui-controller.js';

const reasoning={supported:false,mandatory:false,control:'none',supported_efforts:[],
  source:'ollama-api-show'};
const select={value:'on',options:[]};
const els={
  aiProvider:{value:'ollama'},aiBaseUrl:{value:'http://localhost:11434'},
  aiModel:{value:'fixture'},aiKey:{value:''},mode:{value:'lens_text'},sources:{value:'ai'},
  aiThinking:select,aiThinkingHint:{textContent:''},aiThinkingWrap:{style:{}},
};
const state={localAiCapability:{provider:'ollama',baseUrl:'http://localhost:11434',
  models:{fixture:{reasoning}}}};
const ui=createPopupUiController({els,state,isLocalProvider:provider=>provider==='ollama',
  toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}});

for(const requested of ['on','low','medium']){
  select.value=requested;
  ui.toggle();
  assert.equal(select.value,requested,'capability refresh must retain the saved explicit mode');
  assert.ok(select.options.some(option=>option.value===requested),'saved mode remains editable');
  assert.match(els.aiThinkingHint.textContent,/does not support reasoning/i);
  assert.match(els.aiThinkingHint.textContent,/configuration error/i);
  assert.match(els.aiThinkingHint.textContent,/choose Thinking off or Lowest available/i);
  assert.doesNotMatch(els.aiThinkingHint.textContent,/Execution is Off/i,
    'the hint must not claim an unsupported explicit mode executes as Off');
}
for(const requested of ['off','minimum']){
  select.value=requested;
  ui.toggle();
  assert.equal(select.value,requested);
  assert.match(els.aiThinkingHint.textContent,/Execution is Off/i);
  assert.doesNotMatch(els.aiThinkingHint.textContent,/configuration error/i,
    'supported Off and Lowest retain the plain-model hint');
}
for(const unknown of [null,{supported:null,control:'unknown',source:'ollama-api-show'}]){
  state.localAiCapability.models.fixture.reasoning=unknown;
  for(const requested of ['off','minimum','on']){
    select.value=requested;
    ui.toggle();
    assert.equal(select.value,requested,'unknown Ollama metadata cannot rewrite the saved choice');
    assert.match(els.aiThinkingHint.textContent,/Off and Lowest available try to turn thinking off/i);
    assert.match(els.aiThinkingHint.textContent,/reports an error if reasoning is returned/i);
    assert.doesNotMatch(els.aiThinkingHint.textContent,/Off requires verified control/i);
  }
}
const cloudEls={...els,aiProvider:{value:'openrouter'},aiKey:{value:'test-key'},
  aiThinking:{value:'minimum',options:[]},aiThinkingHint:{textContent:''},aiThinkingWrap:{style:{}}};
createPopupUiController({els:cloudEls,state:{lastAiResolve:null},isLocalProvider:()=>false,
  toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
assert.equal(cloudEls.aiThinking.value,'minimum');
assert.match(cloudEls.aiThinkingHint.textContent,/checks the selected Cloud model before translation/i);
assert.match(cloudEls.aiThinkingHint.textContent,/reports a configuration error/i);
assert.doesNotMatch(cloudEls.aiThinkingHint.textContent,/Lowest available uses the provider default/i);

const localEls={...els,aiProvider:{value:'jan'},aiBaseUrl:{value:'http://localhost:1337/v1'},
  aiThinking:{value:'minimum',options:[]},aiThinkingHint:{textContent:''},aiThinkingWrap:{style:{}}};
createPopupUiController({els:localEls,state:{localAiCapability:null},isLocalProvider:()=>true,
  toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
assert.equal(localEls.aiThinking.value,'minimum');
assert.match(localEls.aiThinkingHint.textContent,/Lowest available uses the runtime default, which may think/i,
  'unknown OpenAI-compatible Local controls remain provider-managed and unverified');
console.log('Popup verified non-reasoning hint preserves saved modes and reports unsupported explicit Thinking');
