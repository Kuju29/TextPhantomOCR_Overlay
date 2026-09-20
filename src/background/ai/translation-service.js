import {independentTranslation} from "./translation-paths/independent.js";
import {conversationTranslation} from "./translation-paths/conversation.js";
import { translateDirectLocalRoute } from "./routes/direct-local.js";
import { translateServerRoute } from "./routes/server.js";

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
    const execute=mode === "conversation" ? conversationTranslation : independentTranslation;
    if (route === "direct-local") return execute(directLocal, units, options);
    if (route === "server") return execute(server, units, options);
    throw new Error(`unknown AI route ${JSON.stringify(route)}`);
  };
}

export const translateUnits = createTranslationService();

export function shouldFallBackToServer(error) {
  void error;
  return false;
}
