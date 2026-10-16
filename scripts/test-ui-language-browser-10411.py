"""Browser contracts for public UI copy, local values and persistent cache.

Google is an explicit deterministic adapter, including natural Thai/Japanese
labels and malformed replies. This does not certify live Google wording.
"""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import json
import os
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.getenv('TP_UI_LANGUAGE_QA_OUT', '/tmp/textphantom-ui-language-10411'))
OUT.mkdir(parents=True, exist_ok=True)
HTML = '''<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<link rel=stylesheet href=/shared/ui-language.css><body><header id=host></header><main>
<button id=ai>AI settings</button><button id=output>Text output</button><p id=target>Target language</p><p id=otp>6-digit code</p>
<p id=engine>AI translation</p><p id=lens>Google Lens (text)</p><p id=payment>Paid · TextPhantom credits</p>
<input id=key value=PRIVATE_KEY_DO_NOT_SEND><textarea id=prompt>PRIVATE_PROMPT_DO_NOT_SEND</textarea>
<p id=private data-tp-ui-private>AI settings</p><p id=unknown>PRIVATE_ACCOUNT_MESSAGE_DO_NOT_SEND</p>
<select id=image-lang translate=no><option value=ja>Japanese</option></select>
<section id=templates></section><p id=dynamic></p></main><script type=module>
import {createUiLanguageController} from '/shared/ui-language.js';
import {uiTemplate} from '/shared/ui-template.js';
window.actions=0;document.querySelector('#ai').onclick=()=>++actions;
document.querySelector('#templates').append(
 uiTemplate('Valid for {months} months after credits are issued.',{months:'17'}),
 uiTemplate('{credits} TP added to your account.',{credits:'499,040'}),
 uiTemplate('Selected package · {package}',{package:'PRIVATE_PACKAGE_DO_NOT_SEND'}),
 uiTemplate('Support: {contact}',{contact:'private-customer@example.test'}));
const listeners=new Set();const read=()=>JSON.parse(localStorage.getItem('ui-qa-store')||'{}');
window.cacheKey='uiTranslationCacheV2';
window.chrome={storage:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}};
window.makeController=async()=>{window.__TP_UI_LANGUAGE?.dispose();window.__TP_UI_LANGUAGE=createUiLanguageController({host:document.querySelector('#host'),storage:{
 get:async()=>read(),set:async patch=>{const old=read();localStorage.setItem('ui-qa-store',JSON.stringify({...old,...patch}));
 for(const listener of listeners)listener(Object.fromEntries(Object.entries(patch).map(([key,newValue])=>[key,{oldValue:old[key],newValue}])),'local');}}});
 await __TP_UI_LANGUAGE.ready;};
window.eraseCache=()=>{const store=read();delete store[cacheKey];localStorage.setItem('ui-qa-store',JSON.stringify(store));};
window.ready=false;await makeController();window.ready=true;
</script></body></html>'''


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/fixture':
            raw = HTML.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html;charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        else:
            super().do_GET()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT/'src')))
threading.Thread(target=server.serve_forever, daemon=True).start()
requests, checks, errors = [], [], []
mode = 'normal'
words = {
    'th': {'Text output': 'ข้อความที่แสดง', 'Target language': 'ภาษาเป้าหมาย'},
    'ja': {'Text output': '表示するテキスト', 'Target language': '翻訳先の言語'},
    'es': {'Text output': 'Texto mostrado'},
}


def line_translation(line, language):
    markers = re.findall(r'ZXQ[A-Z]+QXZ', line)
    if language == 'en':
        return line
    if line in words.get(language, {}):
        return words[language][line]
    if line.endswith(' settings') and len(markers) == 1:
        return ('ตั้งค่า ' if language == 'th' else '設定：') + markers[0]
    if line.endswith(' translation') and len(markers) == 1:
        return ('แปลด้วย ' if language == 'th' else '翻訳：') + markers[0]
    if line.endswith('months after credits are issued.'):
        return (f'เครดิตใช้ได้ {markers[0]} เดือนนับจากวันที่ได้รับ' if language == 'th'
                else f'クレジット発行から{markers[0]}か月有効です。')
    if line.endswith('added to your account.'):
        return (f'เพิ่ม {markers[0]} {markers[1]} เข้าบัญชีแล้ว' if language == 'th'
                else f'アカウントに{markers[0]} {markers[1]}を追加しました。')
    if line.startswith('Selected package · '):
        return ('แพ็กเกจที่เลือก · ' if language == 'th' else '選択したパッケージ：') + markers[0]
    if line.startswith('Support: '):
        return ('ติดต่อ: ' if language == 'th' else 'お問い合わせ：') + markers[0]
    if line.endswith('-digit code'):
        return markers[0] + (' หลัก' if language == 'th' else '桁のコード')
    return line


