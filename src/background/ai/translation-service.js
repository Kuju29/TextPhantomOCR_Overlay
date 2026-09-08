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
    if (route === "direct-local") return directLocal(units, options);
    if (route === "server") return server(units, options);
    throw new Error(`unknown AI route ${JSON.stringify(route)}`);
  };
}

export const translateUnits = createTranslationService();

export function shouldFallBackToServer(error) {
  void error;
  return false;
}
