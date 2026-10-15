import {independentTranslation} from "./translation-paths/independent.js";
import {conversationTranslation} from "./translation-paths/conversation.js";
import { translateDirectLocalRoute } from "./routes/direct-local.js";
import { translateServerRoute } from "./routes/server.js";
import { hasMeaningfulAiSource } from "../../shared/ai-source-filter.js";
import { checkedOrigins } from "../../shared/ai/conversation/origins.js";

function filteredOptions(options, source, retained) {
  const ids = new Set(retained.map(row => String(row.id)));
  const ai = {...options.ai};
  if (ai.conversation?.origins) {
    const origins = checkedOrigins(ai.conversation.origins, source.map(row => String(row.id)));
    ai.conversation = {...ai.conversation, origins:origins.map(page => {
      const indices = page.unitIds.flatMap((id,index) => ids.has(id) ? [index] : []);
      return {...page,unitIds:indices.map(index => page.unitIds[index]),originalIds:indices.map(index => page.originalIds[index])};
    }).filter(page => page.unitIds.length)};
  }
  if (Array.isArray(ai.page_context)) ai.page_context = ai.page_context.filter(row => hasMeaningfulAiSource(row?.text));
  if (Array.isArray(ai.source_context)) ai.source_context = ai.source_context.map(group => ({...group,
    targetIds:(group.targetIds || []).filter(id => ids.has(String(id))),
    units:(group.units || []).filter(row => hasMeaningfulAiSource(row?.text)),
  })).filter(group => group.targetIds.length && group.units.length);
  return {...options,ai};
}

export function createTranslationService({
  directLocal = translateDirectLocalRoute,
  server = translateServerRoute,
} = {}) {
  return async function translateUnits(units, options = {}) {
    const route = options.route;
    if (!Array.isArray(units) || units.length === 0) {
      return {
        translations: [],
        missing: [],
        meta: { route, skipped: "no units" },
      };
    }
    const mode=options.ai?.translation_mode || "independent";
    if(!["conversation","independent"].includes(mode)) throw new Error("Invalid translation mode");
    let retained = [];
    const skippedUnitIds = [];
    for (const unit of units) {
      if (hasMeaningfulAiSource(unit?.text)) retained.push(unit);
      else skippedUnitIds.push(String(unit?.id || ''));
    }
    if (!skippedUnitIds.length) retained = units;
    const pageContext = Array.isArray(options.ai?.page_context) ? options.ai.page_context : [];
    const sourceContext = Array.isArray(options.ai?.source_context) ? options.ai.source_context : [];
    const contextNeedsFilter = pageContext.some(row => !hasMeaningfulAiSource(row?.text)) ||
      sourceContext.some(group => Array.isArray(group?.units) && group.units.some(row => !hasMeaningfulAiSource(row?.text)));
    if (skippedUnitIds.length || contextNeedsFilter) options = filteredOptions(options, units, retained);
    if (!retained.length) return {translations:[],missing:[],meta:{route,skipped:"no_translatable_text",
      skippedUnitIds,generationAttempts:0,providerAttempts:0}};
    const execute=mode === "conversation" ? conversationTranslation : independentTranslation;
    let result;
    if (route === "direct-local") result = await execute(directLocal, retained, options);
    else if (route === "server") result = await execute(server, retained, options);
    else throw new Error(`unknown AI route ${JSON.stringify(route)}`);
    return skippedUnitIds.length ? {...result,meta:{...result.meta,skippedUnitIds}} : result;
  };
}

export const translateUnits = createTranslationService();