def fixture(route):
    query = parse_qs(urlsplit(route.request.url).query)
    text, language = query['q'][0], query['tl'][0]
    requests.append({'language': language, 'text': text, 'headers': route.request.headers})
    if mode == 'unavailable':
        return route.fulfill(status=503, body='[]')
    lines = [line_translation(line, language) for line in text.split('\n')]
    translated = '\n'.join(lines)
    if mode == 'merged' and len(lines) > 1:
        translated = ' '.join(lines)
    elif mode == 'lost-marker':
        # Every line loses one identifier (lines are validated one by one, and
        # the batch also carries other UI strings, so losing only the first
        # marker of the whole batch would hit an unrelated line).
        translated = '\n'.join(re.sub(r'ZXQ[A-Z]+QXZ', '', line, count=1) for line in translated.split('\n'))
    elif mode == 'duplicate-marker' and (marker := re.search(r'ZXQ[A-Z]+QXZ', translated)):
        translated += ' ' + marker[0]
    elif mode == 'one-lost-marker':
        translated = '\n'.join(re.sub(r'ZXQ[A-Z]+QXZ', '', line, count=1) if source.endswith(' settings') else line
                               for source, line in zip(text.split('\n'), lines))
    route.fulfill(status=200, content_type='application/json', body=json.dumps([[[translated, text]]], ensure_ascii=False))


