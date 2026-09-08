/** A re-planned chunk must not reuse a receipt for different IDs/source text. */
export async function workloadOperationId(parent, index, units, executionIdentity = '') {
  const bytes = new TextEncoder().encode(JSON.stringify([
    String(parent), units.map(unit => [String(unit.id), String(unit.text || '')]),
    ...(executionIdentity ? [String(executionIdentity)] : []),
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const suffix = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return `${parent}:w${index}:${suffix}`;
}
