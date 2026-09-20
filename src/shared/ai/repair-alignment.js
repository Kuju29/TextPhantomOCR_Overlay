// This detects structural alignment uncertainty, NOT semantic correctness.
// Sparse repair IDs may be nonconsecutive. Never shift translations to fill gaps.
const imageId = /^(I[1-9][0-9]{0,6})_P[0-9]{1,6}$/;
export function uncertainRepairIds(expectedIds, unexpectedIds) {
  const expected = [...new Set(expectedIds.map(String))];
  const expectedSet = new Set(expected);
  const unexpected = [...new Set(unexpectedIds.map(String).filter(id => !expectedSet.has(id)))];
  if (!unexpected.length) return [];
  const images = new Set(expected.map(id => imageId.exec(id)?.[1]).filter(Boolean));
  const affected = new Set();
  for (const id of unexpected) {
    const image = imageId.exec(id)?.[1];
    if (!image || !images.has(image)) return expected;
    affected.add(image);
  }
  if (expected.some(id => !imageId.test(id))) return expected;
  return expected.filter(id => affected.has(imageId.exec(id)[1]));
}
