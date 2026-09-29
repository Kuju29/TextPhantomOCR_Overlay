// Browser-owned request admission for Direct Local generations. One token is
// consumed only immediately before a real provider dispatch, including repair.
// Capacity and model execution remain owned by the existing scheduler.
const buckets = new Map();
const MAX_BUCKETS = 128;

function pump(bucket) {
  if (bucket.timer) { clearTimeout(bucket.timer); bucket.timer = null; }
  const now = performance.now();
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + Math.max(0, now - bucket.last) * bucket.rpm / 60000);
  bucket.last = now;
  while (bucket.queue.length && bucket.tokens >= 1) {
    const waiter = bucket.queue.shift();
    if (waiter.signal?.aborted) { waiter.abort(); continue; }
    bucket.tokens -= 1;
    waiter.signal?.removeEventListener?.("abort", waiter.abort);
    waiter.resolve();
  }
  if (bucket.queue.length) {
    const waitMs = Math.max(1, Math.ceil((1 - bucket.tokens) * 60000 / bucket.rpm));
    bucket.timer = setTimeout(() => pump(bucket), waitMs);
  }
}

export function waitForLocalRequest(ai, rate, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Cancelled", "AbortError"));
  if (rate?.enabled !== true) return Promise.resolve();
  const rpm = Math.floor(Number(rate.rpm));
  if (!Number.isFinite(rpm) || rpm < 1 || rpm > 600) {
    const error = new Error("Local AI request-rate cap is enabled but RPM must be between 1 and 600");
    error.code = "invalid_local_request_rate";
    return Promise.reject(error);
  }
  const burst = Math.min(rpm, 60, Math.max(1, Math.floor(Number(rate.burst) || 1)));
  const key = JSON.stringify([String(ai?.provider || "").toLowerCase(),
    String(ai?.base_url || "").trim().replace(/\/+$/, "").toLowerCase(), String(ai?.model || "")]);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [identity, candidate] of buckets) {
        if (!candidate.queue.length && !candidate.timer) { buckets.delete(identity); break; }
      }
    }
    bucket = { rpm, burst, tokens: burst, last: performance.now(), queue: [], timer: null };
    buckets.set(key, bucket);
  } else if (bucket.rpm !== rpm || bucket.burst !== burst) {
    bucket.rpm = rpm; bucket.burst = burst; bucket.tokens = Math.min(bucket.tokens, burst);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, abort: null };
    waiter.abort = () => {
      const index = bucket.queue.indexOf(waiter);
      if (index !== -1) bucket.queue.splice(index, 1);
      signal?.removeEventListener?.("abort", waiter.abort);
      reject(signal?.reason || new DOMException("Cancelled", "AbortError"));
      pump(bucket);
    };
    bucket.queue.push(waiter);
    signal?.addEventListener?.("abort", waiter.abort, { once: true });
    pump(bucket);
  });
}
