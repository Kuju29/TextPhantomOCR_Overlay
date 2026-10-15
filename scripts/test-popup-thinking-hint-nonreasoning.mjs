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

// 10488 owner decision: a model whose live record proves no reasoning shows a
// disabled "Provider default" control. Every saved choice is kept unchanged.
for(const requested of ['on','low','medium','off','minimum']){
  select.value=requested;
  ui.toggle();
  assert.equal(select.value,requested,'capability refresh must retain the saved explicit mode');
  assert.equal(select.disabled,true,'no reasoning: the control is not clickable');
  assert.deepEqual(select.options.map(option=>option.textContent),['Provider default (this model has no AI think)']);
  assert.match(els.aiThinkingHint.textContent,/no AI think/i);
  assert.match(els.aiThinkingHint.textContent,/provider default/i);
  assert.doesNotMatch(els.aiThinkingHint.textContent,/configuration error/i,
    'a model without reasoning never reports a Thinking configuration error');
}
for(const unknown of [null,{supported:null,control:'unknown',source:'ollama-api-show'}]){
  state.localAiCapability.models.fixture.reasoning=unknown;
  for(const requested of ['off','minimum','on']){
    select.value=requested;
    ui.toggle();
    assert.equal(select.value,requested,'unknown Ollama metadata cannot rewrite the saved choice');
    assert.equal(select.disabled,true);
    assert.match(els.aiThinkingHint.textContent,/does not publish an AI think control/i);
    assert.match(els.aiThinkingHint.textContent,/provider default/i);
  }
}
const cloudEls={...els,aiProvider:{value:'openrouter'},aiKey:{value:'test-key'},
  aiThinking:{value:'minimum',options:[]},aiThinkingHint:{textContent:''},aiThinkingWrap:{style:{}}};
createPopupUiController({els:cloudEls,state:{lastAiResolve:null},isLocalProvider:()=>false,
  toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
assert.equal(cloudEls.aiThinking.value,'minimum');
assert.equal(cloudEls.aiThinking.disabled,true,'no Cloud record yet: Checking model…');
assert.match(cloudEls.aiThinkingHint.textContent,/appear after the selected model is checked/i);
assert.doesNotMatch(cloudEls.aiThinkingHint.textContent,/provider default/i,
  'a missing record is never presented as the provider default');

const localEls={...els,aiProvider:{value:'jan'},aiBaseUrl:{value:'http://localhost:1337/v1'},
  aiThinking:{value:'minimum',options:[]},aiThinkingHint:{textContent:''},aiThinkingWrap:{style:{}}};
createPopupUiController({els:localEls,state:{localAiCapability:null},isLocalProvider:()=>true,
  toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
assert.equal(localEls.aiThinking.value,'minimum');
assert.equal(localEls.aiThinking.disabled,true);
assert.match(localEls.aiThinkingHint.textContent,/appear after the selected model is checked/i,
  'an unchecked OpenAI-compatible Local model is loading, not default');
console.log('Popup no-reasoning and unknown models show a disabled provider-default AI think control and keep saved modes');
