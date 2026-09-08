import { isLocalAiProvider } from "../../constants.js";
import { isLocalHostUrl } from "../providers/local-spec.js";

export function shouldUseDirectLocalAi(engine, provider, baseUrl) {
  return (
    String(engine || "extension") !== "api" &&
    (isLocalAiProvider(provider) || isLocalHostUrl(baseUrl))
  );
}
