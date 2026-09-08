// Complete runs:Extension Local AI route boundary.
// This route alone loads the bundled prompt plan and hands it to the direct
// local transport. Cloud/server code must not know this prompt-cache contract.
import {
  getCanonicalPrompt,
  getPromptAudit,
} from "../prompt-cache.js";
import { translateDirectLocal } from "../transports/direct-local.js";

export async function translateDirectLocalRoute(units, options = {}) {
  const targetLang = String(options.targetLang || "");
  const canonicalPrompt = await getCanonicalPrompt(
    options.base,
    targetLang,
    { wantMemo: false },
  );
  if (!canonicalPrompt) {
    throw Object.assign(
      new Error("Could not load the Local AI translation prompt"),
      {
        code: "local_prompt_unavailable",
        generationAttempts: 0,
        providerAttempts: 0,
      },
    );
  }
  const promptAudit = getPromptAudit(options.base, targetLang, {
    wantMemo: false,
  });
  return translateDirectLocal(units, {
    ...options,
    canonicalPrompt,
    promptAudit,
  });
}

