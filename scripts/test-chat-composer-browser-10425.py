"""Real Chromium DOM/IndexedDB composer QA; offline API and Chrome API boundary fixtures.

Native clipboard coverage is reported separately from synthetic file ClipboardEvents.
This does not claim an installed extension or a live Center/email test.
"""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import argparse
import ast
import asyncio
import base64
import hashlib
import json
import os
import tempfile
import traceback
import types
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--extension-root', type=Path, required=True)
parser.add_argument('--output', type=Path, default=None)
parser.add_argument('--browser', default=chromium_executable(required=False))
args = parser.parse_args()
PROJECT = args.extension_root.resolve()
OUT = (args.output or Path(tempfile.mkdtemp(prefix='tp-composer-qa-'))).resolve()
OUT.mkdir(parents=True, exist_ok=True)
os.environ['TP_QA_EXTENSION_ROOT'] = str(PROJECT)
os.environ['TP_QA_OUTPUT'] = str(OUT)

# The existing fixture is intentionally not import-safe. Remove exactly its
# terminal asyncio.run(main()) expression; do not execute its historical suite.
fixture_path = PROJECT / 'scripts/test-support-browser-10422.py'
tree = ast.parse(fixture_path.read_text(), filename=str(fixture_path))
last = tree.body[-1]
assert isinstance(last, ast.Expr) and isinstance(last.value, ast.Call)
assert isinstance(last.value.func, ast.Attribute) and last.value.func.attr == 'run'
assert isinstance(last.value.func.value, ast.Name) and last.value.func.value.id == 'asyncio'
assert len(last.value.args) == 1 and isinstance(last.value.args[0], ast.Call)
assert isinstance(last.value.args[0].func, ast.Name) and last.value.args[0].func.id == 'main'
tree.body.pop()
fixtures = types.ModuleType('support_browser_offline_fixture')
fixtures.__file__ = str(fixture_path)
exec(compile(tree, str(fixture_path), 'exec'), fixtures.__dict__)

results = []
clipboard = {}
page_errors = []
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY7cAAAAASUVORK5CYII=')


async def check(name, function, timeout=25):
    print('RUN', name, flush=True)
    try:
        evidence = await asyncio.wait_for(function(), timeout)
        result = {'name': name, 'passed': True}
        if evidence is not None:
            result['evidence'] = evidence
    except Exception as error:
        traceback.print_exc()
        result = {'name': name, 'passed': False, 'error': str(error)[:1200]}
    results.append(result)
    print('RESULT', json.dumps(result), flush=True)


def message_posts(requests):
    return [json.loads(item['body']) for item in requests
            if item['method'] == 'POST' and item['url'].endswith('/messages')]


def upload_posts(requests):
    return [item for item in requests
            if item['method'] == 'POST' and item['url'].endswith('/attachments')]


async def ready(page):
    await page.wait_for_function('!document.getElementById("send").disabled', timeout=12000)


async def idle(page):
    await page.wait_for_function('document.getElementById("text").value === "" && !document.getElementById("send").disabled', timeout=12000)


async def paste_files(page, specs, via_items=False):
    return await page.evaluate('''({specs, viaItems}) => {
      const files = specs.map(x => new File([new Uint8Array(x.size || 1)], x.name, {type:x.type || 'application/zip'}));
      const data = new DataTransfer(); files.forEach(file => data.items.add(file));
      const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
      if (viaItems) Object.defineProperty(event, 'clipboardData', {value:{files:[], items:files.map(file => ({kind:'file', getAsFile:() => file}))}});
      document.getElementById('text').dispatchEvent(event);
      return {defaultPrevented:event.defaultPrevented};
    }''', {'specs': specs, 'viaItems': via_items})


