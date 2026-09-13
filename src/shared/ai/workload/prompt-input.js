import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../../../generated/canonical-prompt-plans.js";
import { normalizeLanguageCode } from "../../../generated/language-code-aliases.js";
import { composeCanonicalPrompt, composeTranslationUserMessage, composeTranslatorIdentitySystem } from "../direct-local/prompt.js";
import { exactOutputInstruction } from "../direct-local/output-contract.js";
import { selectPageContext, pageContextText } from "../page-context.js";
import { textWeight } from "./model.js";

// Estimate the live message bodies, not style plus an arbitrary task allowance.
// Source text and per-record/schema overhead are counted by estimateRequest.
export function createPromptInputEstimator({ ai = {}, targetLang = "", image = false, contract = "" } = {}) {
  const plan = BUNDLED_CANONICAL_PROMPT_PLANS[normalizeLanguageCode(targetLang) || "en"];
  const structuredOutput = /schema|json/i.test(contract);
  const composed = composeCanonicalPrompt(plan, { ...ai, page_context: [] }, image, structuredOutput, targetLang);
  const system = composeTranslatorIdentitySystem(`${composed.sections.language}\n${composed.sections.style}`);
  const fixedByCount = new Map();
  return (units, allUnits = units) => {
    const count = Math.max(1, units.length);
    if (!fixedByCount.has(count)) {
      const expectedIds = Array.from({ length: count }, (_, index) => `P${index}`);
      const user = composeTranslationUserMessage({
        sections: { ...composed.sections, source: structuredOutput
          ? "INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text." : composed.sections.source },
        requestOutputContract: exactOutputInstruction(expectedIds, { kind: structuredOutput ? "schema_object" : "compact_records" }, targetLang),
        sourceRecords: "", targetLang, repairReason: ai.repair_reason, expectedIds, structuredOutput,
      });
      fixedByCount.set(count, textWeight(system) + textWeight(user) + 16 + (image ? 2048 : 0));
    }
    const context = pageContextText(selectPageContext(allUnits, units));
    // Page evidence is the only variable runtime block. Reserve its wrapper too
    // when there was no other context in the composed message.
    const contextWeight = context ? textWeight(context) +
      (composed.sections.runtime ? 1 : textWeight("CONTEXT — READ ONLY, DO NOT TRANSLATE\n")) : 0;
    return fixedByCount.get(count) + contextWeight;
  };
}
