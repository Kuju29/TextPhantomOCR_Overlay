import { getStorage, setStorage } from '../shared/storage.js';
import { createSupportClient, supportScopeId } from './client.js';

// End is durable server state; Hide is temporary until a genuinely new admin reply.
export async function syncSupportVisibility(data, scope) {
  const saved = await getStorage(['supportClosedSeen', 'supportHideUntil', 'supportChatMuted', 'supportDockHidden']);
  const thread = data.thread, closedSeq = thread?.closed_seq || 0;
  const patch = { supportUnread: { scope, unread: thread?.unread || 0, lastSeq: thread?.last_seq || 0, lastAdminSeq: thread?.last_admin_seq || 0 } };
  if (thread?.notification_muted && (saved.supportClosedSeen?.scope !== scope || saved.supportClosedSeen.seq !== closedSeq)) {
    Object.assign(patch, { supportClosedSeen: { scope, seq: closedSeq }, supportChatMuted: { scope }, supportDockHidden: true, supportHideUntil: null });
  } else if (!thread?.notification_muted) {
    if (saved.supportChatMuted) Object.assign(patch, { supportChatMuted: null, supportDockHidden: false });
    if (saved.supportDockHidden && !saved.supportHideUntil && !saved.supportChatMuted) patch.supportHideUntil = { scope, lastAdminSeq: thread?.last_admin_seq || 0 };
    if (saved.supportHideUntil && (saved.supportHideUntil.scope !== scope || (thread?.last_admin_seq || 0) > saved.supportHideUntil.lastAdminSeq))
      Object.assign(patch, { supportDockHidden: false, supportHideUntil: null });
  }
  try { if (await supportScopeId(await createSupportClient().scope()) !== scope) return { supportUnread: null }; } catch (_) { return { supportUnread: null }; }
  await setStorage(patch);
  return { ...saved, ...patch };
}
export async function activateSupport(client) {
  let scope = '', data = null;
  try {
    const identity = await client.scope(); scope = await supportScopeId(identity);
    data = await client.request('/paid/support', { identity });
    if (data.enabled && data.thread?.notification_muted) {
      await client.request('/paid/support/action', { identity, body: { command_id: crypto.randomUUID(), action: 'reopen', expected_seq: data.thread.last_seq } });
      data = await client.request('/paid/support', { identity });
    }
  } catch (error) {
    if (['SIGN_IN_REQUIRED', 'STALE_SUPPORT_RESPONSE', 'DATA_CONSENT_REQUIRED'].includes(error.code) || error.status === 401) throw error;
    // Availability errors still allow the user to open the status/history surface.
  }
  await setStorage({ supportActivated: true, supportDockHidden: false, supportHideUntil: null, supportChatMuted: null,
    ...(data ? { supportClosedSeen: { scope, seq: data.thread?.closed_seq || 0 } } : {}) });
}
