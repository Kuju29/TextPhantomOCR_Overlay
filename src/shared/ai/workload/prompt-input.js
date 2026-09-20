import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../../../generated/canonical-prompt-plans.js";
import { normalizeLanguageCode } from "../../../generated/language-code-aliases.js";
import { composeCanonicalPrompt, composeTranslationUserMessage } from "../direct-local/prompt.js";
import { exactOutputInstruction } from "../direct-local/output-contract.js";
import { selectPageContext, pageContextText } from "../page-context.js";
import { sourceContextText } from "../source-context.js";
import { textWeight } from "./model.js";
import { instructionPack } from "../prompt-language.js";

// Estimate the live message bodies, not style plus an arbitrary task allowance.
// Source text and per-record/schema overhead are counted by estimateRequest.
export function createPromptInputEstimator({ ai = {}, targetLang = "", sourceLang = "", image = false, contract = "" } = {}) {
  const plan = BUNDLED_CANONICAL_PROMPT_PLANS[normalizeLanguageCode(targetLang) || "en"];
  const structuredOutput = /schema|json/i.test(contract);
  const conversation = ai?.translation_mode === "conversation";
  const styleExamples = conversation ? false : ai?.style_examples !== false;
  const composed = composeCanonicalPrompt(plan, { ...ai, style_examples: styleExamples, page_context: [], source_context: [] }, image, structuredOutput, targetLang);
  const system = composed.system;
  const fixedByCount = new Map();
  return (units, allUnits = units, capturedContext = ai.source_context) => {
    const count = Math.max(1, units.length);
    if (!fixedByCount.has(count)) {
      const expectedIds = Array.from({ length: count }, (_, index) => conversation ? `I1_P${index}` : `P${index}`);
      const user = composeTranslationUserMessage({
        sections: { ...composed.sections, source: structuredOutput
          ? "INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text." : composed.sections.source },
        requestOutputContract: exactOutputInstruction(expectedIds, { kind: structuredOutput ? "schema_object" : "compact_records" }, targetLang),
        sourceRecords: "", targetLang, sourceLang, repairReason: ai.repair_reason, expectedIds, structuredOutput,
        conversationRecords: conversation,
      });
      fixedByCount.set(count, textWeight(system) + textWeight(user) + 16 + (image ? 2048 : 0));
    }
    let context;
    try {
      context = [capturedContext ? "" : pageContextText(selectPageContext(allUnits, units), targetLang),
        sourceContextText(capturedContext, units, targetLang,
          conversation && units.every(unit => /^I[1-9][0-9]{0,6}_P[0-9]{1,6}$/.test(String(unit.id)))
            ? units.map(unit => String(unit.id)) : null)].filter(Boolean).join("\n\n");
    } catch (error) {
      // Let the existing packer choose a smaller prefix. Never discard source
      // evidence merely to make an over-large repair batch fit.
      if (error.message === "source_context_budget_exceeded") return Infinity;
      throw error;
    }
    // Page evidence is the only variable runtime block. Reserve its wrapper too
    // when there was no other context in the composed message.
    const contextWeight = context ? textWeight(context) +
      (composed.sections.runtime ? 1 : textWeight(instructionPack(targetLang).contextHeading + "\n")) : 0;
    return fixedByCount.get(count) + contextWeight;
  };
}
