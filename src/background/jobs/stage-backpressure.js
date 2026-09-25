// A stage may defer a rejected admission. A Lens cookie failure reached Lens
// already; repeating it with the same rejected jar cannot free capacity.
export function isStageBackpressure(error) {
  const status = Number(error?.status) || 0;
  if (status !== 429 && status !== 503) return false;
  if (error?.permanent === true) return false;
  const code = String(error?.tpError?.code || error?.code || "");
  if (code === "lens_session_unavailable") return false;
  return (
    error?.retryable === true ||
    code === "server_busy" ||
    code === "API_5XX" ||
    code === "API_BAD_RESPONSE" ||
    !code
  );
}
