// Shared, testable ordering for page/session transitions. Cancellation must
// always receive the old session before a new session is created.
export function cancelBeforeSessionBump(tabId, reason, href, dependencies) {
  const oldSessionId = dependencies.getTabSessionId(tabId);
  dependencies.cancelTabWork(tabId, reason, oldSessionId);
  return dependencies.bumpTabSession(tabId, href || "");
}

export function createSessionLifecycle(dependencies) {
  return {
    onTabLoading(tabId, href = "") {
      return cancelBeforeSessionBump(tabId, "navigation", href, dependencies);
    },
    onKeepaliveDisconnect(tabId) {
      return cancelBeforeSessionBump(tabId, "page_unloaded", "", dependencies);
    },
    onLocationChanged(tabId, href = "") {
      return cancelBeforeSessionBump(
        tabId,
        "spa_navigation",
        href,
        dependencies,
      );
    },
    onMangaDexChapterChanged(tabId, href = "") {
      return cancelBeforeSessionBump(
        tabId,
        "chapter_change",
        href,
        dependencies,
      );
    },
  };
}
