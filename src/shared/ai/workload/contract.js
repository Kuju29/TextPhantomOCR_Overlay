import { normalizeModelCapabilities } from '../../model-capabilities.js';
import { selectLocalOutputContract } from '../direct-local/output-contract.js';

/** Canonical identities; display names/transport aliases must not reset learning. */
export function workloadContract(value) {
  if (['schema_object', 'json_schema_object_v1', 'tp.translation.schema-object/1'].includes(value))
    return 'json_schema_object_v1';
  if (['compact_records', 'compact_markers_v1', 'plain_records_v1', 'tp.translation.compact-records/1'].includes(value))
    return 'compact_markers_v1';
  return '';
}

/** Same metadata snapshot is used for planning, checkpointing and dispatch. */
export function serverModelCapabilities(value) {
  const caps = normalizeModelCapabilities(value);
  const structured = caps.structured_output || caps.structuredOutput;
  if (structured) caps.structured_output = structured;
  delete caps.structuredOutput;
  return caps;
}

export function workloadSelection(ai, route) {
  const caps = route === 'direct-local'
    ? ai.model_capabilities || ai.modelCapabilities || {}
    : serverModelCapabilities(ai.modelCapabilities ?? ai.model_capabilities);
  const contract = route === 'direct-local'
    ? workloadContract(selectLocalOutputContract({provider:ai.provider, model:ai.model, modelCapabilities:caps}).version)
    : caps.structured_output?.supported === true ? 'json_schema_object_v1'
      : caps.structured_output?.supported === false ? 'compact_markers_v1' : '';
  const model = String(ai.model || '').trim();
  return { caps, contract, model: model && model.toLowerCase() !== 'auto' ? model : '',
    kind: contract === 'json_schema_object_v1' ? 'schema_object' : contract ? 'compact_records' : 'auto' };
}

export function normalizedWorkloadIdentity(value) {
  const raw = String(value || ''), split = raw.lastIndexOf('|');
  if (split < 1) return '';
  const contract = workloadContract(raw.slice(split+1));
  return contract ? `${raw.slice(0,split)}|${contract}` : '';
}
