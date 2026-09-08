import { sendRuntimeMessage } from '../../shared/messaging.js';

// Opening this view reads only. Resumption needs an explicit user click.
export function mountTranslationSessionStatus({ document: doc = globalThis.document,
  send = sendRuntimeMessage, events = globalThis.chrome?.storage?.onChanged,
  page = globalThis.window } = {}) {
  const panel = doc?.getElementById('translation-session-panel');
  const label = doc?.getElementById('translation-session-status');
  const button = doc?.getElementById('translation-session-resume');
  if (!panel || !label || !button) return;
  let busy = false, disposed = false, timer;
  const refresh = async () => {
    if (busy || disposed) return;
    busy = true;
    try {
      const response = await send({type:'TP_GET_TRANSLATION_SESSIONS'});
      if (disposed) return;
      const runs = response?.runs || [];
      const run = runs.filter(x => !['done','cancelled','unavailable'].includes(x.phase)).at(-1) || runs.at(-1);
      panel.hidden = !run;
      if (run) {
        label.textContent = `${run.phase}: initial accepted ${run.initialAccepted || 0} · repair ${run.repaired || 0}/${run.failedUnits || 0} · unresolved ${run.unresolved || 0} · interrupted ${run.unverified || 0} · no-source images ${run.unavailablePages || 0}${run.code ? ` · ${run.code}` : ''}`;
        button.hidden = !['blocked','apply_pending'].includes(run.phase);
      }
    } finally { busy = false; }
  };
  const changed = (items, area) => {
    if (area !== 'session' || !items.tpTranslationRunsV1) return;
    clearTimeout(timer); timer = setTimeout(refresh, 100);
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await send({type:'TP_RESUME_REPAIRS'}); await refresh(); }
    finally { button.disabled = false; }
  });
  events?.addListener(changed);
  page?.addEventListener('pagehide', () => {
    disposed = true; clearTimeout(timer); events?.removeListener(changed);
  }, {once:true});
  void refresh();
}
