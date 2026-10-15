// Safe, durable evidence for unsent work in the same repair group. No retry of
// a dispatched task and no guessed key-wide fence when scope is unknown.
export function providerPressure(error, now = Date.now()) {
  if (String(error?.code || '').toLowerCase() !== 'provider_rate_limited' &&
      Number(error?.upstreamStatus) !== 429) return null;
  const value = Number(error?.retryAfterMs);
  const retryAfterMs = Number.isFinite(value) && value > 0 ? Math.min(3600000, Math.ceil(value)) : 5000;
  return {code:'provider_rate_limited', upstreamStatus:429, observedAt:now,
    until:now + retryAfterMs, retryAfterMs,
    scope:['model','provider','key','account','service'].includes(error?.constraintScope) ? error.constraintScope : 'unknown',
    creditState:['released','held','uncertain','settled','unconfirmed'].includes(error?.creditState) ? error.creditState : 'unconfirmed'};
}

export function pressurePause(pressure, now = Date.now()) {
  if (!(Number(pressure?.until) > now)) return null;
  return Object.assign(new Error('Provider cooldown; unsent repair work is saved'),
    {code:'repair_provider_cooldown', retryAfterMs:Math.min(3600000, pressure.until-now),
      retryAt:pressure.until, requestDispatched:false, providerAttempts:0, generationAttempts:0});
}

export const taskPageIds = task => [...new Set((task?.units || []).map(row => String(row.pageId || '')).filter(Boolean))];
