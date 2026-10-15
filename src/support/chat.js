import { getStorage, setStorage } from '../shared/storage.js';
import { createSupportClient, supportScopeId } from './client.js';
import { syncSupportVisibility, activateSupport } from './visibility.js';
import { presenceText } from './presence.js';
import { uiTemplate } from '../shared/ui-template.js';
import { uiMessage } from '../shared/ui-language.js';
import { supportDraftScope, readDraft, setDraftText, addDraftFile, updateDraftFile, removeDraftFile, claimDraft, settleDraft, recoverDraftFiles } from './drafts.js';
import { createLiveUpdates, waitPath } from './live.js';
import { createLogger } from '../shared/logger.js';
import { installId } from '../paid/install-id.js';
import { supportEventParts } from './events.js';

const $ = id => document.getElementById(id), client = createSupportClient();
const uuid = () => crypto.randomUUID(), dock = new URL(location.href).searchParams.has('dock');
// Standalone extension window (browser pages that cannot host the dock, e.g. brave://).
const windowMode = parent === window && !dock && new URL(location.href).searchParams.has('window');
const log = createLogger('support');
// Panel geometry reported by the dock: the image viewer keeps the panel in place while the
// frame temporarily covers the whole page.
let panelLayout = { layout: 'panel', right: 18, bottom: 18, width: 0, height: 0 };
let outbox = [];
const privateNode = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; node.dataset.tpUiPrivate = ''; return node; };
let state = null, view = parent !== window ? 'hidden' : 'expanded', files = [], busy = false, polling = false, uploading = false, attaching = false, loginEmail = '', resendAt = 0, scope = '', messages = [], urls = new Set(), rendered = '', generation = 0, hasOlder = false;
// Image previews reuse one authenticated download per attachment id until it leaves the history.
const imageUrls = new Map(), imageLoads = new Map(), thumbFiles = new WeakMap();
let lightboxId = '', lightboxOpener = null, followLatest = true;
const labels = { waiting_admin: 'Waiting for admin', waiting_customer: 'Admin replied', resolved: 'Chat ended' };
const draftOwner = crypto.randomUUID();
let authIdentity = null;
let draftScope = '', sharedDraft = null, draftWrite = Promise.resolve(), draftSaveError = null;
const MAX_ATTACHMENT_BYTES = 40 * 1048576;
const runtime = message => new Promise(resolve => {
  try { chrome.runtime.sendMessage(message, value => {
    try { resolve(chrome.runtime.lastError ? undefined : value); } catch { resolve(); }
  }); } catch { resolve(); }
});
function failure(error) { $('error').textContent = error?.message || String(error); }
async function changeView(next) {
  view = next;
  if (next !== 'expanded') { closeLightbox(false); toggleAccount(false); }
  document.body.dataset.view = next;
  $('expanded').hidden = next !== 'expanded'; $('minimized').hidden = next !== 'minimized'; $('preview').hidden = next !== 'preview';
  if (parent !== window) {
    parent.postMessage({ type: 'TP_SUPPORT_GEOMETRY', view: next }, '*');
    if (next !== 'preview') await runtime({ type: 'TP_SUPPORT_TAB_VIEW', view: next === 'expanded' ? 'expanded' : 'minimized', scope });
  }
  if (next === 'hidden') live.stop();
  if (next === 'expanded') { await refresh(); $('text').focus(); activity('expanded'); }
  else if (next !== 'hidden' && !authIdentity) await refresh();
  if (!liveWanted()) live.stop();
  else if (next !== 'hidden') live.start();
}
function revoke() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); imageUrls.clear(); imageLoads.clear(); }
function clearPrivate() {
  live.stop(); outbox = [];
  generation++; uploading = false; attaching = false; busy = false; hasOlder = false;
  closeLightbox(false); toggleAccount(false);
  revoke(); $('identity').textContent = ''; $('history').replaceChildren(); $('reply-preview').textContent = '';
  authIdentity = null; draftScope = ''; sharedDraft = null; draftSaveError = null; files = []; messages = []; state = null; rendered = ''; $('files').replaceChildren(); $('text').value = ''; autosize();
}
function controls() {
  const authenticated = Boolean(state);
  $('login').hidden = authenticated; $('conversation').hidden = !authenticated; $('end').hidden = !state?.thread;
  $('account-toggle').hidden = !authenticated; if (!authenticated) toggleAccount(false);
  $('end').textContent = state?.thread?.state === 'resolved' ? 'Reopen chat' : 'End chat';
  $('end').disabled = busy || uploading || attaching || (state?.thread?.state === 'resolved' && !state?.enabled);
  const stateText = state ? state.enabled ? labels[state.thread?.state] || 'Contact admin' : 'Support is currently unavailable' : 'Sign in to contact admin';
  $('state').textContent = stateText;
  // The header already names the chat; the status bar only appears when it adds information or an action.
  $('state').parentElement.hidden = stateText === 'Contact admin' && $('end').hidden;
  const presence = state?.admin_presence;
  if (presence?.last_seen_at && !presence.online) {
    const minutes = Math.max(1, Math.floor((presence.server_now - presence.last_seen_at - (presence.timeout_seconds || 120) * 1000) / 60000));
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    const values = { days, hours, minutes: rest || (!hours && !days ? minutes : 0) };
    const parts = Object.entries(values).filter(([, value]) => value).map(([key, value]) => '{' + key + '} ' + (value === 1 ? key.slice(0, -1) : key));
    $('presence').replaceChildren(uiTemplate('Admin offline for about ' + parts.join(' '), values));
  } else $('presence').textContent = presenceText(presence);
  $('presence').classList.toggle('online', state?.admin_presence?.online === true);
  renderHours();
  $('expanded').classList.toggle('admin-online', state?.admin_presence?.online === true);
  $('send-label').textContent = sharedDraft?.pending ? 'Retry Send' : 'Send';
  $('send').classList.toggle('retry', Boolean(sharedDraft?.pending));
  const waiting = sharedDraft?.pending && sharedDraft.pending.owner !== draftOwner && sharedDraft.pending.until > Date.now();
  $('send').disabled = busy || uploading || attaching || !state?.enabled || !sharedDraft || waiting; $('file').disabled = busy || uploading || attaching || !state?.enabled || Boolean(sharedDraft?.pending); $('text').disabled = busy || !state?.enabled || !sharedDraft || Boolean(sharedDraft?.pending);
  for (const button of $('files').querySelectorAll('button')) button.disabled = busy || uploading || attaching;
  $('unread').textContent = state?.thread?.unread ? String(state.thread.unread) : '';
}
async function loadFile(file) {
  const owner = generation;
  const blob = await client.request('/paid/support/attachments/' + file.id, { binary: true });
  if (owner !== generation) return;
  const url = URL.createObjectURL(blob); urls.add(url);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000);
}
// Same authenticated attachment request as a download; the object URL stays inside this extension page.
function loadImage(file) {
  if (imageUrls.has(file.id)) return Promise.resolve(imageUrls.get(file.id));
  if (!imageLoads.has(file.id)) {
    const owner = generation;
    const promise = client.request('/paid/support/attachments/' + file.id, { binary: true }).then(blob => {
      if (owner !== generation) throw Object.assign(new Error('Your account changed.'), { code: 'STALE_SUPPORT_RESPONSE' });
      const url = URL.createObjectURL(blob); urls.add(url); imageUrls.set(file.id, url);
      return url;
    }).finally(() => { if (imageLoads.get(file.id) === promise) imageLoads.delete(file.id); });
    imageLoads.set(file.id, promise);
  }
  return imageLoads.get(file.id);
}
const icon = paths => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'chat-icon');
  for (const d of paths) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
};
const dayStart = time => { const day = new Date(time); day.setHours(0, 0, 0, 0); return day.getTime(); };
function daySeparator(time) {
  const node = document.createElement('div'); node.className = 'day-separator';
  const days = Math.round((dayStart(Date.now()) - dayStart(time)) / 86400000);
  const label = days === 0 ? document.createElement('span') : days === 1 ? document.createElement('span') : privateNode('span');
  label.textContent = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : new Date(time).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', ...(new Date(time).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  node.append(label);
  return node;
}
// Consecutive bubbles from one sender, a few minutes apart, share one avatar and time stamp.
const sameGroup = (a, b) => Boolean(a && b && !a.event && !b.event && a.sender === b.sender && (a.automatic === true) === (b.automatic === true) &&
  dayStart(a.created_at) === dayStart(b.created_at) && b.created_at - a.created_at < 300000);
