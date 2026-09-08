// Distinguishes an intentional batch-complete close from a lost page/port.
export function createKeepalivePortLifecycle(onUnexpectedDisconnect) {
  let expected = false;
  let unloadHandled = false;
  return {
    onMessage(message) {
      const type = String(message?.type || "");
      if (type === "TP_KEEPALIVE_GRACEFUL_STOP") expected = true;
      if (type === "TP_KEEPALIVE_PAGE_UNLOAD" && !unloadHandled) {
        unloadHandled = true;
        onUnexpectedDisconnect();
      }
    },
    onDisconnect() {
      if (!expected && !unloadHandled) onUnexpectedDisconnect();
    },
  };
}