async def upload_fixture(browser, extra=None, disabled=False, fail_upload_once=False, fail_send_once=False,
                         upload_wait=None, send_wait=None):
    uploads, sends = [], []
    async def handler(route, _store, _state, _items, _requests):
        request = route.request
        if request.url.endswith('/attachments') and request.method == 'POST':
            uploads.append({'name': request.headers['x-file-name'], 'command': request.headers['x-command-id'],
                            'type': request.headers.get('content-type'),
                            'bytes': len(request.post_data_buffer or b''),
                            'sha256': hashlib.sha256(request.post_data_buffer or b'').hexdigest()})
            if upload_wait:
                upload_wait[0].set()
                await upload_wait[1].wait()
            if fail_upload_once and len(uploads) == 1:
                await route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"Temporary upload failure"}}')
            else:
                await route.fulfill(status=200, content_type='application/json', body=json.dumps({
                    'id': 'att_' + str(len(uploads)).zfill(32), 'name': uploads[-1]['name'],
                    'size': uploads[-1]['bytes'], 'type': uploads[-1]['type']}))
            return True
        if request.url.endswith('/messages') and request.method == 'POST':
            sends.append(json.loads(request.post_data))
            if send_wait:
                send_wait[0].set()
                await send_wait[1].wait()
            if fail_send_once and len(sends) == 1:
                await route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"Temporary send failure"}}')
            else:
                await route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
            return True
        return False
    fixture = await fixtures.fixture(browser, extra=extra, disabled=disabled, handler=handler)
    fixture[1].on('pageerror', lambda error: page_errors.append(str(error)))
    fixture[0].on('page', lambda page: page.on('pageerror', lambda error: page_errors.append(str(error))))
    return (*fixture, uploads, sends)


