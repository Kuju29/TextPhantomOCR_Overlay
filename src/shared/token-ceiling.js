/**
 * Per-model token ceiling. One AI request's prompt + source
 * text + expected reply are packed up to this ceiling. OFF by default: the
 * planner then uses the default for that model —
 *   Paid:        the operator's Center > AI > model > ceiling
 *   Manual Cloud: the application default (8192, or the model's lower max output)
 *   Local:       the context window of the model the user loaded
 * ON: the user's number replaces that default (higher = fewer requests; a value
 * above what the model can really answer can make replies run out of space).
 */
export const TOKEN_CEILING_MIN = 256;
export const TOKEN_CEILING_MAX = 2_000_000;
const APPLICATION_TOKEN_CEILING = 8192;

export const validTokenCeiling = value =>
  Number.isSafeInteger(value) && value >= TOKEN_CEILING_MIN && value <= TOKEN_CEILING_MAX;

/** Stored per-model fields. No valid number = no fields (OFF, unchanged shape). */
export function cleanTokenCeiling(value = {}) {
  return validTokenCeiling(value?.tokenCeiling)
    ? {tokenCeilingEnabled:value?.tokenCeilingEnabled === true, tokenCeiling:value.tokenCeiling} : {};
}

/** The user's ceiling when switched on; otherwise null (use the default). */
export function activeTokenCeiling(profile) {
  return profile?.tokenCeilingEnabled === true && validTokenCeiling(profile?.tokenCeiling)
    ? profile.tokenCeiling : null;
}

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;

/** Display/default only. Never invents a Local window it has not observed. */
export function defaultTokenCeiling({service = 'manual', local = false, paidCeiling = null,
  modelCapabilities = null, localLimits = null} = {}) {
  if (service === 'paid')
    return {tokens: positive(paidCeiling) && paidCeiling >= TOKEN_CEILING_MIN ? paidCeiling : APPLICATION_TOKEN_CEILING,
      source: positive(paidCeiling) ? 'center' : 'application'};
  if (local) {
    const window = positive(localLimits?.contextTokens) || positive(localLimits?.runtimeContextTokens);
    return {tokens: window, source: window ? 'model' : 'unknown'};
  }
  const modelMax = positive(modelCapabilities?.limits?.maxOutputTokens);
  return {tokens: Math.min(APPLICATION_TOKEN_CEILING, modelMax || Infinity), source: 'application'};
}