function fileChip(file) {
  const download = privateNode('button'); download.type = 'button'; download.className = 'file-chip';
  const name = privateNode('span', file.name), size = privateNode('small', Math.ceil(file.size / 1024) + ' KB');
  const label = privateNode('span'); label.className = 'file-chip-text'; label.append(name, size);
  download.append(icon(['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M12 12v6m-3-3 3 3 3-3']), label);
  download.onclick = () => loadFile(file).catch(failure);
  return download;
}
function imageThumb(file) {
  const button = privateNode('button'); button.type = 'button'; button.className = 'attachment-thumb loading'; button.disabled = true;
  const placeholder = privateNode('span', 'Loading image…'); button.append(placeholder);
  thumbFiles.set(button, file);
  queueMicrotask(() => loadImage(file).then(url => {
    if (!button.isConnected) return;
    const img = privateNode('img'); img.alt = file.name; img.decoding = 'async';
    // Late image layout keeps a reader who was following the newest messages at the bottom.
    img.addEventListener('load', () => { if (followLatest) $('history').scrollTop = $('history').scrollHeight; }, { once: true });
    img.src = url; placeholder.replaceWith(img);
    button.classList.replace('loading', 'ready'); button.disabled = false;
    button.onclick = () => openLightbox(file.id, button);
  }).catch(() => {
    if (!button.isConnected) return;
    button.classList.replace('loading', 'failed');
    placeholder.textContent = 'Image unavailable. Use download to retry.';
    button.after(fileChip(file));
  }));
  return button;
}
function messageNode(message, previous, next) {
  const admin = message.sender === 'admin', automatic = admin && message.automatic === true;
  const row = document.createElement('div');
  row.className = 'bubble-row ' + (admin ? 'admin' : 'customer') + (automatic ? ' automatic' : '') +
    (sameGroup(previous, message) ? ' grouped' : '') + (sameGroup(message, next) ? '' : ' tail');
  const sender = document.createElement('span'); sender.className = 'sr-only'; sender.textContent = admin ? 'Admin' : 'You';
  const body = document.createElement('div'); body.className = 'bubble-body';
  if (automatic) {
    const label = document.createElement('span'); label.className = 'automatic-label';
    label.append(icon(['M13 2 4 14h7l-1 8 9-12h-7z']), document.createTextNode('Automatic reply'));
    body.append(label);
  }
  const article = privateNode('article'); article.className = 'message ' + message.sender;
  article.append(privateNode('p', message.text));
  const images = message.attachments.filter(file => file.type.startsWith('image/'));
  if (images.length) {
    const grid = privateNode('div'); grid.className = 'attachment-grid' + (images.length > 1 ? ' multiple' : '');
    grid.append(...images.map(imageThumb)); article.append(grid);
  }
  for (const file of message.attachments) if (!file.type.startsWith('image/')) article.append(fileChip(file));
  if (!message.text && images.length === message.attachments.length && images.length) article.classList.add('media-only');
  const time = privateNode('time', new Date(message.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  time.dateTime = new Date(message.created_at).toISOString(); time.title = new Date(message.created_at).toLocaleString();
  const meta = document.createElement('div'); meta.className = 'bubble-meta';
  if (message.pending) {
    // Optimistic bubble: shown at once, replaced by the stored message when confirmed.
    row.classList.add('pending'); row.setAttribute('aria-busy', 'true');
    const sending = document.createElement('span'); sending.textContent = 'Sending…'; meta.append(sending);
    if (message.files) { const files = document.createElement('span'); files.className = 'pending-files'; files.textContent = 'Attachments'; meta.append(' · ', files); }
  } else meta.append(time);
  body.append(article, meta);
  if (admin) {
    const avatar = document.createElement('span'); avatar.className = 'bubble-avatar'; avatar.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img'); img.src = '../icons/32.png'; img.alt = ''; avatar.append(img);
    row.append(avatar);
  }
  row.prepend(sender); row.append(body);
  return row;
}
// Welcome greeting: presentation only (never stored), at the start of an empty round —
// a new conversation, or after the previous one ended.
function welcomeVisible() {
  if (!state?.welcome?.enabled || !state.welcome.text || outbox.length) return false;
  const closed = messages.map(message => String(message.event || '').startsWith('closed_')).lastIndexOf(true);
  return !messages.slice(closed + 1).some(message => !message.event);
}
function welcomeNode() {
  const row = document.createElement('div'); row.className = 'bubble-row admin welcome tail';
  const sender = document.createElement('span'); sender.className = 'sr-only'; sender.textContent = 'Admin';
  const avatar = document.createElement('span'); avatar.className = 'bubble-avatar'; avatar.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img'); img.src = '../icons/32.png'; img.alt = ''; avatar.append(img);
  const body = document.createElement('div'); body.className = 'bubble-body';
  const article = privateNode('article'); article.className = 'message admin';
  article.append(privateNode('p', state.welcome.text));
  body.append(article);
  row.append(sender, avatar, body);
  return row;
}
// Business hours line under the presence text (Thai time, as configured in Center).
const bangkokDay = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
function hoursClock(ms) {
  const options = { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' };
  if (bangkokDay(ms) !== bangkokDay(Date.now())) options.weekday = 'short';
  return new Intl.DateTimeFormat(undefined, options).format(ms) + ' (GMT+7)';
}
function renderHours() {
  const hours = state?.hours, node = $('hours');
  if (!hours?.enabled || hours.valid === false || typeof hours.open !== 'boolean') { node.hidden = true; node.replaceChildren(); return; }
  const label = document.createElement('span'); label.textContent = hours.open ? 'Open now' : 'Outside business hours';
  const when = hours.open ? hours.closes_at : hours.next_open_at;
  const detail = when ? privateNode('span', ' · ' + (hours.open ? '–' : '→ ') + hoursClock(when)) : null;
  node.replaceChildren(...[label, detail].filter(Boolean));
  node.classList.toggle('closed', !hours.open); node.hidden = false;
}
function renderHistory() {
  const shown = [...messages, ...outbox], welcome = welcomeVisible();
  const signature = shown.map(x => x.id).join('|') + (welcome ? '|welcome:' + state.welcome.text : '');
  if (rendered === signature) return;
  rendered = signature;
  const atBottom = $('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 70;
  const present = new Set(messages.flatMap(message => (message.attachments || []).map(file => file.id)));
  for (const [id, url] of imageUrls) if (!present.has(id)) { URL.revokeObjectURL(url); urls.delete(url); imageUrls.delete(id); }
  const nodes = [];
  shown.forEach((message, index) => {
    const previous = shown[index - 1];
    if (!previous || dayStart(previous.created_at) !== dayStart(message.created_at)) nodes.push(daySeparator(message.created_at));
    if (message.event) {
      const node = document.createElement('div'); node.className = 'chat-event';
      const { label, detail } = supportEventParts(message);
      node.append(document.createTextNode(label), ...(detail ? [privateNode('span', ': ' + detail)] : []), privateNode('small', new Date(message.created_at).toLocaleString()));
      nodes.push(node); return;
    }
    nodes.push(messageNode(message, previous, shown[index + 1]));
  });
  if (welcome) nodes.push(welcomeNode());
  $('history').replaceChildren(...nodes);
  if (lightboxId) queueMicrotask(() => { if (lightboxId) showImage(lightboxId); });
  if (atBottom || outbox.length) $('history').scrollTop = $('history').scrollHeight;
}
$('history').addEventListener('scroll', () => {
  const history = $('history'); followLatest = history.scrollHeight - history.scrollTop - history.clientHeight < 70;
}, { passive: true });
// The auto-growing composer and panel resizes shrink the history; keep the newest message in view.
new ResizeObserver(() => { if (followLatest) $('history').scrollTop = $('history').scrollHeight; }).observe($('history'));
const thumbs = () => [...$('history').querySelectorAll('.attachment-thumb.ready')];
function showImage(id) {
  const list = thumbs(), index = list.findIndex(button => thumbFiles.get(button)?.id === id);
  const file = thumbFiles.get(list[index]), url = imageUrls.get(id);
  // A thumbnail that is being re-rendered keeps the current image until its replacement is ready.
  if (!file || !url) { if (!imageUrls.has(id) && !imageLoads.has(id)) closeLightbox(); return; }
  lightboxId = id;
  $('lightbox-image').src = url; $('lightbox-image').alt = file.name; $('lightbox-image').classList.remove('zoomed');
  $('lightbox-name').textContent = file.name; $('lightbox-count').textContent = list.length > 1 ? index + 1 + ' / ' + list.length : '';
  $('lightbox-download').href = url; $('lightbox-download').download = file.name;
  $('lightbox-prev').hidden = $('lightbox-next').hidden = list.length < 2;
}
// In the page dock the viewer covers the whole browser viewport, not just the panel.
// The frame asks the dock to cover the page; the panel itself stays where it was.
const docked = () => parent !== window && dock;
function panelStyle(layout) {
  const style = document.body.style;
  for (const [key, value] of Object.entries({ right: layout.right, bottom: layout.bottom, width: layout.width, height: layout.height }))
    if (Number.isFinite(value) && value >= 0) style.setProperty('--panel-' + key, value + 'px');
}
function enterViewer() {
  if (!docked() || 'viewer' in document.body.dataset) return;
  panelStyle({ ...panelLayout, width: innerWidth, height: innerHeight });
  document.body.dataset.viewer = '';
  parent.postMessage({ type: 'TP_SUPPORT_GEOMETRY', view: 'viewer' }, '*');
}
function exitViewer() {
  if (!('viewer' in document.body.dataset)) return;
  delete document.body.dataset.viewer;
  if (docked()) parent.postMessage({ type: 'TP_SUPPORT_GEOMETRY', view }, '*');
}
function openLightbox(id, opener) {
  if (!imageUrls.has(id)) return;
  lightboxOpener = opener; toggleAccount(false);
  $('lightbox').hidden = false; showImage(id);
  if (!$('lightbox').hidden) { enterViewer(); $('lightbox-close').focus(); }
}
function stepLightbox(delta) {
  const list = thumbs(), index = list.findIndex(button => thumbFiles.get(button)?.id === lightboxId);
  if (list.length < 2) return;
  showImage(thumbFiles.get(list[(Math.max(index, 0) + delta + list.length) % list.length]).id);
}
function closeLightbox(restoreFocus = true) {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true; lightboxId = '';
  exitViewer();
  $('lightbox-image').removeAttribute('src'); $('lightbox-download').href = '#';
  $('lightbox-name').textContent = ''; $('lightbox-count').textContent = '';
  const opener = lightboxOpener; lightboxOpener = null;
  if (restoreFocus) (opener?.isConnected ? opener : $('text')).focus();
}
function toggleAccount(open = $('account-menu').hidden) {
  $('account-menu').hidden = !open; $('account-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('signout').focus();
}
function autosize() {
  const text = $('text');
  text.style.height = 'auto';
  text.style.height = Math.min(text.scrollHeight, 132) + 'px';
}
async function refresh() {
  if (polling || document.hidden) return;
  polling = true;
  let guard = generation;
  try {
    const identity = await client.scope(), nextScope = await supportScopeId(identity);
    if (guard !== generation) return;
    if (scope && scope !== nextScope) { clearPrivate(); guard = generation; }
    const next = await client.request('/paid/support', { identity });
    const key = await supportDraftScope(identity, next.email);
    if (guard !== generation) return;
    scope = nextScope; state = next; authIdentity = identity;
    if (draftScope !== key) { draftScope = key; await hydrateDraft(); }
    else if (!busy && !uploading && !attaching) await hydrateDraft();
    if (guard !== generation) return;
    await syncSupportVisibility(next, scope);
    if (guard !== generation) return;
    $('identity').textContent = next.email;
    if (view === 'expanded') {
      // After the first page only fetch newer messages (cursor), not the last 100 again.
      const incremental = messages.length > 0;
      const data = await client.request('/paid/support/messages' + (incremental ? '?after=' + messages.at(-1).seq : ''), { identity });
      if (guard !== generation) return;
      mergeMessages(data, incremental);
      await markRead(identity, guard);
      if (guard !== generation) return;
    } else renderHistory();
    controls(); if (!draftSaveError) $('error').textContent = '';
    live.start();
  } catch (error) {
    if (guard !== generation) return;
    if (error.status === 401 || ['SIGN_IN_REQUIRED', 'SESSION_SCOPE_MISMATCH', 'STALE_SUPPORT_RESPONSE'].includes(error.code)) { clearPrivate(); controls(); }
    failure(error);
  } finally { polling = false; }
}
function mergeMessages(data, incremental) {
  if (!incremental) hasOlder = data.has_more;
  const byId = new Map([...messages, ...data.items].map(x => [x.id, x]));
  messages = [...byId.values()].sort((a, b) => a.seq - b.seq);
  // A newer page than one batch leaves a gap: reload the latest page instead of guessing.
  if (incremental && data.has_more) { messages = data.items.slice(); hasOlder = true; }
  const stored = new Set(messages.map(x => x.id));
  outbox = outbox.filter(item => !stored.has(item.confirmedId));
  renderHistory();
  $('older').hidden = !hasOlder;
}
async function markRead(identity, guard) {
  const last = messages.at(-1)?.seq;
  if (!state?.thread || !last || last <= state.thread.read_seq) return;
  await client.request('/paid/support/action', { identity, body: { command_id: uuid(), action: 'read', seq: last } });
  if (guard !== generation) return;
  state.thread.read_seq = last; state.thread.unread = 0;
  await setStorage({ supportUnread: { scope, unread: 0, lastSeq: state.thread.last_seq, lastAdminSeq: state.thread.last_admin_seq || 0 } });
}
// Near-real-time: one long-poll while this chat is visible (expanded panel, the page
// bubble, or the standalone window). Falls back to the 15 s refresh on older servers.
const liveCursor = () => ({
  after: view === 'expanded' && messages.length ? messages.at(-1).seq : state?.thread?.last_seq || 0,
  version: state?.thread?.updated_at || 0,
});
async function applyLive(result) {
  const guard = generation, identity = authIdentity;
  if (!identity || !result?.state || typeof result.state !== 'object') return;
  const previousEmail = state?.email;
  state = result.state;
  if (previousEmail && state.email !== previousEmail) { await refresh(); return; }
  if (scope) await syncSupportVisibility(result.state, scope);
  if (guard !== generation) return;
  if (result.changed && view === 'expanded' && Array.isArray(result.items)) {
    mergeMessages(result, liveCursor().after > 0 && messages.length > 0);
    await markRead(identity, guard).catch(failure);
  } else renderHistory();
  if (guard !== generation) return;
  controls();
  if (result.changed && view !== 'expanded') await notify();
}
// The long-poll runs only while the chat is expanded, or for a short time
// after the customer sent a message while it waits for the admin's answer. A
// minimized launcher gets unread counts from the background (change tokens).
const AWAIT_REPLY_MS = 10 * 60000;
let sentAt = 0;
const awaitingReply = () => sentAt > 0 && Date.now() - sentAt < AWAIT_REPLY_MS &&
  (!state?.thread || state.thread.state === 'waiting_admin') && !(state?.thread?.unread > 0);
const liveWanted = () => view === 'expanded' || (view !== 'hidden' && awaitingReply());
const live = createLiveUpdates({
  shouldRun: () => !document.hidden && view !== 'hidden' && Boolean(authIdentity) && (docked() || parent === window) && liveWanted(),
  wait: signal => client.request(waitPath({ ...liveCursor(), timeout: 25 }), { identity: authIdentity, signal, timeoutMs: 40000 }),
  onResult: applyLive,
  onFallbackTick: async () => { await refresh(); if (view !== 'expanded') await notify(); },
  onAuthError: async error => { clearPrivate(); controls(); failure(error); },
  log,
});
async function hydrateDraft() {
  const key = draftScope, guard = generation, write = draftWrite;
  if (!key) return;
  await write;
  if (draftSaveError) return;
  const record = await readDraft(key);
  if (key !== draftScope || guard !== generation) return;
  if (write !== draftWrite) return hydrateDraft();
  sharedDraft = record;
  if ($('text').value !== record.text) { $('text').value = record.text; autosize(); }
  for (const item of files) if (item.url) { URL.revokeObjectURL(item.url); urls.delete(item.url); }
  files = record.files.map(item => ({ ...item, url: item.file.type.startsWith('image/') ? URL.createObjectURL(item.file) : '' }));
  for (const item of files) if (item.url) urls.add(item.url);
  renderFiles(); controls();
}
function renderFiles() {
  $('files').replaceChildren(...files.map(item => {
    const node = privateNode('div', item.meta?.name || item.file.name); node.className = 'file';
    if (item.url) { const img = privateNode('img'); img.src = item.url; img.alt = item.file.name; node.prepend(img); }
    const remove = privateNode('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove attachment');
    remove.disabled = busy || uploading || attaching || Boolean(sharedDraft?.pending);
    remove.onclick = async () => {
      if (busy || uploading || attaching) return;
      try { await removeDraftFile(draftScope, item.command); await hydrateDraft(); } catch (error) { failure(error); }
    };
    node.append(remove);
    if (!item.meta) {
      const retry = privateNode('button', 'Retry upload'); retry.type = 'button'; retry.disabled = busy || uploading || attaching;
      retry.onclick = () => uploadItem(item).catch(failure); node.append(retry);
    }
    return node;
  }));
}
async function uploadItem(item) {
  if (!item || busy || uploading || !state?.enabled) return;
  const guard = generation, account = draftScope, identity = authIdentity;
  if (!identity) return;
  uploading = true; controls(); $('error').textContent = 'Uploading…';
  try {
    const meta = await client.request('/paid/support/attachments', { file: item.file, commandId: item.command, identity });
    await updateDraftFile(account, item.command, meta);
    if (guard === generation && account === draftScope) { await hydrateDraft(); $('error').textContent = ''; }
  } catch (error) { if (guard === generation && account === draftScope) failure(error); }
  finally { if (guard === generation) { uploading = false; await hydrateDraft(); controls(); } }
}
async function attach(file) {
  if (!state?.enabled || !file || !authIdentity) return;
  if (busy || uploading) throw new Error('Wait for the current upload or send to finish.');
  if (file.size > state.max_file_mb * 1048576) throw new Error('The file exceeds the attachment limit.');
  const account = draftScope, guard = generation, command = uuid();
  uploading = true; controls();
  try {
    await draftWrite;
    if (guard !== generation || account !== draftScope) return;
    await addDraftFile(account, file, command);
    if (guard !== generation || account !== draftScope) return;
    await hydrateDraft();
  } finally { if (guard === generation) { uploading = false; controls(); } }
  if (guard === generation && account === draftScope) await uploadItem(files.find(item => item.command === command));
}
async function attachFiles(selected) {
  if (!selected.length || !state?.enabled || !authIdentity || !sharedDraft) return;
  if (busy || uploading || attaching) throw new Error('Wait for the current upload or send to finish.');
  const account = draftScope, guard = generation;
  attaching = true; controls();
  try {
    await draftWrite;
    const record = await readDraft(account);
    if (guard !== generation || account !== draftScope) return;
    if (record.pending) throw new Error('Retry Send to confirm the previous message.');
    if (selected.some(file => file.size > state.max_file_mb * 1048576)) throw new Error('The file exceeds the attachment limit.');
    if (record.files.length + selected.length > 6 || [...record.files.map(item => item.file), ...selected].reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES)
      throw new Error('Up to 6 files, 40 MB total.');
    for (const file of selected) {
      if (guard !== generation || account !== draftScope) break;
      await attach(file);
    }
  } finally { if (guard === generation) { attaching = false; controls(); } }
}
$('file').addEventListener('change', () => { const selected = [...$('file').files]; $('file').value = ''; attachFiles(selected).catch(failure); });
$('text').addEventListener('input', () => {
  autosize();
  activity('typing');
  const key = draftScope, text = $('text').value;
  draftWrite = draftWrite.catch(() => {}).then(() => setDraftText(key, text)).then(record => { if (key === draftScope) { sharedDraft = record; draftSaveError = null; } }).catch(error => { if (key === draftScope) { draftSaveError = error; failure(error); } });
});
$('text').addEventListener('paste', event => {
  const selected = [...(event.clipboardData?.files || [])];
  if (!selected.length) for (const item of event.clipboardData?.items || []) {
    if (item.kind === 'file') { const file = item.getAsFile(); if (file) selected.push(file); }
  }
  if (selected.length) { event.preventDefault(); attachFiles(selected).catch(failure); }
});
$('text').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat && !$('send').disabled) $('compose').requestSubmit($('send'));
});
$('compose').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || uploading || attaching || !state?.enabled || !sharedDraft) return;
  const key = draftScope, guard = generation, identity = authIdentity;
  if (!identity) return;
  const restoreFocus = document.activeElement === $('text'), text = $('text').value;
  busy = true; controls();
  let pending;
  try {
    await draftWrite;
    if (draftSaveError) throw draftSaveError;
    if (key !== draftScope || guard !== generation) return;
    // Synthetic/paste changes still pass through the same durable transaction.
    if (!sharedDraft.pending && text !== sharedDraft.text) sharedDraft = await setDraftText(key, text);
    if (key !== draftScope || guard !== generation) return;
    const claimed = await claimDraft(key, sharedDraft.revision, draftOwner); pending = claimed.pending.body;
    if (key !== draftScope || guard !== generation) { await settleDraft(key, pending.command_id, draftOwner, false); return; }
    sharedDraft = claimed;
    // Optimistic bubble: visible at once; confirmed when the stored message arrives.
    const local = { id: 'local:' + pending.command_id, seq: Number.MAX_SAFE_INTEGER, sender: 'customer', created_at: Date.now(),
      text: pending.text, attachments: [], pending: true, files: pending.attachments.length };
    outbox = [local]; renderHistory();
    const sent = await client.request('/paid/support/messages', { body: pending, identity });
    local.confirmedId = sent?.id;
    // Wait for the admin's answer (live while expanded/awaiting; the
    // background follows up with a bounded backoff after that).
    sentAt = Date.now(); void runtime({ type: 'TP_SUPPORT_SENT' });
    await settleDraft(key, pending.command_id, draftOwner, true);
    if (key === draftScope && guard === generation) { await hydrateDraft(); await refresh(); }
    // Confirmed but not fetched yet (a refresh was already running): keep it as sent until
    // the stored copy arrives through the live update or the next refresh.
    if (outbox.includes(local)) { local.pending = false; rendered = ''; renderHistory(); }
  } catch (error) {
    if (outbox.length) { outbox = []; renderHistory(); }
    if (pending && error.status === 404 && error.code === 'NOT_FOUND') {
      await recoverDraftFiles(key, pending.command_id); error = new Error('Attachment expired. Retry upload.');
    } else if (pending) await settleDraft(key, pending.command_id, draftOwner, false).catch(() => {});
    if (key === draftScope && guard === generation) { failure(error); await hydrateDraft(); }
  } finally { if (guard === generation) {
    busy = false; controls();
    if (restoreFocus && view === 'expanded' && document.hasFocus() && document.activeElement === document.body && !$('text').disabled) $('text').focus();
  } }
});
$('request-code').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!$('email').checkValidity()) { $('email').reportValidity(); return; }
  if (Date.now() < resendAt) { failure(new Error('Please wait before requesting another code.')); return; }
  $('request-code').disabled = true;
  try {
    const values = await getStorage(['uiLanguageV1']);
    // One install id per browser profile (reuses an older paidDeviceId if present).
    const device = await installId({ read: getStorage, write: setStorage });
    const result = await client.request('/paid/auth/request', { auth: false, body: { email, ui_language: values.uiLanguageV1 || 'en', device_id: device } });
    loginEmail = email; resendAt = Date.now() + Math.max(60, Number(result.resend_after_seconds || 60)) * 1000;
    $('error').textContent = 'Check your email for the code.';
    $('code').focus();
  } catch (error) { failure(error); }
  finally { $('request-code').disabled = false; }
});
$('login').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if (!loginEmail || loginEmail !== $('email').value.trim()) { failure(new Error('Request a code for this email first.')); return; }
  busy = true; $('verify').disabled = true;
  try { await client.signIn(loginEmail, $('code').value); $('code').value = ''; loginEmail = ''; await activateSupport(client); await refresh(); }
  catch (error) { failure(error); }
  finally { busy = false; $('verify').disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.supportDraftChanged?.newValue?.scope === draftScope && !busy && !uploading && !attaching) hydrateDraft().catch(failure);
});
$('end').addEventListener('click', async () => {
  if (!state?.thread || busy || uploading || attaching) return;
  const close = state.thread.state !== 'resolved';
  if (close && !confirm(uiMessage('End this chat? Your history stays saved. You can reopen it later.'))) return;
  busy = true; controls();
  try {
    await client.request('/paid/support/action', { identity: authIdentity, body: { command_id: uuid(), action: close ? 'close' : 'reopen', expected_seq: state.thread.last_seq } });
    await setStorage({ supportChatMuted: close ? { scope } : null, ...(close ? { supportDockHidden: true, supportHideUntil: null } : { supportDockHidden: false }) });
    await refresh();
    if (close) await changeView('hidden');
  }
  catch (error) { failure(error); await refresh(); }
  finally { busy = false; controls(); }
});
$('older').addEventListener('click', async () => {
  try {
    const data = await client.request('/paid/support/messages?before=' + messages[0].seq);
    messages = [...data.items, ...messages]; rendered = ''; renderHistory(); hasOlder = data.has_more; $('older').hidden = !hasOlder;
  } catch (error) { failure(error); }
});
$('signout').addEventListener('click', async () => { if (!confirm(uiMessage('Sign out of this account?'))) return; try { await client.signOut(); clearPrivate(); controls(); } catch (error) { failure(error); } });
$('minimized').onclick = () => changeView('expanded').catch(failure);
$('minimize').onclick = () => changeView('minimized').catch(failure);
async function hideChat() {
  const saved = await getStorage(['supportUnread']);
  await setStorage({ supportDockHidden: true, supportHideUntil: { scope, lastAdminSeq: Math.max(state?.thread?.last_admin_seq || 0, saved.supportUnread?.scope === scope ? saved.supportUnread.lastAdminSeq || 0 : 0) } });
  await changeView('hidden');
}
$('hide').onclick = () => windowMode ? window.close() : hideChat().catch(failure);
if (windowMode) {
  document.body.dataset.mode = 'window';
  $('minimize').hidden = true;
  $('hide').setAttribute('aria-label', 'Close chat'); $('hide').title = 'Close chat';
}
$('account-toggle').onclick = () => toggleAccount();
$('signout').addEventListener('click', () => toggleAccount(false));
document.addEventListener('click', event => {
  if (!$('account-menu').hidden && !event.target.closest?.('#account-menu, #account-toggle')) toggleAccount(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('account-menu').hidden || !$('lightbox').hidden) return;
  event.preventDefault(); toggleAccount(false); $('account-toggle').focus();
});
$('lightbox-close').onclick = () => closeLightbox();
$('lightbox-prev').onclick = () => stepLightbox(-1);
$('lightbox-next').onclick = () => stepLightbox(1);
$('lightbox-image').onclick = () => $('lightbox-image').classList.toggle('zoomed');
$('lightbox').addEventListener('click', event => { if (event.target === $('lightbox') || event.target === $('lightbox-stage')) closeLightbox(); });
document.addEventListener('keydown', event => {
  if ($('lightbox').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLightbox(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepLightbox(event.key === 'ArrowLeft' ? -1 : 1); }
  else if (event.key === 'Tab') {
    // Keep keyboard focus inside the modal viewer.
    const focusable = [...$('lightbox').querySelectorAll('a[href], button')].filter(node => !node.hidden && !node.disabled);
    const first = focusable[0], last = focusable.at(-1);
    if (!$('lightbox').contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$('preview-open').onclick = () => changeView('expanded').catch(failure);
$('preview-dismiss').onclick = () => changeView('minimized').catch(failure);
async function parentMessage(event) {
  if (event.source !== parent) return;
  if (parent !== window && !dock) return;
  if (!['TP_SUPPORT_VIEW', 'TP_SUPPORT_REPLY', 'TP_SUPPORT_LAYOUT'].includes(event.data?.type)) return;
  if (parent !== window) {
    if (!event.data?.channel) return;
    const result = await runtime({ type: 'TP_SUPPORT_CHANNEL' });
    const allowed = result?.channel && result.channel === event.data?.channel;
    if (!allowed) return;
    if (event.data.type === 'TP_SUPPORT_LAYOUT') { applyLayout(event.data); return; }
    const saved = await getStorage(['supportDockHidden']);
    if (saved.supportDockHidden && event.data?.view !== 'hidden') return;
  }
  if (event.source === parent && event.data?.type === 'TP_SUPPORT_REPLY') { void notify(); return; }
  if (event.source !== parent || event.data?.type !== 'TP_SUPPORT_VIEW' || !['expanded', 'minimized', 'hidden', 'preview'].includes(event.data.view)) return;
  changeView(event.data.view).catch(failure);
}
// The dock reports where the panel sits (corner panel, or a full-width sheet on phones).
function applyLayout(data) {
  const panel = data?.panel && typeof data.panel === 'object' ? data.panel : {};
  const layout = ['panel', 'sheet'].includes(data?.layout) ? data.layout : 'panel';
  panelLayout = { layout, ...Object.fromEntries(['right', 'bottom', 'width', 'height']
    .map(key => [key, Number.isFinite(panel[key]) ? Math.max(0, Math.round(panel[key])) : panelLayout[key]])) };
  document.body.dataset.layout = layout;
  if ('viewer' in document.body.dataset) panelStyle(panelLayout);
}
window.addEventListener('message', event => { parentMessage(event).catch(failure); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault'].some(key => changes[key])) { client.invalidate(); clearPrivate(); controls(); if (view === 'expanded' && !busy) refresh(); }
  if (changes.supportUnread) {
    const data = changes.supportUnread.newValue;
    if (data?.scope === scope) { $('unread').textContent = data.unread ? String(data.unread) : ''; }
  }
  if (changes.supportDockHidden?.newValue === true && view !== 'hidden') changeView('hidden').catch(failure);
  if (changes.supportDockHidden?.newValue === false && parent === window && view === 'hidden') changeView('minimized').catch(failure);
});
async function notify() {
  if (document.hidden || view === 'hidden') return;
  try {
    const saved = await getStorage(['supportUnread', 'supportNoticeSeen', 'supportDockHidden', 'supportChatMuted']);
    if (saved.supportDockHidden) return;
    const identity = await client.scope(), id = await supportScopeId(identity), unread = saved.supportUnread;
    scope = id;
    if (saved.supportChatMuted?.scope === id) return;
    if (!unread || unread.scope !== id || !unread.unread || saved.supportNoticeSeen === id + ':' + unread.lastSeq) return;
    $('unread').textContent = String(unread.unread);
    if (view === 'expanded') await refresh();
    // A reply updates the launcher badge; only a user click expands chat.
    await setStorage({ supportNoticeSeen: id + ':' + unread.lastSeq });
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { live.stop(); return; }
  if (view === 'expanded') refresh(); else notify();
  live.start();
});
const saved = await getStorage(['supportDockView', 'supportDockHidden', 'paidEmail']);
$('email').value = saved.paidEmail || '';
if (parent !== window || saved.supportDockHidden) {
  view = 'hidden';
  document.body.dataset.view = 'hidden'; $('expanded').hidden = true; $('minimized').hidden = true; $('preview').hidden = true;
} else await changeView('expanded').catch(failure);
await notify();
// No periodic refresh or presence timers. While expanded the live loop keeps
// the conversation current (its own fallback covers older servers); a minimized
// launcher follows supportUnread in storage. Presence is reported while expanded
// (on expand, focus, typing); the background sends it at most every 2 min.
function activity(reason = 'expanded') {
  if (document.hidden || view !== 'expanded' || (reason !== 'typing' && !document.hasFocus())) return;
  void runtime({ type: 'TP_SUPPORT_ACTIVITY', reason });
}
window.addEventListener('focus', () => activity('expanded'));
if (parent !== window && dock) parent.postMessage({ type: 'TP_SUPPORT_READY' }, '*');
