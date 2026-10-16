// The consent screen as its own extension tab (10494/10495). Opened by the
// background when a page translation with Paid/Login was blocked (once per
// blocked action; a second attempt focuses this tab), and by the chat dock on
// Firefox, where a web page cannot show the browser prompt. Allow here is a
// click in an extension page.
import { showConsentScreen, accountAllowed } from '../shared/account-gate.js';
import { consentText, consentLanguage } from '../shared/data-consent-dialog.js';

const status = document.getElementById('consent-result');
async function say(key) {
  const thai = await consentLanguage() === 'th';
  // Authored Thai: the interface translator leaves it alone.
  for (const node of [status, again]) { if (thai) { node.setAttribute('translate', 'no'); node.lang = 'th'; } else node.removeAttribute('translate'); }
  status.textContent = await consentText(key);
  again.textContent = await consentText('reviewAllow');
  status.hidden = false;
}
async function ask() {
  if (await accountAllowed()) { await say('allowedTab'); return; }
  status.hidden = true;
  const result = await showConsentScreen({ page: true });
  await say(result.consent ? 'allowedTab' : 'declined');
  // "Don't allow" leaves a way back to the screen in this tab.
  again.hidden = result.consent;
}
const again = document.getElementById('consent-again');
again?.addEventListener('click', () => void ask());
await ask();
