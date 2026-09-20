import { observedReasoningRisk } from '../workload/model.js';

// Conversation capacity is content/output-budget driven. Provider cache is
// telemetry/economics only and never decides how many OCR units may fit.
export function conversationBatchProfile(profile, state = {}) {
  const continuation = state.continuation === true;
  const previousTurnMs = Math.max(0, Number(state.previousTurnMs) || 0);
  const reasoningRisk = state.reasoningRisk === true || observedReasoningRisk(profile);

  // Short vertical text naturally produces many OCR units. A second unit-count
  // gate double-charged those pages even though per-unit marker/prompt overhead
  // is already included in the token estimates. Size the request by content.
  let target = Math.max(profile.target, reasoningRisk ? 1280 : 1536);
  let capacity = continuation ? 'continuation_token_budget' : 'anchor';

  // Measured output/structure pressure is real quality evidence. Reduce the
  // content target, while complete pages remain atomic unless a hard provider
  // or application budget says otherwise.
  if (profile.reliabilityRestricted || profile.outcomes?.some(x => x === 'length')) {
    target = Math.min(target, reasoningRisk ? 1024 : 1280);
    capacity = 'continuation_reliability_restricted';
  }

  // Serialized chats pay startup cost per turn. Keep latency as telemetry;
  // only content, reliability and real provider limits determine capacity.
  void previousTurnMs;

  return {...profile, target, latencyOutputTarget: null, conversationCapacity: capacity};
}
