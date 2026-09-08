// Only semantic changes invalidate active translation results. Metadata and
// scheduler/usage telemetry are intentionally excluded from this projection.
const stable = value => value == null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;

export function translationProfileIdentity(state) {
  const active = state?.active || {};
  const provider = state?.providers?.[active.providerIdentity] || {};
  const profile = provider.models?.[active.model]?.profile || {};
  const { modelCapabilities, capabilityAccountHash, ...providerOptions } = profile.providerOptions || {};
  return { active, provider: provider.provider, endpoint: provider.endpoint,
    thinking: profile.thinking, tokenPolicy: profile.tokenPolicy,
    temperature: profile.temperature, pageImage: profile.pageImage,
    memoryMode: profile.memoryMode, providerOptions };
}

export function translationSettingsChanged(changes, area = 'local') {
  if (area !== 'local' || !changes) return false;
  for (const key of ['mode', 'lang', 'sources', 'aiProvider', 'aiModel', 'aiRuntime',
    'customApiUrl', 'aiProfilePromptsV1', 'aiProfileCredentialsV1']) {
    const change = changes[key];
    if (change && stable(change.oldValue) !== stable(change.newValue)) return true;
  }
  const profile = changes.aiProfilesV1;
  return Boolean(profile && stable(translationProfileIdentity(profile.oldValue)) !==
    stable(translationProfileIdentity(profile.newValue)));
}
