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
    const system = composeTranslatorIdentitySystem(`${composed.sections.language}\n${composed.sections.style}`);
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
const tooSmall = estimateRequest(page, initialProfile(), { contract: 'compact_records',
  limits: { maxInputTokens: 1000 }, reasoningActive: false, fixedInput: 0,
  estimateFixedInput: createPromptInputEstimator({ targetLang: 'th' }) });
assert.equal(tooSmall.fitsHard, false, 'small input ceiling rejects before dispatch even when ai.prompt is empty');
console.log(`PASS ${checks} composed prompt budget cases across TH/EN/JA, marker/JSON, built-in/custom, memory/repair; context and small-window guards.`);
