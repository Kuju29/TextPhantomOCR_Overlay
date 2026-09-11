import { normalizeLimits } from './ai/workload/model.js';

// One normalization boundary for metadata comparison AND persistence. Unknown
// discovery fields never become user settings or trigger generation changes.
export function normalizeModelCapabilities(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  const limits = normalizeLimits(source.limits);
  if (Object.keys(limits).length) out.limits = limits;
  const reasoning = {};
  for (const key of ['supported', 'mandatory', 'default_enabled', 'supports_max_tokens', 'dynamic'])
    if (typeof source.reasoning?.[key] === 'boolean') reasoning[key] = source.reasoning[key];
  if (['toggle', 'boolean', 'levels', 'provider'].includes(source.reasoning?.control))
    reasoning.control = source.reasoning.control;
  if (Array.isArray(source.reasoning?.supported_efforts)) {
    const efforts = [...new Set(source.reasoning.supported_efforts.filter(v =>
      typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v.trim().toLowerCase())
    ).map(v => v.trim().toLowerCase()))].sort();
    if (efforts.length) reasoning.supported_efforts = efforts;
  }
  if (reasoning.mandatory === true) reasoning.supported = true;
  if (Object.keys(reasoning).length) out.reasoning = reasoning;
  if (source.vision && typeof source.vision === 'object' &&
      typeof source.vision.supported === 'boolean') {
    out.vision = { supported: source.vision.supported };
    if (typeof source.vision.source === 'string')
      out.vision.source = source.vision.source.slice(0, 200);
  }
  for (const field of ['structured_output', 'structuredOutput']) {
    const input = source[field];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const shape = {};
    for (const key of ['supported', 'strict'])
      if (typeof input[key] === 'boolean') shape[key] = input[key];
    for (const key of ['contract', 'source', 'reason', 'parameter'])
      if (typeof input[key] === 'string') shape[key] = input[key].slice(0, 200);
    if (Object.keys(shape).length) out[field] = shape;
  }
  return out;
}
