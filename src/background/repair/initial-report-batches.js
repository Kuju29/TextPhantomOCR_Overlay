/** Bounded ledger sync, not parallel AI work or another repair round. */
export const INITIAL_REPORT_LIMITS = Object.freeze({ pages: 32, bytes: 1_900_000 });
const encoder = new TextEncoder();
export function* initialReportBatches(reports) {
  let pages = [], bytes = 12; // {"pages":[]} plus conservative comma allowance
  for (const report of reports) {
    const size = encoder.encode(JSON.stringify(report)).byteLength + 1;
    if (size + 12 > INITIAL_REPORT_LIMITS.bytes)
      throw Object.assign(new Error('Repair page report exceeds the API request budget'),
        { code: 'repair_request_too_large', requestDispatched: false });
    if (pages.length && (pages.length >= INITIAL_REPORT_LIMITS.pages || bytes + size > INITIAL_REPORT_LIMITS.bytes)) {
      yield { pages }; pages = []; bytes = 12;
    }
    pages.push(report); bytes += size;
  }
  if (pages.length) yield { pages };
}
