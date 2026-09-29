import {boundedIndependentPairs,humanExampleCount,selectIndependentStoryExamples} from '../../shared/ai/independent/examples.js';

/** Choose the largest example set that leaves room for the first real unit.
 * The workload estimator and the HTTP prompt receive the same selection.
 * A failure with one example is reported as a budget error, never converted
 * into an unannounced request without the user's chosen style examples.
 */
export function planIndependentExamples(session, rows, offset, selection) {
  const available = selection?.source === 'human' ? humanExampleCount(selection)
    : selection?.source === 'story' ? boundedIndependentPairs(selection.pairs).length : 0;
  // The first unsent unit is guaranteed to enter the next batch. Later units
  // might be split away by the budget, so they cannot select its examples.
  const currentSource = String(rows?.[offset]?.text || '');
  const chosen = selectIndependentStoryExamples(selection,currentSource);
  const total = chosen?.source === 'human' ? humanExampleCount(chosen)
    : chosen?.source === 'story' ? boundedIndependentPairs(chosen.pairs).length : 0;
  const withCount = count => chosen.source === 'human'
    ? {...chosen,humanExampleCount:count}
    : selectIndependentStoryExamples(selection,currentSource,count);
  session.setIndependentExamples(chosen);
  try {
    return {chunk:session.next(rows,offset),selection:chosen,availableExamplePairs:available,
      includedExamplePairs:total};
  } catch (original) {
    if (original?.code !== 'ai_workload_budget_insufficient' ||
        original.requestDispatched === true || total <= 1) throw original;
    let low=1, high=total-1, best=null;
    while (low<=high) {
      const count=Math.floor((low+high)/2), candidate=withCount(count);
      session.setIndependentExamples(candidate);
      try {
        const chunk=session.next(rows,offset);
        best={chunk,selection:candidate,availableExamplePairs:available,
          includedExamplePairs:candidate.source === 'human' ? count : candidate.pairs.length};
        low=count+1;
      } catch (error) {
        if (error?.code !== 'ai_workload_budget_insufficient' || error.requestDispatched === true)
          throw error;
        high=count-1;
      }
    }
    if (!best) {
      session.setIndependentExamples(chosen);
      throw original;
    }
    session.setIndependentExamples(best.selection);
    return best;
  }
}