async def run(browser):
    async def enter():
        context, page, store, requests, _, _, uploads, sends = await upload_fixture(browser)
        await page.locator('#text').fill('Send with Enter')
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'Send with Enter' and sends[0]['attachments'] == [], sends
        assert not uploads and not store.get('supportUnread', {}).get('unread')
        await context.close()
        return {'messagePosts': 1, 'clearedDraft': True}
    await check('Real keyboard Enter sends exactly once and clears durable draft', enter)

    async def newline():
        context, page, _, _, _, _, _, sends = await upload_fixture(browser)
        await page.locator('#text').fill('First line')
        await page.locator('#text').press('Shift+Enter')
        await page.keyboard.type('Second line')
        assert await page.locator('#text').input_value() == 'First line\nSecond line'
        assert sends == []
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'First line\nSecond line', sends
        await context.close()
    await check('Real Shift+Enter inserts newline; next Enter sends multiline text', newline)

    async def rapid_typing():
        context, page, _, _, _, _, _, sends = await upload_fixture(browser)
        expected = 'Rapid typing must keep every character 1234567890'
        for index in range(3):
            await page.locator('#text').focus()
            await page.keyboard.type(expected + str(index))
            assert await page.locator('#text').input_value() == expected + str(index)
            await page.locator('#text').press('Enter')
            await idle(page)
            assert sends[-1]['text'] == expected + str(index), sends[-1]
        assert len(sends) == 3
        await context.close()
        return {'rapidSends':3, 'allCharactersPreserved':True}
    await check('Rapid real-keyboard typing plus immediate Enter preserves the complete message across draft broadcasts', rapid_typing)

    async def composition():
        context, page, _, _, _, _, _, sends = await upload_fixture(browser)
        await page.locator('#text').fill('日本語 กำลังพิมพ์')
        await page.locator('#text').evaluate("e=>e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))")
        await page.evaluate("document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))")
        await page.evaluate("document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}))")
        await page.wait_for_timeout(100)
        assert sends == []
        await page.locator('#text').evaluate("e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))")
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'].startswith('日本語'), sends
        await context.close()
        return {'compositionEvents': 'synthetic DOM boundary', 'isComposing': True, 'legacyKeyCode229': True}
    await check('IME isComposing and keyCode229 never send prematurely', composition)

    async def repeat_and_busy():
        entered, release = asyncio.Event(), asyncio.Event()
        context, page, _, _, _, _, _, sends = await upload_fixture(browser, send_wait=(entered, release))
        await page.locator('#text').fill('One message only')
        await page.evaluate("document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}))")
        await page.wait_for_timeout(80)
        assert sends == []
        await page.locator('#text').press('Enter')
        await asyncio.wait_for(entered.wait(), 5)
        await page.evaluate("for(let n=0;n<4;n++) {document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));document.getElementById('compose').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}")
        await page.wait_for_timeout(80)
        assert len(sends) == 1, sends
        release.set()
        await idle(page)
        await context.close()
    await check('Repeated Enter and Enter/form-submit while busy cannot duplicate dispatch', repeat_and_busy)

    async def disabled_noauth():
        evidence = []
        for extra, disabled in [(None, True), ({'paidSessionToken': '', 'paidEmail': ''}, False)]:
            context, page, _, requests, _, _, uploads, sends = await upload_fixture(browser, extra=extra, disabled=disabled)
            await page.evaluate("const text=document.getElementById('text');text.value='Do not send';text.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));document.getElementById('compose').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));")
            await paste_files(page, [{'name':'blocked.zip'}])
            await page.wait_for_timeout(150)
            assert not uploads and not sends, (uploads, sends)
            evidence.append({'mode':'disabled' if disabled else 'no-auth', 'posts':0})
            await context.close()
        return evidence
    await check('Disabled support and signed-out composer block Enter, submit and pasted attachments', disabled_noauth)

    async def native_text():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await context.grant_permissions(['clipboard-read','clipboard-write'], origin=fixtures.BASE)
        await page.evaluate("navigator.clipboard.writeText('Plain clipboard text ก')")
        await page.locator('#text').focus()
        await page.keyboard.press('Control+V')
        await page.wait_for_function("document.getElementById('text').value==='Plain clipboard text ก'")
        assert not uploads and not sends
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'Plain clipboard text ก'
        clipboard['nativeTextCtrlV'] = 'passed'
        await context.close()
    await check('Native Chromium clipboard Ctrl+V keeps plain text editable and does not attach or send', native_text)

    async def native_image():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await context.grant_permissions(['clipboard-read','clipboard-write'], origin=fixtures.BASE)
        await page.evaluate('''async () => {
          const canvas = document.createElement('canvas'); canvas.width=8; canvas.height=8;
          const ctx = canvas.getContext('2d'); ctx.fillStyle='#c50'; ctx.fillRect(0,0,8,8);
          const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
          await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        }''')
        await page.locator('#text').focus()
        await page.keyboard.press('Control+V')
        await page.locator('#files .file').wait_for()
        await ready(page)
        assert len(uploads) == 1 and uploads[0]['bytes'] > 0 and sends == [], (uploads, sends)
        assert await page.locator('#files .file img').count() == 1
        await page.screenshot(path=str(OUT/'native-image-before-send.png'))
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and len(sends[0]['attachments']) == 1 and sends[0]['text'] == '', sends
        clipboard['nativeImageCtrlV'] = 'passed'
        await context.close()
        return {'paste':'native Ctrl+V ClipboardItem PNG', 'stagedBeforeSend':True}
    await check('Native Ctrl+V PNG stages preview/upload; Enter explicitly sends attachment-only message', native_image)

    async def multi_files():
        context, page, store, _, _, _, uploads, sends = await upload_fixture(browser)
        await page.locator('#text').fill('Keep this draft')
        event = await paste_files(page, [{'name':'first.zip','size':11},{'name':'second.txt','size':7,'type':'text/plain'},{'name':'third.png','size':9,'type':'image/png'}])
        await page.wait_for_function('document.querySelectorAll("#files .file").length===3')
        await ready(page)
        assert event['defaultPrevented'] and len(uploads) == 3 and sends == []
        assert [x['name'] for x in uploads] == ['first.zip','second.txt','third.png'], uploads
        assert len(set(x['command'] for x in uploads)) == 3
        assert await page.locator('#text').input_value() == 'Keep this draft'
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'Keep this draft'
        assert sends[0]['attachments'] == ['att_' + str(n).zfill(32) for n in [1,2,3]], sends
        assert all('first.zip' not in json.dumps(value) and 'Keep this draft' not in json.dumps(value) for value in store.values())
        await context.close()
        return {'clipboardBoundary':'synthetic DataTransfer', 'files':3, 'messagePosts':1}
    await check('Multi-file paste preserves order, drafts and unique upload commands; no auto-send', multi_files)

    async def items_fallback():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        event = await paste_files(page, [{'name':'items-only.zip','size':13}], via_items=True)
        await page.locator('#files .file').wait_for()
        await ready(page)
        assert event['defaultPrevented'] and len(uploads) == 1 and uploads[0]['name'] == 'items-only.zip' and sends == []
        await context.close()
    await check('Clipboard items.getAsFile fallback accepts browser-exposed file when files collection is empty', items_fallback)

    async def paste_batch_limit():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await paste_files(page, [{'name':f'kept-{n}.zip'} for n in range(5)])
        await page.wait_for_function('document.querySelectorAll("#files .file").length===5')
        await ready(page)
        await page.locator('#text').fill('Preserve me')
        await paste_files(page, [{'name':'excess-one.zip'}, {'name':'excess-two.zip'}])
        await page.locator('#error').filter(has_text='Up to 6 files').wait_for()
        assert len(uploads) == 5 and await page.locator('#files .file').count() == 5
        assert await page.locator('#text').input_value() == 'Preserve me' and not sends
        await page.get_by_role('button', name='Remove attachment').first.click()
        await page.wait_for_function('document.querySelectorAll("#files .file").length===4')
        await paste_files(page, [{'name':'now-one.zip'}, {'name':'now-two.zip'}])
        await page.wait_for_function('document.querySelectorAll("#files .file").length===6')
        await ready(page)
        assert len(uploads) == 7 and not sends
        await context.close()
    await check('Six-file limit rejects entire pasted batch before upload; remove frees room for whole batch', paste_batch_limit)

    async def picker_multi():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        assert await page.locator('#file').get_attribute('multiple') is not None
        await page.locator('#file').set_input_files([
            {'name':'picked-first.zip','mimeType':'application/zip','buffer':b'PKfirst'},
            {'name':'picked-second.txt','mimeType':'text/plain','buffer':b'contents'}])
        await page.wait_for_function('document.querySelectorAll("#files .file").length===2')
        await ready(page)
        assert [item['name'] for item in uploads] == ['picked-first.zip','picked-second.txt'] and not sends
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and len(sends[0]['attachments']) == 2
        await context.close()
    await check('Real file-picker multiple selection shares the staged batch path and Enter sends all ids once', picker_multi)

    async def oversized():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await page.locator('#text').fill('Keep text')
        await paste_files(page, [{'name':'small.zip','size':1}, {'name':'too-big.zip','size':20*1048576+1}])
        await page.locator('#error').filter(has_text='attachment limit').wait_for()
        assert not uploads and not sends and await page.locator('#files .file').count() == 0
        assert await page.locator('#text').input_value() == 'Keep text'
        await context.close()
    await check('Per-file oversize rejects pasted batch without partial uploads or lost draft', oversized)

    async def total_bytes_cap():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await paste_files(page, [{'name':'exact-one.zip','size':20*1048576},{'name':'exact-two.zip','size':20*1048576}])
        await page.wait_for_function('document.querySelectorAll("#files .file").length===2', timeout=18000)
        await ready(page)
        assert len(uploads) == 2 and sum(item['bytes'] for item in uploads) == 40*1048576 and not sends
        await paste_files(page, [{'name':'one-byte-over.zip','size':1}])
        await page.locator('#error').filter(has_text='40 MB').wait_for()
        assert len(uploads) == 2 and await page.locator('#files .file').count() == 2
        # Do not wait for the asynchronous remove handler to repaint its cached
        # file list. The new batch must validate the current durable record.
        await page.get_by_role('button', name='Remove attachment').first.click()
        await paste_files(page, [{'name':'immediate-after-remove.zip','size':1}])
        await ready(page)
        await page.wait_for_function('document.querySelectorAll("#files .file").length===2')
        assert len(uploads) == 3 and uploads[-1]['name'] == 'immediate-after-remove.zip' and uploads[-1]['bytes'] == 1
        await context.close()
        return {'acceptedBytes':40*1048576, 'rejectedExtraByteBeforePost':True, 'removeThenImmediatePaste':'accepted from durable quota'}
    await check('Pasted batch accepts exactly40MiB; extra byte rejected; immediate paste after removal uses freed quota', total_bytes_cap, timeout=40)

    async def upload_busy():
        entered, release = asyncio.Event(), asyncio.Event()
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser, upload_wait=(entered, release))
        await paste_files(page, [{'name':'pending.zip','size':8}])
        await asyncio.wait_for(entered.wait(), 5)
        await page.locator('#text').fill('Wait for upload')
        await page.locator('#text').press('Enter')
        await paste_files(page, [{'name':'race.zip'}])
        await page.wait_for_timeout(100)
        assert len(uploads) == 1 and not sends
        release.set()
        await ready(page)
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'Wait for upload' and len(sends[0]['attachments']) == 1
        await context.close()
    await check('Enter and second paste during upload cannot send or corrupt attachment batch', upload_busy)

    async def retries():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser, fail_upload_once=True, fail_send_once=True)
        await page.locator('#text').fill('Retry unchanged')
        await paste_files(page, [{'name':'retry.zip','size':12}])
        await page.get_by_role('button', name='Retry upload').wait_for()
        await page.locator('#text').press('Enter')
        await page.wait_for_timeout(100)
        assert not sends and len(uploads) == 1
        await page.get_by_role('button', name='Retry upload').click()
        await ready(page)
        assert len(uploads) == 2 and uploads[0] == uploads[1]
        await page.locator('#text').press('Enter')
        await page.get_by_role('button', name='Retry Send', exact=True).wait_for()
        assert len(sends) == 1
        await page.get_by_role('button', name='Retry Send', exact=True).press('Enter')
        await idle(page)
        assert len(sends) == 2 and sends[0] == sends[1], sends
        await context.close()
        return {'uploadCommandUnchanged':True, 'messageCommandUnchanged':True}
    await check('Failed pasted upload stays staged; retries preserve immutable upload/message commands', retries)

    async def reload_draft():
        context, page, _, _, _, _, uploads, sends = await upload_fixture(browser)
        await page.locator('#text').fill('Draft survives reload')
        await paste_files(page, [{'name':'saved.zip','size':14}])
        await ready(page)
        await page.reload()
        await page.locator('#conversation').wait_for(state='visible')
        await page.wait_for_function('document.getElementById("text").value==="Draft survives reload" && document.querySelectorAll("#files .file").length===1')
        assert len(uploads) == 1 and not sends
        await page.locator('#text').press('Enter')
        await idle(page)
        assert len(sends) == 1 and sends[0]['text'] == 'Draft survives reload' and len(sends[0]['attachments']) == 1
        await context.close()
    await check('Real IndexedDB restores pasted attachments and draft after reload without reupload or autosend', reload_draft)

    async def cross_origin_privacy():
        context, page, store, _, _, _, uploads, sends = await upload_fixture(browser, extra={'supportActivated':True})
        host = await context.new_page()
        await host.goto(fixtures.BASE.replace('localhost', '127.0.0.1') + '/support-host-fixture')
        await host.evaluate("window.received=[];window.addEventListener('message',event=>received.push(event.data))")
        await host.add_script_tag(path=str(PROJECT/'src/content/support-dock.js'))
        frame = await fixtures.dock_frame(host)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})')
        await frame.locator('#conversation').wait_for(state='visible')
        await frame.locator('#text').fill('Private pasted draft')
        await paste_files(frame, [{'name':'private-file.zip','size':19}])
        await ready(frame)
        assert sends == [] and len(uploads) == 1
        boundary = await host.evaluate("() => ({messages:received,dom:document.body.innerText,crossOrigin:(()=>{try{return !!document.querySelector('#textphantom-support-host').shadowRoot.querySelector('iframe').contentDocument?.querySelector('#text')}catch{return false}})()})")
        for message in boundary['messages']:
            assert (message.get('type') == 'TP_SUPPORT_READY' and set(message) == {'type'}) or (message.get('type') == 'TP_SUPPORT_GEOMETRY' and set(message) == {'type','view'}), message
        assert not boundary['crossOrigin'] and 'Private pasted draft' not in json.dumps(boundary) and 'private-file.zip' not in json.dumps(boundary)
        assert 'Private pasted draft' not in json.dumps(store) and 'private-file.zip' not in json.dumps(store)
        await host.screenshot(path=str(OUT/'cross-origin-pasted-file.png'))
        await frame.locator('#text').press('Enter')
        await idle(frame)
        assert len(sends) == 1 and sends[0]['text'] == 'Private pasted draft'
        await context.close()
        return {'publisherMessages':'readiness/geometry only', 'privateDraft':'IndexedDB only'}
    await check('Cross-origin dock Enter and pasted file send privately; publisher receives no text, file or unread payload', cross_origin_privacy)

    async def no_page_errors():
        assert not page_errors, page_errors
        return {'pageErrors':0}
    await check('All composer scenarios produce no uncaught browser promise or page errors', no_page_errors)


async def main():
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(**({'executable_path':args.browser} if args.browser else {}), headless=True, args=['--no-sandbox'])
            try:
                await run(browser)
            finally:
                await browser.close()
    finally:
        fixtures.server.shutdown()
    summary = {'checks':len(results), 'passed':sum(result['passed'] for result in results), 'results':results,
               'sourceSha256':hashlib.sha256((PROJECT/'src/support/chat.js').read_bytes()).hexdigest(),
               'coverage':{'browser':'real Chromium headless DOM/IndexedDB', 'keyboard':'real keyboard Enter/Shift+Enter/Ctrl+V',
                           'clipboard':clipboard, 'copiedFiles':'synthetic ClipboardEvent/DataTransfer browser boundary',
                           'chromeAPIs':'simulated fixture', 'center':'offline API fixture', 'installedExtension':False}}
    (OUT/'composer-browser-report-10425.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2), flush=True)
    if summary['passed'] != summary['checks']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
