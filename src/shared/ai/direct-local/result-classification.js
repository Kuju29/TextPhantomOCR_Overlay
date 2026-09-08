export function classifyDirectLocalMissingIds(diagnostics, wireUnits = [], units = []) {
  const wireToSource = new Map(wireUnits.map((wire, index) => [
    String(wire.id), String(units[index]?.id ?? wire.id),
  ]));
  const sourceIds = (ids) => [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => wireToSource.get(String(id)) || String(id)))];
  const emptyIds = sourceIds(diagnostics?.emptyIds);
  const malformedIds = sourceIds(diagnostics?.malformedMarkerIds);
  const excluded = new Set([...emptyIds, ...malformedIds]);
  const omittedIds = sourceIds(diagnostics?.missingIds).filter((id) => !excluded.has(id));
  return { omittedIds, declinedIds: emptyIds, malformedIds };
}
