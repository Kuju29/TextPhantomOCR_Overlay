// Original one-request-per-workload-chunk route. No conversation store is touched.
export async function independentTranslation(dispatch, units, options) {
  options.trace?.("AI translation path", {schema:"tp.conversation/1", mode:"independent", path:"independent",
    phase:"prepared", historyTurns:0, historyMessages:0, legacyFallback:false, providerCallsAdded:0, commitStatus:"not_applicable"});
  return dispatch(units, options);
}
