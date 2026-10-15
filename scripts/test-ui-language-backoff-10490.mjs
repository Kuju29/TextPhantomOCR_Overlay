// 10490 E2E finding: with a Thai interface and Google Translate unreachable,
// the support chat frame asked translate.googleapis.com again every 25 s while
// expanded (each long-poll re-render registered the same copy and failed
// translations were not cached). The UI-language controller (support chat,
// popup and every extension page using shared/ui-language.js) now:
// * backs off the phrases of a failed batch: 5 min, then 30 min,
// * never calls Google while its page is hidden (it refreshes when shown),
// * tries again at once on Retry or an explicit language choice.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createUiLanguageController, clearUiTranslationFailures, UI_FAILURE_BACKOFF_MS} from '../src/shared/ui-language.js';
import {uiLanguageDomFixture} from './lib/ui-language-dom-fixture.mjs';

let checks = 0;
const ok = name => { checks++; console.log('PASS ' + name); };
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const translated = url => new Response(JSON.stringify([[[new URL(url).searchParams.get('q').split('\n')
  .map(line => 'แปล ' + line).join('\n')]]]), {status:200});
function fixture() {
  const dom = uiLanguageDomFixture({pathname:'/support/chat.html'}), listeners = {};
  dom.doc.hidden = false;
  dom.doc.addEventListener = (type, fn) => { listeners[type] = fn; };
  dom.doc.removeEventListener = type => { delete listeners[type]; };
  dom.show = () => { dom.doc.hidden = false; listeners.visibilitychange?.(); };
  return dom;
}
const store = () => { const values = {uiLanguageV1:'th'}; return {get:async () => structuredClone(values), set:async patch => Object.assign(values, patch)}; };
// The chat re-renders its copy after each long-poll (new text nodes, same authored text).
const rerender = async dom => { dom.element('Waiting for admin'); dom.element('Send'); await dom.settle(); };

try {
  {
    clearUiTranslationFailures(); offset = 0;
    const dom = fixture(); dom.element('Waiting for admin'); dom.element('Send');
    let calls = 0, online = false;
    const controller = createUiLanguageController({root:dom.root, host:dom.host, storage:store(),
      fetcher:async url => { calls++; if (!online) throw new TypeError('Failed to fetch'); return translated(url); }});
    await controller.ready; await dom.settle();
    const first = calls;
    assert(first >= 1, 'the first refresh asks Google');
    assert.equal(controller.control.dataset.state, 'error');
    for (let i = 0; i < 6; i++) { offset += 25_000; await rerender(dom); }
    assert.equal(calls, first, 'no new request on each 25 s re-render after a failure');
    assert.equal(controller.control.dataset.state, 'error', 'the failure stays visible');
    offset = UI_FAILURE_BACKOFF_MS[0] + 1000; await rerender(dom);
    assert.equal(calls, first + 1, 'one new attempt after 5 minutes');
    offset += UI_FAILURE_BACKOFF_MS[0] + 1000; await rerender(dom);
    assert.equal(calls, first + 1, 'after a second failure the phrases wait 30 minutes');
    offset += UI_FAILURE_BACKOFF_MS[1]; await rerender(dom);
    assert.equal(calls, first + 2);
    // Retry is an explicit request: it goes out at once, even inside the backoff.
    online = true;
    const retry = dom.host.querySelectorAll('button').find(button => button.textContent === '↻');
    retry.handlers.get('click')(); await dom.settle();
    assert(calls > first + 2, 'Retry asks again at once');
    assert.equal(controller.control.dataset.state, 'ready');
    assert.match(dom.root.querySelectorAll('p')[0].textContent, /^แปล /);
    controller.dispose(); dom.restore();
    ok('a failed batch is not re-requested on every re-render: 5 min, then 30 min; Retry asks at once');
  }
  {
    clearUiTranslationFailures(); offset = 0;
    const dom = fixture(); dom.doc.hidden = true; dom.element('Waiting for admin');
    let calls = 0;
    const controller = createUiLanguageController({root:dom.root, host:dom.host, storage:store(),
      fetcher:async url => { calls++; return translated(url); }});
    await controller.ready; await dom.settle();
    await rerender(dom);
    assert.equal(calls, 0, 'no Google request while the page is hidden');
    dom.show(); await dom.settle();
    assert(calls >= 1, 'the page translates when it is shown again');
    assert.match(dom.root.querySelectorAll('p')[0].textContent, /^แปล /);
    controller.dispose(); dom.restore();
    ok('a hidden page never calls Google and refreshes when shown');
  }
  {
    clearUiTranslationFailures(); offset = 0;
    const dom = fixture(); dom.element('Waiting for admin'); dom.element('Send');
    let calls = 0;
    const controller = createUiLanguageController({root:dom.root, host:dom.host, storage:store(),
      fetcher:async () => { calls++; return new Response('busy', {status:503}); }});
    await controller.ready; await dom.settle();
    const first = calls;
    // Choosing the language in the menu is explicit too.
    controller.selector.value = 'th';
    controller.selector.handlers.get('change')(); await dom.settle();
    assert(calls > first, 'an explicit language choice asks again');
    const second = calls;
    await rerender(dom);
    assert.equal(calls, second, 'an HTTP failure is backed off like a network failure');
    controller.dispose(); dom.restore();
    ok('an explicit language choice retries; HTTP failures back off too');
  }
  {
    // Every extension page with the language control uses this controller.
    for (const page of ['src/support/chat.html', 'src/popup/popup.html'])
      assert.match(await readFile(new URL('../' + page, import.meta.url), 'utf8'), /shared\/ui-language-entry\.js/, page);
    ok('support chat and popup use the same backed-off controller');
  }
} finally { Date.now = realNow; }
console.log(`${checks} checks passed`);
