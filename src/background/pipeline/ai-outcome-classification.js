export function classifyAiOutcomeIds({ missing = [], omitted = [], empty = [], wrongLanguage = [], preserved = [] } = {}) {
  const unique = (values) => [...new Set((Array.isArray(values) ? values : []).map(String))];
  const preservedIds = unique(preserved);
  const preservedSet = new Set(preservedIds);
  const take = (values, claimed) => unique(values).filter((id) => !preservedSet.has(id) && !claimed.has(id));
  const claimed = new Set();
  const omittedIds = take(omitted, claimed); omittedIds.forEach((id) => claimed.add(id));
  const emptyIds = take(empty, claimed); emptyIds.forEach((id) => claimed.add(id));
  const wrongLanguageIds = take(wrongLanguage, claimed); wrongLanguageIds.forEach((id) => claimed.add(id));
  const missingIds = take(missing, claimed);
  return { missingIds, omittedIds, emptyIds, wrongLanguageIds, preservedIds };
}
