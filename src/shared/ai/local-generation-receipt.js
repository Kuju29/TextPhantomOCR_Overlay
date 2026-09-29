// A content/workload operation can be reused on a later translation click.
// Usage identity instead belongs to one actual Local provider invocation.
// Keep this receipt on the returned result/error so delivery/recovery can
// replay the observation without counting the same generation twice.
export function createLocalGenerationReceipt(id = () => crypto.randomUUID()) {
  const receiptId = `local:${id()}`;
  return usage => ({ ...(usage && typeof usage === 'object' ? usage : {}),
    receiptId, accountingOrigin: 'local_runtime', billingEligible: false });
}
