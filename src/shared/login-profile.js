import { normalizeUrl } from './url.js';
import { makeProfilePromptKey } from './ai-profiles.js';
import { cleanPaidProfile, paidEntry } from './paid-profile.js';
export const LOGIN_PROFILE_KEY = 'loginAiProfilesV1';
export const loginScope = (api, provider, account, model) => JSON.stringify([normalizeUrl(api), String(provider || ''), String(account || ''), String(model || 'auto')]);
export const loginIdentity = (api, provider, account) => 'login:' + JSON.stringify([normalizeUrl(api), String(provider || ''), String(account || '')]);
export const loginPromptKey = (api, provider, account, model, language) => makeProfilePromptKey(loginIdentity(api, provider, account), model || 'auto', language || 'en');
export function loginEntry(settings, api, provider, account, model, language = 'en') {
  const entry = settings[LOGIN_PROFILE_KEY]?.entries?.[loginScope(api, provider, account, model)];
  // Reuse canonical first-model defaults, never another mode's saved entry.
  const initial = paidEntry({}, api, model, language);
  const prompts = structuredClone(entry?.prompts || {});
  if (!Object.hasOwn(prompts, language)) prompts[language] = initial.prompts[language];
  return { profile: cleanPaidProfile(entry?.profile || {}), prompts };
}
export function putLoginEntry(store, api, provider, account, model, entry) {
  return { version: 1, entries: { ...(store?.entries || {}),
    [loginScope(api, provider, account, model)]: { profile: cleanPaidProfile(entry.profile), prompts: structuredClone(entry.prompts || {}) } } };
}
/**
 * A Login model row the API marked unusable for this account: the website's
 * own picker disables it for this plan (claude.ai chat picker, with its plan
 * badge), or the website refused it (403 for a chat turn, remembered).
 * Shown disabled; never selected or sent.
 */
export function loginModelUnavailable(row) {
  return Boolean(row && typeof row === 'object' && row.availability && row.availability.usable === false);
}
const PLAN_BADGE = /^[A-Za-z0-9 +&/.-]{1,40}$/;
/** The plan the website names for a disabled model ("Pro", "Pro or Max"), or "". */
export function loginModelPlanBadge(row) {
  const access = row && typeof row === 'object' ? row.availability : null;
  if (!access || access.usable !== false || access.reason !== 'plan_required') return '';
  if (typeof access.badge === 'string' && PLAN_BADGE.test(access.badge.trim())) return access.badge.trim();
  const plan = typeof access.required_plan === 'string' && /^[a-z0-9_-]{1,32}$/.test(access.required_plan) ? access.required_plan : '';
  return plan ? plan[0].toUpperCase() + plan.slice(1) : '';
}
