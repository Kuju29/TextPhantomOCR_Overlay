import assert from 'node:assert/strict';
import { createPromptInputEstimator } from '../src/shared/ai/workload/prompt-input.js';
import { textWeight, estimateRequest, initialProfile } from '../src/shared/ai/workload/model.js';
import { BUNDLED_CANONICAL_PROMPT_PLANS } from '../src/generated/canonical-prompt-plans.js';
import { composeCanonicalPrompt, composeTranslationUserMessage, composeTranslatorIdentitySystem } from '../src/shared/ai/direct-local/prompt.js';
import { exactOutputInstruction, translationObjectSchema } from '../src/shared/ai/direct-local/output-contract.js';
import { selectPageContext } from '../src/shared/ai/page-context.js';

const page = [{ id: 'pageA', text: 'FOR ME TO MAKE ASSUMPTIONS ABOUT IT...' },
  { id: 'pageB', text: 'FEELS DISRESPECTFUL TO BOTH OF THEM...' }];
let checks = 0;
for (const targetLang of ['th', 'en', 'ja']) for (const structured of [false, true]) {
  for (const prompt of ['', 'Use terse, faithful dialogue.']) for (const memory of [false, true]) {
    const ai = { prompt, ...(memory ? { series_state: 'A disagreement between friends.',
      characters: [{ name: 'Anna', speech: 'reserved' }], glossary: [{ src: 'Anna', tgt: 'Anna' }],
      prev_context: [{ src: 'What happened?' }], repair_reason: 'wrong_language' } : {}) };
    const kind = structured ? 'schema_object' : 'compact_records';
    const estimator = createPromptInputEstimator({ ai, targetLang, contract: kind });
    const units = page.slice(1), ids = ['P0'];
    const composed = composeCanonicalPrompt(BUNDLED_CANONICAL_PROMPT_PLANS[targetLang],
      { ...ai, page_context: selectPageContext(page, units) }, false, structured, targetLang);
    const system = composed.system;
    const user = composeTranslationUserMessage({ sections: { ...composed.sections, source: structured
      ? 'INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text.' : composed.sections.source },
      requestOutputContract: exactOutputInstruction(ids, { kind }, targetLang),
      sourceRecords: structured ? `P0:${units[0].text}` : `<<TP_P0:${units[0].text}>>`,
      targetLang, expectedIds: ids, structuredOutput: structured, repairReason: ai.repair_reason });
    const actualWeight = textWeight(system) + textWeight(user) +
      (structured ? textWeight(JSON.stringify(translationObjectSchema(ids))) : 0);
    const estimated = estimateRequest(units, initialProfile(), { contract: kind, limits: {},
      reasoningActive: false, fixedInput: 0, estimateFixedInput: values => estimator(values, page) });
    assert.ok(estimated.estimatedInput >= actualWeight, `${targetLang}/${kind}/${prompt || 'builtin'}/${memory}: undercount`);
    assert.ok(estimator(units, page) > estimator(units, units), 'neighbor source must reserve input');
    checks++;
  }
}
const builtIn = createPromptInputEstimator({ targetLang: 'th' })(page);
assert.ok(builtIn > 512, 'full built-in style/examples must replace old constant allowance');
const conversationAnchor = createPromptInputEstimator({ ai: { translation_mode: 'conversation', style_examples: false }, targetLang: 'th' })(page);
const conversationWithExamples = createPromptInputEstimator({ ai: { translation_mode: 'conversation', style_examples: true }, targetLang: 'th' })(page);
const independentNoExamples = createPromptInputEstimator({ ai: { translation_mode: 'independent', style_examples: false }, targetLang: 'th' })(page);
const localOllama={provider:'ollama',translation_mode:'independent',style_examples:true};
const apiLocalEstimate=createPromptInputEstimator({ai:localOllama,route:'server',targetLang:'th'})(page);
const directLocalEstimate=createPromptInputEstimator({ai:localOllama,route:'direct-local',targetLang:'th'})(page);
assert.equal(apiLocalEstimate,directLocalEstimate,
  'API and Direct Local Independent send the same four human examples');
assert.ok(createPromptInputEstimator({ai:{...localOllama,provider:'openai'},route:'server',targetLang:'th'})(page)>apiLocalEstimate,
  'Cloud Independent retains its twenty-example prompt');
assert.ok(createPromptInputEstimator({ai:{...localOllama,translation_mode:'conversation'},route:'server',targetLang:'th'})(page)>apiLocalEstimate,
  'Local Conversation retains its twenty-example prompt');
assert.ok(createPromptInputEstimator({ai:localOllama,targetLang:'th'})(page)>apiLocalEstimate,
  'unknown routes retain the conservative twenty-example estimate');
const explicit={...localOllama,independent_examples:{source:'human',humanExampleCount:7}};
assert.ok(createPromptInputEstimator({ai:explicit,route:'direct-local',targetLang:'th'})(page)>directLocalEstimate,
  'explicit Direct Local example selection takes precedence over its four-example default');
assert.equal(createPromptInputEstimator({ai:explicit,route:'server',targetLang:'th'})(page),apiLocalEstimate,
  'the API ignores extension-only example selection and still sends its four built-in examples');
assert.equal(createPromptInputEstimator({ai:{...localOllama,independent_examples:{source:'story',pairs:[{source:'UNSENT',translation:'UNSENT'}]}},route:'server',targetLang:'th'})(page),apiLocalEstimate,
  'stale extension-only story selection cannot make the API estimate smaller than its actual prompt');
assert.ok(conversationWithExamples > conversationAnchor, 'Conversation input estimation must omit disabled examples');
assert.ok(conversationAnchor >= independentNoExamples, 'Conversation record protocol must still reserve its input');
const oneRecord = [{id:'I1_P0',text:'HELLO'}];
const narrowConversation = estimateRequest(oneRecord,initialProfile(),{
  contract:'compact_records',limits:{contextTokens:8192,maxOutputTokens:4096},reasoningActive:false,
  fixedInput:0,estimateFixedInput:createPromptInputEstimator({ai:{translation_mode:'conversation'},targetLang:'th'})});
assert.equal(narrowConversation.fitsHard,false,'a verified narrow context must reject the full fixed anchor before provider dispatch');
const tooSmall = estimateRequest(page, initialProfile(), { contract: 'compact_records',
  limits: { maxInputTokens: 1000 }, reasoningActive: false, fixedInput: 0,
  estimateFixedInput: createPromptInputEstimator({ targetLang: 'th' }) });
assert.equal(tooSmall.fitsHard, false, 'small input ceiling rejects before dispatch even when ai.prompt is empty');
console.log(`PASS ${checks} composed prompt budget cases across TH/EN/JA, marker/JSON, built-in/custom, memory/repair; context and small-window guards.`);