def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS ' + name, flush=True)


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=chromium_executable(), headless=True)
        page = browser.new_page(viewport={'width': 700, 'height': 820})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://translate.googleapis.com/**', fixture)
        page.goto(f'http://127.0.0.1:{server.server_port}/fixture')
        page.wait_for_function('window.ready')

        def select(language, state='ready'):
            page.evaluate('(language)=>__TP_UI_LANGUAGE.select(language)', language)
            page.wait_for_function('(state)=>document.querySelector(".tp-ui-language").dataset.state===state', arg=state)

        check('Original UI makes no translation request', not requests)
        select('th')
        check('AI settings and text output have reviewed Thai fixture meanings', page.locator('#ai').inner_text() == 'ตั้งค่า AI' and page.locator('#output').inner_text() == 'ข้อความที่แสดง')
        check('The AI source retains AI without the old Ai ambiguity', page.locator('#engine').inner_text() == 'แปลด้วย AI')
        check('Digit-leading OTP instructions translate while preserving the exact digit count', page.locator('#otp').inner_text() == '6 หลัก')
        check('Mode and provider identifiers remain unchanged in sentences', page.locator('#payment').inner_text() == 'Paid · TextPhantom credits' and 'Google Lens' in page.locator('#lens').inner_text())
        check('A complete validity sentence restores only the local months value', page.locator('[data-tp-ui-template]').nth(0).inner_text() == 'เครดิตใช้ได้ 17 เดือนนับจากวันที่ได้รับ')
        check('A complete credit sentence retains the exact private amount', page.locator('[data-tp-ui-template]').nth(1).inner_text() == 'เพิ่ม 499,040 TP เข้าบัญชีแล้ว')
        page.locator('#ai').click()
        check('Translated controls retain their business handler', page.evaluate('actions') == 1)
        check('Inputs, prompt, private copy and image language remain unchanged', page.locator('#key').input_value() == 'PRIVATE_KEY_DO_NOT_SEND' and page.locator('#prompt').input_value() == 'PRIVATE_PROMPT_DO_NOT_SEND' and page.locator('#private').inner_text() == 'AI settings' and page.locator('#image-lang').input_value() == 'ja')
        before = len(requests)
        mode = 'unavailable'
        page.reload()
        page.wait_for_function('window.ready')
        check('Reopening a translated surface uses persistent cache while Google is unavailable', len(requests) == before and page.locator('#ai').inner_text() == 'ตั้งค่า AI')
        mode = 'normal'
        select('en')
        check('Explicit English keeps canonical copy and complete values', page.locator('#ai').inner_text() == 'AI settings' and page.locator('[data-tp-ui-template]').nth(1).inner_text() == '499,040 TP added to your account.')
        select('ja')
        check('Japanese fixture translates UI while retaining the AI identifier', page.locator('#ai').inner_text() == '設定：AI' and page.locator('#output').inner_text() == '表示するテキスト')
        check('Japanese template reorders words without changing private values', page.locator('[data-tp-ui-template]').nth(1).inner_text() == 'アカウントに499,040 TPを追加しました。')
        select('')
        check('Original selection restores complete English templates with local values', page.locator('[data-tp-ui-template]').nth(0).inner_text() == 'Valid for 17 months after credits are issued.')
        mode = 'merged'
        select('fr')
        check('Merged provider lines are retried as separate complete phrases', any('\n' in row['text'] and row['language'] == 'fr' for row in requests) and page.locator('#output').inner_text() == 'Text output')
        mode = 'lost-marker'
        select('ko', 'error')
        check('Lost identifiers show failure and keep local values unchanged', page.locator('#ai').inner_text() == 'AI settings' and page.locator('[data-tp-ui-value=credits]').inner_text() == '499,040')
        mode = 'duplicate-marker'
        select('vi', 'error')
        check('Duplicated identifiers cannot corrupt the affected mode or local amounts', page.locator('#payment').inner_text() == 'Paid · TextPhantom credits' and page.locator('[data-tp-ui-value=credits]').inner_text() == '499,040')
        mode = 'one-lost-marker'
        select('es', 'error')
        check('One malformed line keeps its original label while valid sibling controls translate', page.locator('#ai').inner_text() == 'AI settings' and page.locator('#output').inner_text() == 'Texto mostrado')
        mode = 'normal'
        select('th')
        page.evaluate('document.querySelector("[data-tp-ui-value=credits]").textContent="498,999"')
        select('')
        check('Switching language restores the latest locally updated credit value', page.locator('[data-tp-ui-template]').nth(1).inner_text() == '498,999 TP added to your account.')
        select('th')
        check('Switching back reuses public translation with the latest private value', page.locator('[data-tp-ui-template]').nth(1).inner_text() == 'เพิ่ม 498,999 TP เข้าบัญชีแล้ว')
        page.screenshot(path=str(OUT/'templates-th.png'), full_page=True)
        select('ja')
        page.screenshot(path=str(OUT/'templates-ja.png'), full_page=True)
        text = '\n'.join(row['text'] for row in requests)
        check('Requests never contain any runtime private values', all(value not in text for value in ['17', '499,040', '498,999', 'PRIVATE_', 'private-customer@example.test']))
        check('Requests contain no authorization or cookies', all('authorization' not in row['headers'] and 'cookie' not in row['headers'] for row in requests))
        saved = page.evaluate('JSON.parse(localStorage.getItem("ui-qa-store"))[cacheKey]')
        saved_text = json.dumps(saved, ensure_ascii=False)
        check('Persistent translations contain templates and never runtime private values', all(value not in saved_text for value in ['17', '499,040', '498,999', 'PRIVATE_', 'private-customer@example.test']))
        page.evaluate('''()=>{const saved=JSON.parse(localStorage.getItem('ui-qa-store'));saved.uiLanguageV1='th';saved[cacheKey]={version:2,entries:[['th\\0interface:main:button\\0AI settings','อ้าย']]};localStorage.setItem('ui-qa-store',JSON.stringify(saved));}''')
        before = len(requests)
        page.reload(); page.wait_for_function('window.ready')
        check('A corrupted cached term is rejected and translated again', len(requests) > before and page.locator('#ai').inner_text() == 'ตั้งค่า AI')
        check('No script exceptions', not errors)
        browser.close()
finally:
    server.shutdown()
    (OUT/'result.json').write_text(json.dumps({'scope': __doc__, 'passed': len(checks), 'checks': checks, 'errors': errors, 'requests': requests}, ensure_ascii=False, indent=2))
